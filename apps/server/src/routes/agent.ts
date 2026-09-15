/**
 * 第 7 步：云端驾驶员接口 —— 每次只决定【一个】本地能执行的动作。
 *
 *   POST /agent/next-action  要 JWT。{taskId?, goal, stepsSummary[], snapshot, paused?}
 *     → 用驾驶员系统提示词 + 目标 + 步摘要 + 当前页快照调 DeepSeek（非流式，JSON 模式），
 *       解析出唯一一个 BrowserAction 返回。
 *     - 模型输出不合法 / 编造动作 → 一律转成 ask_user（“我没看懂页面，请你指导”），绝不瞎点；
 *     - 空动作（空字符串 / 空 / 空 JSON {} / 缺 action 字段 / 占位词「空」）一律不当可执行动作：
 *       先带纠偏提示重问一次要合法 BrowserAction，两次都是空才转 ask_user 并写清原因，
 *       绝不静默推进——否则用户会卡在「点继续 → 立刻 paused」的空动作死循环里；
 *     - paused=true → 服务端兜底：click/type/open_url 全部拦下换成 ask_user；
 *     - 没配 DEEPSEEK_API_KEY → 503 llm_not_configured，不放假动作。
 *   POST /agent/task/start  {goal} → tasks 表记一条 running（payload.steps=[]），返回 {taskId}
 *   POST /agent/task/step   {taskId, summary, ok} → 追加一步“人话摘要”（绝不存整页 HTML/快照）
 *   POST /agent/task/status {taskId, status} → running/paused/done/failed
 *   GET  /agent/task/current → 我最近一条任务（桌面刷新后还原任务卡用）
 *
 * 循环本体在桌面主进程（agent.ts）：这里只当“问一句答一步”的大脑；
 * 用户暂停时本地先停手，这里是第二道闸。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentActionRequest, AgentActionResponse, FieldClassInfo, PageSnapshot } from '@ai-workbench/shared';
import type { BrowserAction } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { llmFetch } from '../llm';
import { notifyUser } from '../notify';
import { buildMemoryBlock, triggerTaskExtract } from './memories';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
  /** 第 8 步：done 的结果文档要加密进 tasks.result_enc（复用第 5 步 AES-256-GCM） */
  cipher: JsonCipher;
}

/** 第 8 步「任务结束整理」提示词（只在服务端；编造是红线） */
const WRAP_PROMPT = [
  '你是工作台的“任务收尾员”。根据任务目标、步骤摘要和最后看到的页面要点，把已完成任务整理成结果。',
  '只输出一个 JSON：{"summary":"给聊天窗口的短结论（可扫读，不要过程流水账）","document_title":"文档标题","document_markdown":"完整 Markdown：## 目标 / ## 结论 / ## 要点列表 / ## 来源 / ## 没做成的事","unread_hint":"红点旁极短提示，例如：调研结果已生成"}',
  '不要编造没在输入里出现过的数字和原文；找不到就写「未找到」。',
  'document_markdown 里禁止出现手机号、验证码、密码、token、API Key。',
  '来源网址只能引用输入里出现过的 url。',
].join('\n')

/** 驾驶员系统提示词：只放服务端。逐字按第 7 步说明。 */
const DRIVER_PROMPT = [
  '你是工作台浏览器的驾驶员。用户能看见工作台里的真实网页，也可随时暂停自己操作。',
  '每次只输出一个 JSON，不要 Markdown，不要注释，不要额外文字。',
  '动作仅限：open_url, click, type, scroll, wait, ask_user, done, fill_form, focus_sensitive_field（字段与产品类型一致）。',
  '规则：',
  '1. 一次一步。不要一次规划十步。',
  '2. 当前页信息不够就 wait 或 ask_user，禁止瞎点。',
  '3.（第 9 步更新）遇到密码、验证码/短信码、支付、扫码、身份证等敏感项：绝不代填也绝不索要其值——用 focus_sensitive_field 把输入框定位好，让用户直接在浏览器里输入；删除、发送、授权这类不可逆动作仍用 ask_user。不要猜密码，也不要让用户把敏感值发到聊天里。',
  '4. 同一动作失败两次，第三次 ask_user，说明你看见了什么。',
  '5. 不要改浏览器设置，不要下安装包，不要关闭用户标签，不要绕过验证码，不要攻击网站。',
  '6. 系统告诉你已暂停时，只能 ask_user 或简短确认，不能输出 click/type/open_url。',
  '7. 用户说继续时，只根据「当前 url + 当前页面元素」，不要假设还在旧页面，不要从头再来。',
  '8. type 必须同时给出 target（输入框）和 text（真正要输入的文字）；不知道要输入什么就用 ask_user 问，禁止给 text 为空的 type。',
  '9. done 只表示「用户要的最终结果已经出现在当前页面上」。',
  '10. 只打开了首页 / 入口页不算完成。目标里含「搜索 / 搜一下 / 查 / 找 X」这类动作时，必须真的把关键词输进输入框并提交（或点搜索按钮）、页面已经跳到结果页，才允许 done。',
  '11. 没做完不要 done，也不要用 done 代替 ask_user。拿不准就 ask_user 问用户，宁可多问一次。',
  '12. 禁止编造页面上没有的按钮。',
  '13.（第 9 步）快照会标注每个输入框的分类。对 sensitive（密码/验证码/支付/身份证）字段：绝不用 type/fill_form 填它；需要用户输入时只输出 focus_sensitive_field（不带任何值，target 写明是哪个框），并在页面说明里让用户知道「输完会自动继续」。',
  '14.（第 9 步）需要用户提供普通资料（姓名/性别/地址/公司/职位/备注/搜索词等）而你还没拿到：先输出 ask_user（reason 用 need_info，一句话问清要什么，可一次问多项）；拿到用户答复后用 fill_form 一次填完这些 normal 字段，再按需用 click 点「搜索/确定/提交/下一步」这类普通按钮。支付/收银的最终确认永远不点。',
  '15.（第 9 步）用户在聊天里主动发了疑似密码/验证码的值：不要复述该值、不要拿它填任何字段，输出 focus_sensitive_field 定位对应输入框即可。',
  '16.（第 16 步）用户已经同意使用浏览器（本会话已确认，网页卡片就开在聊天里）：**直接执行**，不要再问「是否打开某某网站」「要不要我操作浏览器」，也不要在每一步前问「可以吗」。',
  '17.（第 16 步）以**用户最新指令**为准：目标已被用户改口覆盖时，不要再提旧任务；也不要把还停在旧站点（例如旧店铺后台）的当前页当成用户还想做旧任务——按新目标决定下一步。',
  '18.（第 16 步）动作失败时：说清可能原因（页面没加载完 / 被弹窗遮住 / 需要先登录 / 权限不足 / 元素不在视口内），并给**一个**明确的下一步；不要退回「你是否确认打开某某网站」这种整段重确认。需要用户自己在页面里登录时，提醒一次即可，不要每轮重复。',
].join('\n');

/** paused 覆盖提示：拼在用户消息最前 */
const PAUSED_OVERRIDE = [
  '用户已暂停。页面可能已被用户改过。',
  '在用户明确继续之前，禁止输出 open_url/click/type。',
  '用户说「我登好了」之后，必须用最新 snapshot 决策。',
].join('\n');

/** 允许的动作文法：与 shared BrowserAction 一致 */
const ALLOWED = new Set(['open_url', 'click', 'type', 'scroll', 'wait', 'ask_user', 'done', 'fill_form', 'focus_sensitive_field']);

/** 模型「交白卷」时的常见写法（空串、占位词）。这些一律不算可执行动作。 */
const BLANK_ACTION_WORDS = new Set([
  '', '空', '无', '没有', 'none', 'null', 'nil', 'n/a', 'na', 'undefined', '-', '—', '()', '{}',
]);

function isBlankActionWord(v: unknown): boolean {
  return typeof v === 'string' && BLANK_ACTION_WORDS.has(v.trim().toLowerCase());
}

/**
 * 空动作判定：空字符串 / null / undefined / 空 JSON（{}）/ 缺 action 字段 / 占位词「空」……
 * 这些绝不当可执行动作下发，也不能静默当成一步推进——否则用户会卡在
 * 「点继续 → 立刻 paused → 再点继续」的空动作死循环里。
 */
function isEmptyAction(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return isBlankActionWord(raw);
  if (typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length === 0) return true; // 空 JSON {}
  if (!('action' in o) || o.action === null || o.action === undefined) return true; // 缺 action 字段
  return isBlankActionWord(o.action); // 空串 / 占位词
}

/** 第一轮交白卷时的纠偏提示：再要一次合法动作，别急着把用户踢成 paused */
const RETRY_HINT_BLANK = [
  '注意：你上一次的输出不是可执行动作（空动作、空 JSON、缺 action 字段，或根本不是合法 JSON）。',
  '空动作不会被本地执行，也不会推进任务，只会让用户卡住——请不要再用空动作回答。',
  '请只输出一个 JSON 对象，且必须带 action 字段，取值仅限：open_url / click / type / scroll / wait / ask_user / done / fill_form / focus_sensitive_field。',
  '当前页信息不足以决定下一步 → 用 ask_user 并写清 question；目标已完成 → 用 done。',
].join('\n');

/** 第一轮就想收工（只开了首页）时的纠偏提示：把"完成"的门槛说清楚 */
const RETRY_HINT_EARLY_DONE = [
  '注意：你上一次直接给了 done，但现在只打开了首页 / 入口页，用户要的结果还没出现在页面上。',
  'done 只表示「用户要的最终结果已经在当前页面上」；只打开首页不算完成。',
  '请继续输出下一个动作（不要 done）：例如在搜索框里 type 关键词并 submit，或 click 搜索按钮。',
  '如果当前页信息不足以继续，就用 ask_user 问用户，不要用 done 蒙混过去。',
].join('\n');

/** 目标里有没有「要搜 / 要查 / 要找」的意图（纯「打开某页」不算） */
const SEARCH_INTENT = /(搜索|搜一下|搜搜|搜个|查询|查一下|查查|查找|搜|查|找一下|找找)/;
/** 到目前为止有没有真"动过手"的步骤（输入 / 点击 / 提交） */
const HANDS_ON_STEP = /(输入|写入|点击|提交|回车)/;

/** 当前页看起来已经是「结果页」：URL 上带了查询参数（例如百度 /s?wd=天气） */
function looksLikeResultPage(url: string): boolean {
  return /[?&][^=&#]+=[^&#]+/.test(url);
}

/**
 * 判断模型这次的 done 是不是「太早」（只打开首页就想收工）。
 * 判定刻意收窄，避免误伤：
 *   1) 目标里必须有搜索/查询意图 —— 单纯「打开百度」打开完 done 是合理的；
 *   2) 到目前为止没有任何「输入/点击」步骤 —— 说明只 open_url 过，没真推进目标；
 *   3) 当前页也不是带查询参数的结果页 —— 模型直接开结果 URL 的情况放过。
 * 三条同时成立才算早，然后会带纠偏提示重问一次；两次都这样才转 ask_user。
 */
function isPrematureDone(raw: unknown, goal: string, steps: string[], snapshot: PageSnapshot): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  if ((raw as Record<string, unknown>).action !== 'done') return false;
  if (!SEARCH_INTENT.test(goal)) return false;
  if (steps.some((s) => HANDS_ON_STEP.test(s))) return false;
  if (looksLikeResultPage(snapshot.url)) return false;
  return true;
}

function askUser(reason: string, question: string): Extract<BrowserAction, { action: 'ask_user' }> {
  return { action: 'ask_user', reason, question };
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[agent] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 校验/归一模型吐出来的 JSON：不合法就换 ask_user，绝不让脏动作下发到本地执行 */
function sanitizeAction(raw: unknown, paused: boolean, snapshot: PageSnapshot): BrowserAction {
  if (typeof raw !== 'object' || raw === null) return askUser('parse_failed', '我没看懂页面，请你指导一下（告诉我点哪里，或先自己操作再继续）。');
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action : '';
  if (!ALLOWED.has(action)) return askUser('bad_action', `我不认识这个动作「${action || '(空)'}」，请换个说法或指导我。`);
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const clip = (v: unknown, n: number): string[] =>
    Array.isArray(v) ? v.slice(0, n).map((x) => String(x).slice(0, 120)) : [];
  switch (action) {
    case 'open_url': {
      const url = str(o.url, 500);
      if (!/^https?:\/\//i.test(url)) return askUser('bad_url', '我要打开的网址不合法（需要 http(s):// 开头），请确认目标。');
      return { action: 'open_url', url };
    }
    case 'click': {
      const target = str(o.target, 160);
      if (!target) return askUser('bad_target', '点击目标没写清楚。页面上你想让我点哪个？');
      if (/(立即支付|确认支付|确认付款|去支付|去付款|提交订单|确认订单|pay\s*now|checkout|place\s*order)/i.test(target)) {
        return askUser('payment_confirm', '支付/收银的最终确认必须由用户自己点，我不代点。请你在页面上确认后告诉我结果。');
      }
      return { action: 'click', target };
    }
    case 'type': {
      const target = str(o.target, 160);
      const text = typeof o.text === 'string' ? o.text.slice(0, 500) : '';
      if (!target || !text) return askUser('bad_target', '输入框或要输入的内容没写清楚，请指导。');
      const sens = matchSensitiveTarget(snapshot, target); // 第 9 步：想 type 敏感字段 → 换成定位
      if (sens) {
        return { action: 'focus_sensitive_field', target, fieldReason: sens.reason === 'server_guard' ? 'guard' : sens.reason };
      }
      return { action: 'type', target, text, submit: Boolean(o.submit) };
    }
    case 'fill_form': {
      const rawFields = Array.isArray(o.fields) ? o.fields.slice(0, 12) : [];
      const kept: { target: string; text: string }[] = [];
      let sensitiveHit: { target: string; reason: string } | null = null;
      for (const f of rawFields) {
        const t = str((f as Record<string, unknown>)?.target, 160);
        const v = typeof (f as Record<string, unknown>)?.text === 'string' ? String((f as Record<string, unknown>).text).slice(0, 500) : '';
        if (!t || !v) continue;
        const sens = matchSensitiveTarget(snapshot, t);
        if (sens) {
          sensitiveHit = { target: t, reason: sens.reason === 'server_guard' ? 'guard' : sens.reason };
          continue; // 敏感的一律剔出代填
        }
        kept.push({ target: t, text: v });
      }
      if (sensitiveHit && kept.length === 0) {
        return { action: 'focus_sensitive_field', target: sensitiveHit.target, fieldReason: sensitiveHit.reason };
      }
      if (kept.length === 0) return askUser('bad_form', '这次要代填的字段一个都没定下来（可能目标写得太含糊）。请指导我该往哪个框填什么。');
      // 部分剔敏：剩下的普通字段照填；被剔的敏感项由本地执行器兜底（双闸）
      void sensitiveHit;
      return { action: 'fill_form', fields: kept } satisfies BrowserAction;
    }
    case 'focus_sensitive_field': {
      const target = str(o.target, 160);
      if (!target) return askUser('bad_target', '要定位哪个输入框没说清楚。请告诉我字段名，或你自己点开那个框。');
      return { action: 'focus_sensitive_field', target, fieldReason: str(o.fieldReason, 40) || 'guard' };
    }
    case 'scroll':
      return { action: 'scroll', direction: o.direction === 'up' ? 'up' : 'down' };
    case 'wait': {
      const seconds = Math.max(0, Math.min(Number(o.seconds) || 1, 30));
      return { action: 'wait', seconds };
    }
    case 'ask_user':
      return askUser(str(o.reason, 200) || 'need_help', str(o.question, 500) || '我需要你的指导，接下来怎么办？');
    case 'done':
      return {
        action: 'done',
        summary: str(o.summary, 500) || '任务完成',
        document_title: str(o.document_title, 120) || '任务记录',
        document_outline: clip(o.document_outline, 12),
      };
    default:
      return askUser('bad_action', '这个动作不在本步能力里，请指导我换条路。');
  }
}

/** 兜底：paused 时物理拦掉会动页面的动作（规则 6 的服务端执行） */
function enforcePausedGate(action: BrowserAction, paused: boolean): BrowserAction {
  if (!paused) return action;
  if (action.action === 'click' || action.action === 'type' || action.action === 'open_url' || action.action === 'fill_form') {
    return askUser('paused_by_user', '你已暂停接管中，我不会动页面。要继续就点「继续」，或直接告诉我下一步。');
  }
  return action;
}

/** 从模型回复里抠第一个 JSON 对象（容忍 ``` 围栏和前后废话） */
function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 服务端第二道闸：target 命中快照里已标敏感的框，或文案本身就像敏感字段，都算敏感 */
const SENSITIVE_TARGET_RE = /(密码|password|验证码|校验码|动态口令|短信码|otp|captcha|verification\s*code|支付|付款|银行卡|卡号|cvv|身份证)/i;
function matchSensitiveTarget(snapshot: PageSnapshot, target: string): FieldClassInfo | null {
  const t = String(target ?? '').trim().toLowerCase();
  if (!t) return null;
  for (const f of snapshot.inputFields ?? []) {
    if (f.kind !== 'sensitive') continue;
    const lab = f.label.toLowerCase().replace(/^\[敏感·[^\]]*\]\s*/, '');
    if (lab && !lab.includes('无标识') && (t.includes(lab.slice(0, 20)) || lab.includes(t))) return f;
  }
  return SENSITIVE_TARGET_RE.test(t) ? { label: t, kind: 'sensitive', reason: 'server_guard' } : null;
}

/**
 * 第 16 步：快照描述里把「像不像登录页 / 有没有遮挡」说清楚——
 * 工具层要能给出「失败原因 + 一个下一步」，这两条是最常见的真实原因。
 */
function snapshotBrief(s: PageSnapshot): string {
  const list = (a: string[] | undefined, n: number): string => (a && a.length ? a.slice(0, n).join(' | ') : '（无）');
  return [
    `url: ${s.url}`,
    `title: ${s.title}`,
    `页面性质: ${s.loginLike ? '像登录页（需要用户自己在网页里登录）' : '普通页面'}${s.overlay ? '；检测到疑似弹窗/遮罩，可能挡住按钮' : ''}`,
    `可见按钮: ${list(s.buttons, 24)}`,
    `可见链接: ${list(s.links, 16)}`,
    `可见输入框: ${list(s.inputs, 12)}`,
    ...(s.inputFields?.length
      ? [`字段分类（敏感的一律不代填）: ${s.inputFields.map((f) => `${f.kind === 'sensitive' ? '敏感·' + f.reason : '普通'}[${f.label}]`).slice(0, 12).join(' ; ')}`]
      : []),
  ].join('\n');
}

/** 任务归属校验：tasks JOIN projects，只认自己的 */
async function ownTask(pool: Pool, taskId: number, userId: number) {
  const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean; result_enc: string | null }>(
    'SELECT t.id, t.status, t.title, t.payload, t.unread, t.result_enc FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.user_id = $2',
    [taskId, userId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}


/** 第 8 步：兜底文档——没配 Key 或模型乱答时，用已落库字段拼一份**不编造**的 Markdown */
function buildFallbackDoc(goal: string, steps: string[], done: Record<string, unknown>): { summary: string; title: string; markdown: string; hint: string } {
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const summary = str(done.summary, '任务已完成（细节见文档）');
  const title = str(done.document_title, '任务记录');
  const outline = Array.isArray(done.document_outline) ? (done.document_outline as unknown[]).map(String).slice(0, 12) : [];
  const lines = [
    `# ${title}`,
    '',
    '## 目标',
    goal || '未找到',
    '',
    '## 结论',
    summary,
    '',
    '## 要点',
    ...(outline.length ? outline.map((x) => `- ${x}`) : ['- 未找到（模型未配置或未能整理，以下为原始步骤）']),
    '',
    '## 步骤摘要',
    ...(steps.length ? steps.map((x) => `- ${x}`) : ['- 未找到']),
    '',
    '> 本文档由任务记录字段兜底生成（第 8 步）；未接入模型整理，也未编造任何页面数据。',
  ];
  return { summary, title, markdown: lines.join('\n'), hint: '任务结果已生成' };
}

export function registerAgentRoutes(app: FastifyInstance, { pool, env, cipher }: AgentDeps): void {
  // ---------------------------------------------------------------- 只给一步
  app.post('/agent/next-action', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（驾驶员接口需要第 5 步的 JWT）');
    if (!env.deepseekApiKey) {
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server', {
        code: 'llm_not_configured',
      });
    }
    const body = req.body as AgentActionRequest | null;
    const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空（先告诉我要完成什么）');
    const snapshot = body?.snapshot;
    if (!snapshot || typeof snapshot.url !== 'string') return errJson(reply, 400, 'snapshot 需要 read_page 的当前页快照');
    const steps = Array.isArray(body?.stepsSummary) ? body.stepsSummary.filter((x) => typeof x === 'string').slice(-12) : [];
    const paused = Boolean(body?.paused);

    // 第 10 步：驾驶员同样吃“已确认记忆”（pending 不会出现在这里——只查 active）
    const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, goal);
    const userMsg = [
      memBlock ? `先读该用户的档案记忆并遵守：\n${memBlock}` : '',
      paused ? PAUSED_OVERRIDE : '',
      `任务目标：${goal}`,
      `已完成步骤（最近 ${steps.length} 条）：`,
      steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（第一步，还没有）',
      '当前页面快照（只信这个，不要想象别的）：',
      snapshotBrief(snapshot),
      paused ? '现在只允许：ask_user 或简短确认。' : '请只输出下一个动作的 JSON。',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      // 最多问两轮：第一轮模型可能交白卷（空动作 / 空 JSON / 坏 JSON），也可能「只开了首页就想 done」；
      // 第二轮带对应纠偏提示再要一次 —— 既不因一次坏输出就把用户踢进 paused，也不假装任务已完成。
      let parsed: unknown = null;
      let problem: 'bad_json' | 'empty_action' | 'early_done' | 'none' = 'bad_json';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const hint = attempt === 1 ? '' : problem === 'early_done' ? RETRY_HINT_EARLY_DONE : RETRY_HINT_BLANK;
        const r = await fetch(`${env.deepseekBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.deepseekApiKey}` },
          body: JSON.stringify({
            model: env.deepseekModel,
            stream: false,
            response_format: { type: 'json_object' },
            temperature: 0.2,
            messages: [
              { role: 'system', content: DRIVER_PROMPT },
              { role: 'user', content: hint ? `${userMsg}\n\n${hint}` : userMsg },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!r.ok) {
          const brief = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
          console.error('[agent] 上游 HTTP', r.status, brief);
          return errJson(reply, 502, `模型服务返回 HTTP ${r.status}：${brief || '（无详情）'}`);
        }
        const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content ?? '';
        parsed = extractJson(content);
        if (parsed === null) problem = 'bad_json';
        else if (isEmptyAction(parsed)) problem = 'empty_action';
        else if (isPrematureDone(parsed, goal, steps, snapshot)) problem = 'early_done';
        else problem = 'none';
        if (problem === 'none') break; // 拿到可用动作，收工
        if (attempt === 1) console.warn(`[agent] 模型第 1 轮结果不可用（${problem}），带纠偏提示再要一次`);
      }

      if (problem === 'bad_json') {
        // 模型没说人话：按说明书当 ask_user，不瞎执行
        return {
          action: askUser('parse_failed', '模型这两次都没给出合法 JSON 动作，我没有执行任何动作，也没有推进任务。请告诉我下一步，或你自己操作后点「继续」。'),
          note: '模型输出不是合法 JSON（已带纠偏提示重问一次），已按规则转成 ask_user',
        } satisfies AgentActionResponse;
      }
      if (problem === 'empty_action') {
        // 空字符串 / 空 / 空 JSON / 缺 action 字段：一律不当可执行动作，也不静默推进
        return {
          action: askUser(
            'empty_action',
            '模型这一步给的是空动作（没有可执行内容），我没有执行任何动作，也没有推进任务。请直接告诉我下一步，或你自己操作后点「继续」。',
          ),
          note: '模型两次都只给出空动作（空字符串/空 JSON/缺 action 字段），已按规则转成 ask_user',
        } satisfies AgentActionResponse;
      }
      if (problem === 'early_done') {
        // 只打开了首页就想收工：绝不当成完成，也不静默推进
        return {
          action: askUser(
            'early_done',
            `模型想直接宣告完成，但「${goal}」还没做完——现在只打开了入口页，关键词还没搜。我没有把它当成完成。请告诉我下一步，或你自己操作后点「继续」。`,
          ),
          note: '模型两次都想在只打开入口页时就 done，已按规则转成 ask_user（避免过早 done）',
        } satisfies AgentActionResponse;
      }
      return { action: enforcePausedGate(sanitizeAction(parsed, paused, snapshot), paused) } satisfies AgentActionResponse;
    } catch (err) {
      const msg = (err as Error)?.name === 'TimeoutError' ? '模型响应超时（60s），本轮没执行任何动作' : `模型服务连不上：${(err as Error).message}`;
      return errJson(reply, 502, msg);
    }
  });

  // ---------------------------------------------------------------- 任务记账
  app.post('/agent/task/start', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const goal = typeof (req.body as { goal?: unknown } | null)?.goal === 'string' ? String((req.body as { goal: string }).goal).trim() : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空');
    try {
      const p = await pool.query<{ id: string }>(
        'SELECT id FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
        [claims.sub],
      );
      if (p.rowCount !== 1) return errJson(reply, 500, '当前账号没有默认项目（重新登录一次让建号流程补上）');
      const t = await pool.query<{ id: string }>(
        "INSERT INTO tasks (project_id, status, title, payload) VALUES ($1, 'running', $2, $3::jsonb) RETURNING id",
        [p.rows[0].id, goal.slice(0, 80), JSON.stringify({ goal, steps: [] })],
      );
      return { taskId: Number(t.rows[0].id) };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/step', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; ok?: unknown } | null;
    const taskId = Number(b?.taskId);
    const summary = typeof b?.summary === 'string' ? b.summary.slice(0, 300) : '';
    if (!Number.isInteger(taskId) || !summary) return errJson(reply, 400, 'taskId / summary 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[] };
      const steps = [...(payload.steps ?? []), `${summary}${b?.ok === false ? '（失败）' : ''}`].slice(-50);
      await pool.query('UPDATE tasks SET payload = $2::jsonb, updated_at = now() WHERE id = $1', [
        taskId,
        JSON.stringify({ ...payload, steps }),
      ]);
      return { ok: true, stepCount: steps.length };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/status', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; status?: unknown } | null;
    const taskId = Number(b?.taskId);
    const status = String(b?.status ?? '');
    if (!Number.isInteger(taskId) || !['running', 'paused', 'done', 'failed'].includes(status)) {
      return errJson(reply, 400, 'taskId 必填；status ∈ running/paused/done/failed');
    }
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [taskId, status]);
      if (status === 'done' || status === 'failed') {
        triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, t.payload);
      }
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

// ============================================================ 第 8 步：done 的收尾
  // finish：调模型整理一次（可缺）→ 兜底不卡死 → 文档密文入 result_enc → unread=true → 通知桩
  app.post('/agent/task/finish', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; document_title?: unknown; document_outline?: unknown; pagePoints?: unknown } | null;
    const taskId = Number(b?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[] };
      const goal = payload.goal ?? t.title ?? '';
      const steps = payload.steps ?? [];
      const doneBits = {
        summary: typeof b?.summary === 'string' ? b.summary.slice(0, 400) : '',
        document_title: typeof b?.document_title === 'string' ? b.document_title.slice(0, 120) : '',
        document_outline: Array.isArray(b?.document_outline) ? (b.document_outline as unknown[]).slice(0, 12) : [],
      };
      let doc = buildFallbackDoc(goal, steps, doneBits as unknown as Record<string, unknown>);
      if (env.deepseekApiKey) {
        // 只整理一次；模型连不上/乱答都退回兜底，绝不让收尾卡死
        try {
          const points = Array.isArray(b?.pagePoints) ? (b.pagePoints as unknown[]).map(String).slice(0, 12) : [];
          const r = await llmFetch(
            env,
            [
              { role: 'system', content: WRAP_PROMPT },
              {
                role: 'user',
                content: [
                  `任务目标：${goal}`,
                  `步骤摘要：\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）'}`,
                  `驾驶员 done 结论：${doneBits.summary || '（无）'}`,
                  `要点提纲：${doneBits.document_outline.join(' / ') || '（无）'}`,
                  `最后页面要点（仅标题/按钮级，不含整页）：\n${points.join('\n') || '（无）'}`,
                ].join('\n\n'),
              },
            ],
            { tag: 'agent/task/finish', json: true, temperature: 0.2 },
          );
          if (r.ok) {
            const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
            const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
            if (parsed && typeof parsed === 'object') {
              const o = parsed as Record<string, unknown>;
              const md = typeof o.document_markdown === 'string' ? o.document_markdown.slice(0, 20_000) : '';
              if (md.trim()) {
                doc = {
                  summary: (typeof o.summary === 'string' && o.summary.trim()) ? o.summary.slice(0, 400) : doc.summary,
                  title: (typeof o.document_title === 'string' && o.document_title.trim()) ? o.document_title.slice(0, 120) : doc.title,
                  markdown: md,
                  hint: (typeof o.unread_hint === 'string' && o.unread_hint.trim()) ? o.unread_hint.slice(0, 24) : doc.hint,
                };
              }
            }
          }
        } catch (err) {
          console.warn('[agent] 收尾整理未用模型（走兜底，任务仍算完成）：', (err as Error).message);
        }
      }
      await pool.query(
        "UPDATE tasks SET status = 'done', unread = true, result_enc = $2, payload = $3::jsonb, updated_at = now() WHERE id = $1",
        [
          taskId,
          cipher.encryptText(doc.markdown),
          JSON.stringify({ ...payload, doc: { summary: doc.summary, title: doc.title, hint: doc.hint, outline: doneBits.document_outline } }),
        ],
      );
      try {
        notifyUser(claims.sub, `${doc.hint}（任务 #${taskId}：${goal.slice(0, 30)}）`);
      } catch (err) {
        // 通知挂了不碍事：说明书钉死——任务仍算 done，红点和文档都在
        console.warn('[agent] 通知失败（忽略，不影响任务）：', (err as Error).message);
      }
      triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, {
        ...(payload as Record<string, unknown>),
        doc: { summary: doc.summary },
      } as never);
      return { ok: true, unread: true, unreadHint: doc.hint, docTitle: doc.title };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 下载前取文档（密文解回）；老任务没存过 result_enc 就用字段兜底再生成
  app.get('/agent/task/doc', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { taskId?: unknown } | null;
    const taskId = Number(q?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string; title?: string; outline?: string[] } };
      let markdown: string;
      if (t.result_enc) {
        try {
          markdown = cipher.decryptText(t.result_enc);
        } catch {
          return errJson(reply, 500, '文档解密失败：DATA_KEY 可能换过');
        }
      } else {
        const bits = { summary: payload.doc?.summary ?? '', document_title: payload.doc?.title ?? '', document_outline: payload.doc?.outline ?? [] };
        markdown = buildFallbackDoc(payload.goal ?? t.title ?? '', payload.steps ?? [], bits as unknown as Record<string, unknown>).markdown;
      }
      const title = (payload.doc?.title ?? '任务记录').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 60) || '任务记录';
      return { title, markdown };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 看完即读：红点灭
  app.post('/agent/task/read', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const taskId = Number((req.body as { taskId?: unknown } | null)?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET unread = false, updated_at = now() WHERE id = $1', [taskId]);
      return { ok: true, unread: false };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/agent/task/current', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean }>(
        'SELECT t.id, t.status, t.title, t.payload, t.unread FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.user_id = $1 ORDER BY t.id DESC LIMIT 1',
        [claims.sub],
      );
      if (r.rowCount !== 1) return { task: null };
      const row = r.rows[0];
      const payload = (row.payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string; title?: string; hint?: string; outline?: string[] } };
      return {
        task: {
          id: Number(row.id),
          status: row.status,
          goal: payload.goal ?? row.title ?? '',
          steps: payload.steps ?? [],
          unread: Boolean(row.unread),
          summary: payload.doc?.summary ?? '',
          docTitle: payload.doc?.title ?? '',
          unreadHint: payload.doc?.hint ?? '',
          outline: payload.doc?.outline ?? [],
        },
      };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}