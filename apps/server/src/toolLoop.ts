/**
 * 第 21 步 · **网页工具循环**（脑在服务端，手在桌面）。
 *
 * 循环长什么样（本文件就是它）：
 *
 *   用户下任务
 *     → 服务端把「目标 + 当前这张页」交给 DeepSeek，用 **function call** 选工具
 *     → 桌面在**当前智能体**那张 webview 上执行（apps/desktop/src/browser/ 那一套）
 *     → 结果（URL、读页摘要、点没点到）回执给服务端，追加成 tool 消息
 *     → 再选下一步 …… 直到 stop，或用户叫停，或步数到上限。
 *
 * 为什么循环写在服务端而不是桌面：
 *   1. 消息历史（assistant.tool_calls + tool 回执）只有连续地放在一处，模型才看得见「我做过什么」；
 *   2. 步数上限、prompt、工具表**只有一份** —— 桌面不再自己决定下一步，也不再有第二套 JSON 动作话术；
 *   3. 用户中途发一句闲聊时，循环仍然活着（它挂在服务端的会话里，不随那次聊天请求结束）。
 *
 * 工具**只有这 6 个**（和说明书一致，不多不少）：
 *   open_url / read_page / click / type / scroll / stop
 *
 * 硬规矩（改这里之前先读）：
 *   - 浏览器**看得见**：不无头、不 Playwright/Puppeteer、不套 Edge/Chrome；执行一律走本地 driver；
 *   - 工具只落在**当前智能体那一套 partition**：会话里记着 agentId 与 wcId，
 *     /agent/loop/next 每次都要对上，对不上直接 409，绝不把动作打到别的 bot 的页上；
 *   - **步数上限写配置**（env.AGENT_LOOP_MAX_STEPS，默认 10，8~12），到顶就停下来问用户，不空转烧 token；
 *   - 闲聊 / 问知识库 / 问「你是谁」**根本不会走到这里**（桌面不会为它们建循环，聊天轮也不带工具表）；
 *   - 敏感字段（密码/验证码/支付/身份证）服务端先挡成「请你自己在卡片里输」，
 *     执行层 driver.ts 还有第二道闸（typeSensitiveGuard）——两道都不代填；
 *   - 不做：整页换皮、插件、向量库、第二套点页引擎、重启恢复 tab。
 */
import type {
  AgentLoopDecision,
  BrowserAction,
  LoopToolCall,
  LoopToolName,
  LoopToolResult,
  PageSnapshot,
} from '@ai-workbench/shared';
import type { ServerEnv } from './env';
import { llmFetch, type LlmMessage, type LlmToolCall } from './llm';
import { mentionsLogin } from './promptPolicy';
import {
  bindPageLoop,
  pageStateOf,
  patchPageState,
  summaryFromSnapshot,
  type PageStatePatch,
} from './pageState';

/** 会话状态里要喂给循环的几行（字段名与 conversations 表一致，取自 sessionState） */
export interface LoopStateBrief {
  current_task: string;
  browser_confirmed: boolean;
  login_required: boolean;
  already_told_user_login_themselves: boolean;
  last_page_summary: string;
}

// ---------------------------------------------------------------------------
// 工具表：这 6 个就是全部（OpenAI 兼容的 function 定义，上游原样吃）
// ---------------------------------------------------------------------------

export const LOOP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        '在工作台浏览器里打开一个 http(s) 网址。只在需要换站点、或当前页明显不是目标站点时用；' +
        '只是要在当前页面上搜/读/点，就不要换页。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的完整地址，必须以 http:// 或 https:// 开头' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: '读当前这张页的地址、标题、可见按钮 / 链接 / 输入框，用来确认页面上到底有什么。信息不够时先读一次再决定。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: '点击当前页面上一个可见元素。target 写元素上的文字（按钮/链接文字），例如「百度一下」。',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: '要点的按钮或链接上的文字' } },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description:
        '往当前页面上的一个输入框里输入文字（打到网页自己的框里，不是聊天框）。' +
        'submit=true 表示输完直接回车提交。目标里有「搜索/查/找」时，必须真的用这个工具把关键词打进搜索框并提交。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '输入框的描述（placeholder / 名称，例如「搜索框」）' },
          text: { type: 'string', description: '真正要输入的文字' },
          submit: { type: 'boolean', description: '输完是否回车提交，默认 false' },
        },
        required: ['target', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: '在当前页面上向下/向上滚动一屏（内容没露出来时用）。',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' } },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop',
      description:
        '结束这一轮循环。reason=done 表示用户要的结果已经在页面上（summary 写结论）；' +
        'reason=need_user 表示你被卡住了（question 写你要用户做什么，例如自己登录 / 自己输验证码）；' +
        'reason=blocked 表示页面上根本做不了（question 写原因和一条替代路）。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['done', 'need_user', 'blocked'] },
          summary: { type: 'string', description: 'reason=done 时的结论（给聊天窗口看，短、可扫读）' },
          question: { type: 'string', description: 'reason=need_user/blocked 时，问用户的一句话' },
          document_title: { type: 'string', description: '可选：结论文档的标题' },
          document_outline: { type: 'array', items: { type: 'string' }, description: '可选：要点提纲（最多 12 条）' },
        },
        required: ['reason'],
      },
    },
  },
] as const;

/**
 * 循环的系统提示词。**只放服务端**，而且是第 16 步那套原则（最新指令优先、确认是例外、
 * 失败给原因+一步）在「动手」这件事上的唯一一份话术 —— 桌面不再维护第二套。
 */
export const LOOP_SYSTEM_PROMPT = [
  '你是工作台浏览器的驾驶员。用户能看见工作台里那张真实网页，也可以随时自己上手、随时喊停。',
  '你通过工具动手：一次只调**一个**工具，不要一次规划十步，也不要在文字里假装已经做过。',
  '**一律用简体中文说话**（包括每一次的工具说明与结论），不要用英文回答。',
  '',
  '基本规矩：',
  '1. 只能操作**当前这一张**页（下面给了它的地址）。要换站点才用 open_url；目标说的是「在这个页面搜一下 / 读一下当前页 / 往下滚 / 点某处」时，绝不换站点。',
  '2. 页面上信息不够就先 read_page，禁止凭想象编造按钮。',
  '3. 目标里含「搜索 / 搜一下 / 查 / 找 X」时：必须真的用 type 把关键词打进**搜索框**并提交（或点搜索按钮），页面跳到结果页才算完成。**只打开了首页不算完成**。',
  '4. 挑输入框要挑对：页面上的「AI 对话 / 智能助手 / 客服」输入框**不是**搜索框。拿不准就先 read_page，看清楚哪个框才对应「搜索」这件事，再 type。',
  '5. 同一个动作失败两次，不要第三次盲试：换成 stop(reason=need_user) 或 stop(reason=blocked)，说清你看见了什么。',
  '6. 动作失败时给**原因 + 一个明确的下一步**（页面没加载完 / 被弹窗挡住 / 需要先登录 / 元素不在视口内 / 这颗按钮只是唤起手机 App）。',
  '7. **禁止**回退成「你是否确认打开某某网站」「要我操作浏览器吗」这类整段重确认 —— 用户已经同意用浏览器了，直接做。',
  '8. **禁止**把「原任务是 X、最新指令是 Y，你要哪个」抛给用户：以最新指令为准，旧目标作废。',
  '9. 密码、验证码/短信码、支付、身份证这类敏感项：**绝不代填、也绝不索要它的值**，用 stop(reason=need_user) 请用户直接在网页里输入；删除/发送/授权这类不可逆动作同样交给用户。',
  '10. 不改浏览器设置、不下安装包、不关用户的标签页、不绕过验证码、不攻击网站。',
  '11. 用户说「停」时立刻收手：不要调任何动作工具。',
  '12. 只在「用户要的最终结果已经出现在当前页面上」时用 stop(reason=done)；没做完不要 done，也不要拿 done 代替提问。',
  '13. 被卡住（要登录 / 遇到验证码 / 页面没有可用入口 / 缺必要资料）用 stop(reason=need_user)，问「这一步该怎么走」，不要问「选哪个目标」。',
  '',
  '动作与描述：',
  '- target 要用页面快照里**真实出现过**的文字，不要自己编。',
  '- type 必须同时给出 target 和 text；不知道要输什么就问用户，禁止给 text 为空的 type。',
  '- 当前页快照会随每次工具回执更新；决策只依据**最新**那份，不要假设还在旧页面。',
  '',
  '收尾：一轮最多走若干步（下面会告诉你上限）。做完了就用 stop(reason=done) 收尾并给出结论；',
  '被卡住就用 stop(reason=need_user/blocked)。不要为了多走几步而空转。',
  '（再强调一次：每一步的说明与最终结论都用简体中文写，不要用英文。）',
].join('\n');

// ---------------------------------------------------------------------------
// 会话状态（在内存里；进程重启即丢——本步明确不做「重启恢复」）
// ---------------------------------------------------------------------------

export type LoopStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'failed';

export interface LoopSession {
  id: string;
  userId: number;
  /** 这一路属于哪个智能体（工具只允许落在它的 partition 上） */
  agentId: number | null;
  conversationId: number | null;
  /** 这一路操作哪一张内嵌页（guest webContents id，桌面报上来的） */
  wcId: number | null;
  goal: string;
  messages: LlmMessage[];
  /** 已经执行过的工具步数 */
  step: number;
  maxSteps: number;
  status: LoopStatus;
  /** 最近一次页面快照（服务端只留摘要，不留整页 HTML） */
  lastSnapshot: PageSnapshot | null;
  /** 上一个工具的调用 id（tool 回执要对应它） */
  pendingCallId: string | null;
  /** 已经用过的工具名（诊断用，也用来证明「闲聊轮没有开页工具」） */
  usedTools: LoopToolName[];
  /**
   * 子阶段 A · **推进锁**（重入保护）。
   *
   * 同一条循环同一时刻只允许一次 `advance()` 在跑。没有这道锁时，桌面把同一次 `next`
   * 发了两次（重试 / 双击 / 两路都带上了同一个 loopId）就会两条 `advance` 交错往
   * `session.messages` 里追加 assistant/tool 消息、各自读同一个 `pendingCallId` 与 `step`，
   * 结果是历史里出现对不上的 tool_call_id、步数被记两次 —— 模型从此看到一段自相矛盾的对话。
   * 现在第二次调用**当场抛 LoopBusyError**（路由映射成 409），不排队、不静默。
   */
  advancing: boolean;
  createdAt: number;
  touchedAt: number;
}

/** 同时在跑的循环上限（防止内存被刷爆）；超过就先回收最旧的 */
const MAX_LIVE_LOOPS = 32;
/** 一个循环闲置这么久就回收（10 分钟） */
const LOOP_TTL_MS = 10 * 60 * 1000;

const loops = new Map<string, LoopSession>();

let seq = 0;
function nextLoopId(): string {
  seq += 1;
  return `loop_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, s] of loops) {
    if (now - s.touchedAt > LOOP_TTL_MS) loops.delete(id);
  }
  if (loops.size <= MAX_LIVE_LOOPS) return;
  const oldest = [...loops.values()].sort((a, b) => a.touchedAt - b.touchedAt);
  for (const s of oldest.slice(0, loops.size - MAX_LIVE_LOOPS)) loops.delete(s.id);
}

export function getLoop(loopId: string): LoopSession | null {
  const s = loops.get(loopId);
  if (!s) return null;
  if (Date.now() - s.touchedAt > LOOP_TTL_MS) {
    loops.delete(loopId);
    return null;
  }
  return s;
}

/**
 * 现在**还在跑**的循环数（/health 暴露它）。
 * 只算 running：停在 ask / done / stopped 上的那几路不算「活着」——
 * 它们不再调模型，等用户下一步才新起一轮。
 */
export function liveLoopCount(): number {
  sweep();
  let n = 0;
  for (const s of loops.values()) if (s.status === 'running') n += 1;
  return n;
}

export interface StartLoopInput {
  userId: number;
  agentId: number | null;
  conversationId: number | null;
  wcId: number | null;
  goal: string;
  pageUrl?: string;
  state?: LoopStateBrief | null;
}

/** 建一个循环（只有 /chat/stream 的任务轮与主进程兜底会调它） */
export function startLoop(env: ServerEnv, input: StartLoopInput): LoopSession {
  sweep();
  /**
   * 子阶段 A：循环要用的「本会话状态」**按 wcId 分片取**，不再直接读 conversations
   * （调用方传进来的 `state` 只当**首次**用到这张页时的种子）。
   * 这样同一个智能体的两路任务各读各的，谁也覆盖不了谁。
   */
  const brief = resolveLoopBrief(input);
  const session: LoopSession = {
    id: nextLoopId(),
    userId: input.userId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    wcId: input.wcId,
    goal: input.goal.slice(0, 500),
    messages: [
      { role: 'system', content: LOOP_SYSTEM_PROMPT },
      { role: 'user', content: firstUserMessage(input, env.agentLoopMaxSteps, brief) },
    ],
    step: 0,
    maxSteps: env.agentLoopMaxSteps,
    status: 'running',
    lastSnapshot: null,
    pendingCallId: null,
    usedTools: [],
    advancing: false,
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
  // 把「这一路在服务端的循环号」记在页上（同一套 id，方便诊断与将来做「按页停」）
  const wcId = Number(input.wcId);
  if (Number.isInteger(wcId)) bindPageLoop(wcId, session.id, input.userId, input.agentId);
  loops.set(session.id, session);
  return session;
}

/**
 * 这一路要用的状态：**页级优先，会话级只当种子**。
 *
 * 没有 wcId（老的单步路径 / 没有页的循环）时退回原来的会话级 brief，行为不变。
 */
function resolveLoopBrief(input: StartLoopInput): LoopStateBrief | null {
  const wcId = Number(input.wcId);
  if (!Number.isInteger(wcId)) return input.state ?? null;
  const seed: PageStatePatch | null = input.state
    ? {
        current_task: input.state.current_task,
        browser_confirmed: input.state.browser_confirmed,
        login_required: input.state.login_required,
        already_told_user_login_themselves: input.state.already_told_user_login_themselves,
        last_page_summary: input.state.last_page_summary,
      }
    : null;
  const st = pageStateOf(wcId, { userId: input.userId, agentId: input.agentId, seed });
  return {
    current_task: st.current_task,
    browser_confirmed: st.browser_confirmed,
    login_required: st.login_required,
    already_told_user_login_themselves: st.already_told_user_login_themselves,
    last_page_summary: st.last_page_summary,
  };
}

/** 第一轮的用户消息：目标 + 当前这张页 + 会话状态要点 + 步数上限 */
function firstUserMessage(input: StartLoopInput, maxSteps: number, brief: LoopStateBrief | null): string {
  const s = brief ?? undefined;
  const lines = [
    `任务目标：${input.goal}`,
    `当前这张页：${input.pageUrl || '（还没打开，需要时用 open_url）'}`,
    `一轮最多走 ${maxSteps} 步（超过就停下来问用户）。`,
    s
      ? [
          '本会话状态（服务端维护，比任何长期记忆都新）：',
          `- 本会话是否已确认用浏览器：${s.browser_confirmed ? '是（直接做，不要再问）' : '否'}`,
          s.current_task ? `- 当前任务：${s.current_task}` : '',
          s.last_page_summary ? `- 最后一页摘要：${s.last_page_summary}` : '',
          s.login_required ? '- 用户可能需要自己在网页里登录' : '',
          s.already_told_user_login_themselves
            ? '- 登录安全提示本会话已经说过一次，不要再重复「账号密码验证码你自己输」这类话'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    '请选下一步要调用的工具（一次一个）。',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/** 「停」：用户喊停 / 任务被新指令顶掉 / 登出 —— 之后 advance 一律回 stopped，不再调模型 */
export function stopLoop(loopId: string, reason = 'user_stop'): boolean {
  const s = getLoop(loopId);
  if (!s) return false;
  s.status = 'stopped';
  s.touchedAt = Date.now();
  if (s.messages.length > 0) {
    s.messages.push({ role: 'user', content: `（用户叫停：${reason}。不要再调任何动作工具。）` });
  }
  return true;
}

/** 按「哪张页」停：桌面放下某一路时用它 */
export function stopLoopsOfPage(userId: number, wcId: number): number {
  let n = 0;
  for (const s of loops.values()) {
    if (s.userId === userId && s.wcId === wcId && s.status === 'running') {
      s.status = 'stopped';
      s.touchedAt = Date.now();
      n += 1;
    }
  }
  return n;
}

export function stopLoopsOfUser(userId: number): number {
  let n = 0;
  for (const s of loops.values()) {
    if (s.userId === userId && s.status === 'running') {
      s.status = 'stopped';
      s.touchedAt = Date.now();
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 页面快照 → 人话（模型与用户看到的都是这个，不是整页 HTML）
// ---------------------------------------------------------------------------

/** 快照描述：把「像不像登录页 / 有没有遮挡」说清楚，失败原因才写得准 */
export function snapshotBrief(s: PageSnapshot): string {
  const list = (a: string[] | undefined, n: number): string => (a && a.length ? a.slice(0, n).join(' | ') : '（无）');
  return [
    `url: ${s.url}`,
    `title: ${s.title}`,
    `页面性质: ${s.loginLike ? '像登录页（需要用户自己在网页里登录）' : '普通页面'}${s.overlay ? '；检测到疑似弹窗/遮罩，可能挡住按钮' : ''}`,
    `可见按钮: ${list(s.buttons, 24)}`,
    `可见链接: ${list(s.links, 16)}`,
    `可见输入框: ${list(s.inputs, 12)}`,
    // 第 21 步：正文片段。搜索结果 / 文章 / 列表页只有按钮和链接时，
    // 模型会以为「页面是空的」，「整理成列表」这类任务就做不了。
    `页面可见正文（片段，最多 40 条）: ${list(s.texts, 40)}`,
    ...(s.inputFields?.length
      ? [
          `字段分类（敏感的一律不代填）: ${s.inputFields
            .map((f) => `${f.kind === 'sensitive' ? '敏感·' + f.reason : '普通'}[${f.label}]`)
            .slice(0, 12)
            .join(' ; ')}`,
        ]
      : []),
  ].join('\n');
}

/** 桌面回执 → 塞回模型的 tool 消息（短、只有人话摘要） */
export function describeToolResult(call: LoopToolCall, r: LoopToolResult): string {
  const head = `工具 ${call.name} 回执：${r.ok ? '成功' : '失败'}`;
  const bits: string[] = [];
  if (r.detail) bits.push(r.detail.slice(0, 400));
  if (r.error) bits.push(`失败原因：${r.error.slice(0, 400)}`);
  if (r.refused) bits.push(`本机安全闸拦下：${r.refused.slice(0, 300)}`);
  if (r.noChange) bits.push('动作执行了，但页面看不出任何变化（地址/标题/节点数都没动）——多半没点中、被弹层挡住，或这颗按钮只是唤起手机 App');
  if (r.userAnswer) bits.push(`用户补了一句：${r.userAnswer.slice(0, 300)}`);
  const page = r.page ? `\n执行后的当前页：\n${snapshotBrief(r.page)}` : '';
  return [head, ...bits].join('\n') + page;
}

// ---------------------------------------------------------------------------
// 参数校验：模型吐出来的东西一律先过这里，脏动作绝不下发
// ---------------------------------------------------------------------------

const ALLOWED = new Set<string>(['open_url', 'read_page', 'click', 'type', 'scroll', 'stop']);

/** 支付/收银的最终确认永远由用户点（第 9 步硬规矩） */
const PAYMENT_TARGET_RE = /(立即支付|确认支付|确认付款|去支付|去付款|提交订单|确认订单|pay\s*now|checkout|place\s*order)/i;
/** 敏感字段：命中就不代填，转成「请你自己在卡片里输」 */
const SENSITIVE_TARGET_RE =
  /(密码|password|验证码|校验码|动态口令|短信码|otp|captcha|verification\s*code|支付|付款|银行卡|卡号|cvv|身份证)/i;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 命中的敏感字段描述（快照里标过敏感的框，或文案本身像敏感字段） */
function sensitiveHit(snapshot: PageSnapshot | null, target: string): string {
  const t = target.trim().toLowerCase();
  if (!t) return '';
  for (const f of snapshot?.inputFields ?? []) {
    if (f.kind !== 'sensitive') continue;
    const lab = f.label.toLowerCase().replace(/^\[敏感·[^\]]*\]\s*/, '');
    if (lab && !lab.includes('无标识') && (t.includes(lab.slice(0, 20)) || lab.includes(t))) return f.label;
  }
  return SENSITIVE_TARGET_RE.test(t) ? target : '';
}

export type SanitizeOutcome =
  | { ok: true; call: LoopToolCall }
  | { ok: false; reason: string; question: string };

/** 把上游给的 tool_call 归一成可下发的工具调用；不合法就换成一句人话提问 */
export function sanitizeToolCall(raw: LlmToolCall, snapshot: PageSnapshot | null): SanitizeOutcome {
  const name = typeof raw?.function?.name === 'string' ? raw.function.name : '';
  if (!ALLOWED.has(name)) {
    return { ok: false, reason: 'bad_action', question: `模型想调一个不存在的工具「${name || '(空)'}」，我没有执行任何动作。告诉我下一步就行。` };
  }
  let args: Record<string, unknown> = {};
  try {
    const parsed = raw.function.arguments ? JSON.parse(raw.function.arguments) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'bad_args', question: '模型这一步给的参数不是合法 JSON，我没有执行任何动作。告诉我下一步就行。' };
  }
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `call_${Date.now()}`;

  switch (name) {
    case 'open_url': {
      const url = str(args.url, 500);
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, reason: 'bad_url', question: '要打开的网址不合法（需要 http(s):// 开头）。请确认目标站点。' };
      }
      return { ok: true, call: { id, name: 'open_url', args: { url } } };
    }
    case 'read_page':
      return { ok: true, call: { id, name: 'read_page', args: {} } };
    case 'click': {
      const target = str(args.target, 160);
      if (!target) return { ok: false, reason: 'bad_target', question: '要点的东西没写清楚。页面上你想让我点哪个？' };
      if (PAYMENT_TARGET_RE.test(target)) {
        return {
          ok: false,
          reason: 'payment_confirm',
          question: '支付/收银的最终确认必须由你自己点，我不代点。你在卡片里确认后告诉我结果就行。',
        };
      }
      return { ok: true, call: { id, name: 'click', args: { target } } };
    }
    case 'type': {
      const target = str(args.target, 160);
      const text = typeof args.text === 'string' ? args.text.slice(0, 500) : '';
      if (!target || !text) return { ok: false, reason: 'bad_target', question: '输入框或要输入的内容没写清楚，请告诉我往哪个框里输什么。' };
      const sens = sensitiveHit(snapshot, target);
      if (sens) {
        return {
          ok: false,
          reason: 'sensitive_field',
          question: `这一步要往「${sens.slice(0, 40)}」里输入，这类敏感内容必须由你自己在网页卡片里打——我不代填、也不会留存。输完点「继续」，我接着做。`,
        };
      }
      return { ok: true, call: { id, name: 'type', args: { target, text, submit: Boolean(args.submit) } } };
    }
    case 'scroll':
      return { ok: true, call: { id, name: 'scroll', args: { direction: args.direction === 'up' ? 'up' : 'down' } } };
    case 'stop': {
      const reason = str(args.reason, 20) || 'done';
      const summary = str(args.summary, 500);
      const question = str(args.question, 500);
      const outline = Array.isArray(args.document_outline)
        ? (args.document_outline as unknown[]).slice(0, 12).map((x) => String(x).slice(0, 120))
        : [];
      return {
        ok: true,
        call: {
          id,
          name: 'stop',
          args: {
            reason,
            summary,
            question,
            document_title: str(args.document_title, 120),
            document_outline: outline,
          },
        },
      };
    }
    default:
      return { ok: false, reason: 'bad_action', question: '这个动作不在本步能力里，请换条路。' };
  }
}

// ---------------------------------------------------------------------------
// 循环推进
// ---------------------------------------------------------------------------

/** 上游返回体里我们真正用到的部分 */
interface UpstreamChoice {
  message?: {
    content?: string | null;
    tool_calls?: LlmToolCall[] | null;
  };
}

async function askModel(env: ServerEnv, session: LoopSession, tag: string): Promise<{ ok: true; message: NonNullable<UpstreamChoice['message']> } | { ok: false; status: number; brief: string }> {
  const r = await llmFetch(env, session.messages, {
    tag,
    temperature: 0.2,
    timeoutMs: 90_000,
    tools: LOOP_TOOLS as unknown as unknown[],
    toolChoice: 'auto',
  });
  if (!r.ok) {
    const brief = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    console.error('[loop] 上游 HTTP', r.status, brief);
    return { ok: false, status: r.status, brief };
  }
  const data = (await r.json()) as { choices?: UpstreamChoice[] };
  const message = data.choices?.[0]?.message;
  if (!message) return { ok: false, status: 502, brief: '上游没有返回 message' };
  return { ok: true, message };
}

/**
 * 子阶段 A · 同一条循环被**并发推进**时抛这个。
 *
 * 路由层把它映射成 **409**（不是 500）：这是调用方用错了（同一次 next 发了两次），
 * 不是服务端故障。错误话术要能让人立刻知道「被拒了、什么都没发生、下一步怎么办」。
 */
export class LoopBusyError extends Error {
  readonly code = 'loop_busy';
  readonly loopId: string;
  constructor(loopId: string) {
    super(
      `循环 ${loopId} 正在推进中（上一次 /agent/loop/next 还没返回），本次调用被拒绝：` +
        '没有执行任何动作，也没有改动它的状态。等它返回后再调。',
    );
    this.name = 'LoopBusyError';
    this.loopId = loopId;
  }
}

/**
 * 推进一格：**带重入保护**。
 *
 *   - 同一条循环已经有一次 advance 在跑 → 当场抛 `LoopBusyError`（明确拒绝，不排队、不静默）；
 *   - 否则置锁 → 跑真正的推进（advanceInner）→ **把结果写回按 wcId 分片的状态** → 放锁。
 *
 * 锁放在 `session` 上（`advancing`），所以粒度天然就是**一个 loopId 一把**：
 * 两条不同的循环（两张页）互不影响，各自可以同时在推进。
 */
export async function advance(env: ServerEnv, session: LoopSession, result?: LoopToolResult | null): Promise<AgentLoopDecision> {
  if (session.advancing) throw new LoopBusyError(session.id);
  session.advancing = true;
  try {
    const decision = await advanceInner(env, session, result);
    // 子阶段 A：每一步的推进结果落回**这张页自己**的状态（原来循环根本不写，last_page_summary
    // 永远是会话级那一个值，两个任务共用）。写失败不能影响决策本身。
    try {
      syncPageState(session, result ?? null, decision);
    } catch (err) {
      console.error('[loop] 写分片状态失败（不影响这一步的决策）：', (err as Error)?.message ?? String(err));
    }
    return decision;
  } finally {
    session.advancing = false;
  }
}

/**
 * 把这一步的推进结果写进**这张页**的分片状态（子阶段 A 改造点 2 的写入口）。
 *
 * 只写「任务态」：current_task / latest_user_intent / last_page_summary / login_required /
 * sensitive_action / browser_confirmed / already_told_user_login_themselves。
 * **不写 keepalive**（那是智能体级的，见 pageState.ts 的说明）。
 */
function syncPageState(session: LoopSession, result: LoopToolResult | null, decision: AgentLoopDecision): void {
  const wcId = Number(session.wcId);
  if (!Number.isInteger(wcId)) return; // 没有页维度的循环（老的单步适配器）不写分片
  const snap = session.lastSnapshot;
  const patch: PageStatePatch = {
    // 这一路的任务目标就是这张页的 current_task（两路并行时各是各的，不再互相覆盖）
    current_task: session.goal,
    browser_confirmed: true, // 循环真的在动手了 → 这张页确实在用浏览器
    // 敏感/不可逆按**本轮**算，不粘住：这一步没触发就写 false（与 applyUserMessage 同一套语义）
    sensitive_action: decision.kind === 'ask' && decision.reason === 'sensitive_field',
    step: session.step,
  };
  const summary = summaryFromSnapshot(snap);
  if (summary) patch.last_page_summary = summary;
  if (snap) patch.login_required = Boolean(snap.loginLike);
  if (result?.userAnswer) patch.latest_user_intent = result.userAnswer;
  // 循环在让用户自己去登录（need_user + 话里提到登录）→ 记「已提醒过」，避免每轮重复长篇安全说明
  if (decision.kind === 'ask' && decision.reason === 'need_user' && mentionsLogin(decision.question)) {
    patch.already_told_user_login_themselves = true;
  }
  patchPageState(wcId, patch, { userId: session.userId, agentId: session.agentId, loopId: session.id });
}

/**
 * 推进一格（**内部实现**，外部一律走上面的 `advance`）。
 *
 *   - 传了 result（上一个工具的回执）→ 先追加 tool 消息，再问模型下一步；
 *   - 没传 result（第一步 / 用户补了一句答复）→ 直接问模型下一步。
 *
 * 返回的一定是「桌面能执行的东西」：一个工具、或一句提问 / 结论 / 说明。
 */
async function advanceInner(env: ServerEnv, session: LoopSession, result?: LoopToolResult | null): Promise<AgentLoopDecision> {
  session.touchedAt = Date.now();

  if (session.status === 'stopped') return { kind: 'stopped', reason: 'user_stop', step: session.step };
  if (session.status === 'done') return { kind: 'stopped', reason: 'done', step: session.step };

  if (result) {
    const callId = session.pendingCallId ?? `call_${session.step}`;
    const lastCall = lastToolCall(session);
    session.messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: describeToolResult(lastCall ?? { id: callId, name: 'read_page', args: {} }, result),
    });
    if (result.page) session.lastSnapshot = result.page;
    session.pendingCallId = null;
    session.step += 1;
    if (result.userAnswer) {
      session.messages.push({ role: 'user', content: `用户补了一句：${result.userAnswer.slice(0, 300)}` });
    }
  } else if (session.pendingCallId) {
    // 上一格给了工具但桌面没回执就又问了一次：把它当「没执行」，让模型重选
    session.messages.push({
      role: 'tool',
      tool_call_id: session.pendingCallId,
      content: '工具没有被执行（桌面没有回执）。请重新选下一步。',
    });
    session.pendingCallId = null;
  }

  if (session.step >= session.maxSteps) {
    session.status = 'waiting';
    return {
      kind: 'ask',
      reason: 'step_budget',
      question: `一轮最多走 ${session.maxSteps} 步，现在已经走满了还没做完，我先停下来。要我接着做就点「继续」，或者直接告诉我下一步。`,
      step: session.step,
    };
  }

  let out: Awaited<ReturnType<typeof askModel>>;
  try {
    out = await askModel(env, session, `agent/loop#${session.step + 1}`);
  } catch (err) {
    session.status = 'failed';
    return {
      kind: 'ask',
      reason: 'llm_unreachable',
      question: `问不到下一步：${(err as Error).message}。这一步我没有执行任何动作。`,
      step: session.step,
    };
  }
  if (!out.ok) {
    session.status = 'failed';
    return {
      kind: 'ask',
      reason: 'llm_http',
      question: `模型服务返回 HTTP ${out.status}：${out.brief || '（无详情）'}。这一步我没有执行任何动作。`,
      step: session.step,
    };
  }

  const message = out.message;
  const calls = (message.tool_calls ?? []).filter((c) => c && typeof c === 'object');
  const text = typeof message.content === 'string' ? message.content.trim().slice(0, 800) : '';

  if (calls.length === 0) {
    // 模型没调工具，只是说话：把话给用户，循环在这一格停住（等新指令，不空转）
    session.status = 'waiting';
    return { kind: 'say', text: text || '（模型这一步没有给出可执行动作）', step: session.step };
  }

  const first = calls[0];
  const outcome = sanitizeToolCall(first, session.lastSnapshot);
  if (!outcome.ok) {
    // 脏动作不下发；但也让模型知道它这一步被拒了（下次别再这么干）
    session.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: first.id, type: 'function', function: { name: first.function?.name ?? '', arguments: first.function?.arguments ?? '{}' } }],
    });
    session.messages.push({ role: 'tool', tool_call_id: first.id, content: `本机拒绝执行：${outcome.reason}。${outcome.question}` });
    session.status = 'waiting';
    return { kind: 'ask', reason: outcome.reason, question: outcome.question, step: session.step };
  }

  const call = outcome.call;
  // 只把**第一个**工具记进历史（其余忽略），保证 assistant.tool_calls 与 tool 回执一一对应
  session.messages.push({
    role: 'assistant',
    content: text,
    tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
  });
  session.pendingCallId = call.id;
  session.usedTools.push(call.name);

  if (call.name === 'stop') {
    session.status = 'done';
    const reason = String(call.args.reason ?? 'done');
    if (reason === 'done') {
      return {
        kind: 'done',
        summary: String(call.args.summary ?? '').trim() || '任务完成',
        document_title: String(call.args.document_title ?? '').trim() || '任务记录',
        document_outline: Array.isArray(call.args.document_outline) ? (call.args.document_outline as string[]) : [],
        step: session.step,
      };
    }
    return {
      kind: 'ask',
      reason: reason === 'blocked' ? 'blocked' : 'need_user',
      question: String(call.args.question ?? '').trim() || '我这边卡住了，你告诉我下一步怎么走？',
      step: session.step,
    };
  }

  return { kind: 'tool', call, step: session.step, ...(text ? { text } : {}) };
}

/** 历史里最后一条 assistant 的 tool_call（回执时用来对齐工具名） */
function lastToolCall(session: LoopSession): LoopToolCall | null {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const m = session.messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const c = m.tool_calls[m.tool_calls.length - 1];
    try {
      const args = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
      return { id: c.id, name: c.function.name as LoopToolName, args };
    } catch {
      return { id: c.id, name: c.function.name as LoopToolName, args: {} };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 兼容：/agent/next-action 的「一步一问」也走同一套工具与同一份提示词
// ---------------------------------------------------------------------------

export interface DecideOnceInput {
  goal: string;
  stepsSummary: string[];
  snapshot: PageSnapshot;
  paused: boolean;
  memoryBlock?: string;
  state?: LoopStateBrief | null;
}

/** 单步决策（老接口 /agent/next-action 用；引擎、工具表、提示词与循环完全同一份） */
export async function decideOnce(env: ServerEnv, input: DecideOnceInput): Promise<{ action: BrowserAction; note?: string }> {
  const messages: LlmMessage[] = [
    { role: 'system', content: LOOP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        input.memoryBlock ? `先读该用户的档案记忆并遵守：\n${input.memoryBlock}` : '',
        input.paused ? '用户已暂停：在用户明确继续之前，禁止调用 open_url/click/type（只能用 stop 说明或提问）。' : '',
        `任务目标：${input.goal}`,
        `已完成步骤（最近 ${input.stepsSummary.length} 条）：\n${
          input.stepsSummary.length ? input.stepsSummary.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（第一步，还没有）'
        }`,
        '当前页面快照（只信这个，不要想象别的）：',
        snapshotBrief(input.snapshot),
        '请选下一步要调用的工具（一次一个）。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  const fake: LoopSession = {
    id: 'oneshot',
    userId: 0,
    agentId: null,
    conversationId: null,
    wcId: null,
    goal: input.goal,
    messages,
    step: 0,
    maxSteps: 1,
    status: 'running',
    lastSnapshot: input.snapshot,
    pendingCallId: null,
    usedTools: [],
    advancing: false,
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
  const out = await askModel(env, fake, 'agent/next-action');
  if (!out.ok) return { action: askUser('llm_http', `模型服务返回 HTTP ${out.status}：${out.brief || '（无详情）'}`), note: '上游失败' };
  const calls = (out.message.tool_calls ?? []).filter((c) => c && typeof c === 'object');
  const text = typeof out.message.content === 'string' ? out.message.content.trim().slice(0, 500) : '';
  if (calls.length === 0) {
    return { action: askUser('no_tool', text || '模型这一步没有给出可执行动作，请告诉我下一步。'), note: '模型只说了话，没有调工具' };
  }
  const outcome = sanitizeToolCall(calls[0], input.snapshot);
  if (!outcome.ok) return { action: askUser(outcome.reason, outcome.question), note: '脏动作已拦下（与循环同一套校验）' };
  const call = outcome.call;
  if (call.name === 'stop') {
    const reason = String(call.args.reason ?? 'done');
    if (reason === 'done') {
      return {
        action: {
          action: 'done',
          summary: String(call.args.summary ?? '') || '任务完成',
          document_title: String(call.args.document_title ?? '') || '任务记录',
          document_outline: Array.isArray(call.args.document_outline) ? call.args.document_outline : [],
        },
      };
    }
    return { action: askUser(reason, String(call.args.question ?? '') || '我这边卡住了，你告诉我下一步怎么走？') };
  }
  return { action: toolToAction(call) };
}

function askUser(reason: string, question: string): BrowserAction {
  return { action: 'ask_user', reason, question };
}

/** 工具调用 → 本地 driver 的动作（driver.ts 的 BrowserAction，不另起第二套） */
export function toolToAction(call: LoopToolCall): BrowserAction {
  switch (call.name) {
    case 'open_url':
      return { action: 'open_url', url: String(call.args.url ?? '') };
    case 'read_page':
      return { action: 'read_page' };
    case 'click':
      return { action: 'click', target: String(call.args.target ?? '') };
    case 'type':
      return {
        action: 'type',
        target: String(call.args.target ?? ''),
        text: String(call.args.text ?? ''),
        submit: Boolean(call.args.submit),
      };
    case 'scroll':
      return { action: 'scroll', direction: call.args.direction === 'up' ? 'up' : 'down' };
    default:
      return { action: 'read_page' };
  }
}
