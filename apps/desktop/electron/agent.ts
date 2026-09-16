/**
 * 第 21 步 · 工具循环的**执行侧**（跑在 Electron 主进程；刻意不 import electron，
 * 全部依赖注入 —— main.ts 负责接线，单测直接喂假实现）。渲染进程绝不直连 CDP。
 *
 * 循环的**脑在服务端**（apps/server/src/toolLoop.ts）：消息历史、工具表、提示词、
 * 步数上限都在那一侧。这里只当「手」，顺序钉死，别发明第二套：
 *
 *   POST /agent/loop/next（带上一个工具的回执）
 *     → 服务端回 {kind:'tool'} 一个工具（open_url / read_page / click / type / scroll）
 *       → 交给现有 driver.ts 在**这一路自己那张页**上执行
 *       → 把结果（URL、读页摘要、点没点到、失败原因）当回执喂回去
 *     → 直到 {kind:'done'} 收尾、{kind:'ask'} 卡住问你、{kind:'say'} 只说了一句话，
 *       或 {kind:'stopped'}（用户喊「停」/ 被新指令顶掉）。
 *
 * 硬保证（本地先停，再同步服务端）：
 *   - 每格开头与执行后都查暂停；暂停后绝不点、绝不问下一步，并把 paused 同步给 tasks 表；
 *   - 「继续」= 新起一轮循环（第一步仍是 read_page 当前真实页），不重放旧动作；
 *   - 本地还有三道安全网（都是「原因 + 一个下一步」，不是第二套话术）：
 *       · 同一个动作连续失败 2 次 → 不再盲试，本地转 ask；
 *       · 点了但页面连着 3 次没变化 → 不再盲点，本地转 ask；
 *       · type 找不到输入框、而目标就是搜索 → 改用搜索结果页一步到位（沿用第 17 步的兜底）；
 *   - 模型/网络/未配置错误 → 明确 note + failed，绝不假装有动作；
 *   - 记步只存一行人话摘要，整页 HTML/快照绝不出现在 steps 里。
 *
 * 明确不做：不在本地维护「当前是第几步 / 还剩几步」（那是服务端的事）、
 * 不再自己解析模型的 JSON 动作、不做第二套点页引擎、不做无头浏览器。
 */
import type {
  AgentEventPayload,
  AgentLoopDecision,
  BrowserAction,
  DriveResult,
  LoopToolCall,
  LoopToolResult,
  PageSnapshot,
} from '@ai-workbench/shared';

export interface ToolLoopHooks {
  /**
   * 问服务端要下一格：第一次不带回执；之后带上一个工具的执行回执。
   * 实现方负责带 JWT。出错请 throw（带人话 message）。
   */
  next(loopId: string, result: LoopToolResult | null): Promise<AgentLoopDecision>;
  /** 现有 driver.ts 的单动作执行器（打到这一路自己的那张页上） */
  exec(action: BrowserAction): Promise<DriveResult>;
  /** 用户是否已接管（暂停标志）——每一格都查 */
  isPaused(): boolean;
  /** 这一路是否已作废（reset / stop / 被新任务顶掉） */
  aborted(): boolean;
  /** 向渲染进程广播（'agent' 事件）；实现方 JSON 序列化并发送 */
  emit(payload: AgentEventPayload): void;
  /** 告诉服务端「这一路不用再走了」（本地安全网收尾 / 循环结束） */
  stopLoop?(reason: string): void;
  /**
   * 敏感字段（密码/验证码/支付/身份证）：服务端已把这类输入挡成一句提问。
   * 实现方负责【窗口前置 + 聚焦这一路那张页 + 发 🔒 人话提示】。
   */
  sensitiveNotice?(question: string): void;
  /**
   * 敏感字段等待态——实现方负责启动自动恢复观察、并在「用户输完提交/手动继续/回答资料」
   * 任一信号时 resolve。循环 await 它：醒来后下一格仍先看当前真实页。
   */
  sensitiveHold?(): Promise<void>;
  /** 取走用户对「补资料」提问的回答（一次性，取完即清） */
  takeAnswers?(): string[];
  /** 改主进程状态机（大字横幅/调试区跟着走）；实现方桥接 driver */
  phase(next: 'running' | 'paused' | 'done' | 'failed', detail: string): void;
  /** 任务记账（服务端 tasks 表）；全部 best-effort，失败只静默 */
  taskStart(goal: string): Promise<number | null>;
  taskStep(taskId: number | null, summary: string, ok: boolean): Promise<void>;
  taskStatus(taskId: number | null, status: 'running' | 'paused' | 'done' | 'failed'): Promise<void>;
  /**
   * 第 8 步：done 收尾——把结论/提纲/最后页面要点交给服务端整理成文档并打红点。
   * best-effort：没配 Key 服务端也兜底生成；调用失败只当文档未就绪，不卡 done。
   */
  taskFinish?(
    taskId: number,
    done: { summary: string; document_title: string; document_outline: string[] },
    pagePoints: string[],
  ): Promise<{ unreadHint?: string; docReady?: boolean } | undefined>;
  sleep(ms: number): Promise<void>;
}

/** 同一个动作连败这么多次就不再盲试（本地转 ask） */
const FAILS_BEFORE_ASK = 2;
/** 点了但页面连着这么多次没变化就不再盲点（本地转 ask） */
const STALE_BEFORE_ASK = 3;

/**
 * 第 21 步 · 单个工具执行的硬上限（**防死锁**）。
 *
 * driver 里已经给每条 CDP 命令加了 8 秒闸，但「手」还可能因为别的原因不回：
 * 打开网址等页面加载、点完等跳转、页面在忙……只要有一次 `await` 不回，
 * 整条循环就永久挂住（liveLoops 一直是 1、模型调用数不再增长、聊天停在半句话上），
 * 用户只能重启窗口。所以这里再兜一层：超时当「这一步失败」，
 * 把原因喂回模型，让它给出「原因 + 一个下一步」，循环继续活着。
 */
const EXEC_TIMEOUT_MS = 20_000;

/** 「找不到输入框」类失败：模型给的 target 对不上页面上任何输入框 */
const NO_INPUT_FOUND = /没找到可输入的输入框|找不到.{0,6}输入框/;

/** 工具调用 → 本地 driver 的动作（服务端只给工具名 + 参数，映射在本地，与 driver 契约一致） */
export function toolToAction(call: LoopToolCall): BrowserAction | null {
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
      return null; // stop 不该走到执行侧；别的名字一律不执行
  }
}

/** 工具的人话标签（进聊天的那句步摘要） */
function label(a: BrowserAction): string {
  switch (a.action) {
    case 'open_url':
      return `打开 ${a.url}`;
    case 'click':
      return `点击「${a.target}」`;
    case 'type':
      return `在「${a.target}」输入「${a.text}」${a.submit ? '并回车' : ''}`;
    case 'scroll':
      return `向${a.direction === 'down' ? '下' : '上'}滚动`;
    case 'read_page':
      return '读当前页';
    default:
      return a.action;
  }
}

/** 执行结果 → 喂回服务端的回执（只留人话 + 快照，不含整页 HTML） */
function toResult(res: DriveResult): LoopToolResult {
  return {
    ok: res.ok,
    detail: res.detail,
    error: res.error,
    noChange: res.noChange,
    page: res.pageSnapshot,
  };
}

/** 目标里的搜索关键词：「打开百度搜天气」→「天气」；抠不出来（不是搜索类目标）就返回空 */
function searchKeyword(goal: string): string {
  // 注意 搜(?!索) / 查(?!询|找)：防止「搜索」「查询」被单字分支截成「索」「询」这种半个词
  const m = goal.match(/(?:搜索|搜一下|搜搜|搜个|查一下|查查|查询|查找|搜(?!索)|查(?!询|找))\s*(.+)$/);
  const kw = (m?.[1] ?? '')
    .replace(/^[「『"']+|[」』"']+$/g, '')
    .replace(/[。.!！?？\s]+$/g, '')
    .trim();
  return kw && kw.length <= 60 ? kw : '';
}

/**
 * 搜索兜底：右栏窄 + 调试区把网页压矮，搜索框常年整条在视口外，模型给的描述性 target
 * 又对不上任何输入框。与其空 type 两次再放弃，不如直接开搜索结果页，一步到位。
 * （第 21 步保留：它不是「第二套大脑」，只是把这一步的结果如实回报给模型。）
 */
function searchUrl(keyword: string): string {
  return `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`;
}

/** 跑一整轮工具循环；返回结束原因（给 main.ts 记日志用，不进渲染层） */
export async function runToolLoop(loopId: string, goal: string, hooks: ToolLoopHooks): Promise<string> {
  let taskId: number | null = null;
  try {
    taskId = await hooks.taskStart(goal);
  } catch {
    taskId = null; // 记账失败不拦驾驶
  }

  /**
   * 第一格的回执：用户刚回答了上一轮的提问时，把答复原样带上去（只进上下文，不落库）。
   * 其余情况为 null —— 服务端会当作「第一步，还没有执行过动作」。
   */
  const answers = hooks.takeAnswers?.() ?? [];
  let result: LoopToolResult | null =
    answers.length > 0 ? { ok: true, detail: '（上一格在等用户答话，没有执行动作）', userAnswer: answers.join(' / ') } : null;

  let fails = 0;
  let staleClicks = 0;
  let step = 0;
  /** 这一路最近一次读到的页面快照（只用来给 done 收尾提供「最后页面要点」；按路隔离，不跨 lane） */
  let lastSnapshot: PageSnapshot | null = null;

  const finish = (reason: string): string => {
    // 不是「做完了」的收尾都要告诉服务端：这一路不用再走了（省得它挂着空转）
    if (reason !== 'done' && reason !== 'aborted') hooks.stopLoop?.(`ended:${reason}`);
    return reason;
  };

  for (;;) {
    if (hooks.aborted()) return 'aborted';
    if (hooks.isPaused()) {
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return finish('paused');
    }

    let decision: Awaited<ReturnType<ToolLoopHooks['next']>>;
    try {
      decision = await hooks.next(loopId, result);
    } catch (err) {
      const msg = `问不到下一步：${(err as Error).message}`;
      hooks.emit({ kind: 'note', level: 'error', text: msg });
      hooks.phase('failed', msg);
      await hooks.taskStatus(taskId, 'failed').catch(() => undefined);
      return finish('brain_failed');
    }
    result = null; // 回执只喂一次

    if (hooks.aborted()) return 'aborted';
    if (hooks.isPaused()) {
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return finish('paused');
    }

    if (decision.kind === 'stopped') {
      hooks.emit({ kind: 'note', level: 'info', text: '这一路已经停手了，不再动作。要接着干，直接说下一步就行。' });
      hooks.phase('paused', '已按你的要求停手');
      return finish('stopped');
    }

    if (decision.kind === 'say') {
      // 模型只说了话、没调工具：把话给用户，循环在这一格停住（等新指令，不空转）
      hooks.emit({ kind: 'note', level: 'info', text: decision.text });
      hooks.phase('paused', `等你下一步：${goal.slice(0, 30)}`);
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return finish('say');
    }

    if (decision.kind === 'ask') {
      if (decision.reason === 'sensitive_field') {
        // 敏感字段：服务端先挡下来的 —— 前置窗口 + 聚焦这张页 + 🔒 提示，等用户自己输
        hooks.sensitiveNotice?.(decision.question);
        hooks.phase('paused', '等你输入敏感信息（值不经 AI、不落库）');
      } else {
        hooks.emit({ kind: 'ask', reason: decision.reason, question: decision.question });
        hooks.phase('paused', `ask：${decision.question.slice(0, 40)}`);
      }
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return finish('ask_user');
    }

    if (decision.kind === 'done') {
      await hooks.taskStep(taskId, `收尾：${decision.summary}`, true).catch(() => undefined);
      let docInfo: { unreadHint?: string; docReady?: boolean } | undefined;
      if (taskId !== null && hooks.taskFinish) {
        const snap = lastSnapshot;
        const pagePoints = snap
          ? [`url: ${snap.url}`, `title: ${snap.title}`, ...(snap.buttons ?? []).slice(0, 8).map((b) => `按钮：${b}`)]
          : [];
        try {
          docInfo = await hooks.taskFinish(
            taskId,
            {
              summary: decision.summary,
              document_title: decision.document_title,
              document_outline: decision.document_outline,
            },
            pagePoints,
          );
        } catch {
          docInfo = undefined; // 收尾失败不吞掉“完成”本身：聊天照报结论
        }
        if (!docInfo) await hooks.taskStatus(taskId, 'done').catch(() => undefined);
      } else {
        await hooks.taskStatus(taskId, 'done').catch(() => undefined);
      }
      hooks.emit({
        kind: 'done',
        summary: decision.summary,
        documentTitle: decision.document_title,
        documentOutline: decision.document_outline,
        docReady: docInfo?.docReady ?? false,
        unreadHint: docInfo?.unreadHint,
      });
      hooks.phase('done', `完成 — ${decision.summary.slice(0, 40)}`);
      return finish('done');
    }

    // ---- 到这里一定是 {kind:'tool'}：执行它 ----
    if (decision.text) hooks.emit({ kind: 'note', level: 'info', text: decision.text });
    const action = toolToAction(decision.call);
    if (!action) {
      result = { ok: false, error: `这个工具本机不认识：${decision.call.name}`, refused: '未知工具，未执行' };
      continue;
    }

    let res: DriveResult;
    try {
      // 第 21 步：给「手」加超时 —— 任何一次执行挂住都不能把整条循环带走（见 EXEC_TIMEOUT_MS）
      res = await Promise.race([
        hooks.exec(action),
        new Promise<DriveResult>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: false,
                action: action.action,
                error: `这一步 ${EXEC_TIMEOUT_MS / 1000} 秒没有完成（页面可能卡住了或一直没加载完）`,
              }),
            EXEC_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      res = { ok: false, action: action.action, error: (err as Error).message };
    }
    if (hooks.aborted()) return 'aborted';
    if (res.pageSnapshot) lastSnapshot = res.pageSnapshot;

    step += 1;
    const summary = `步 ${step}：${label(action)}${res.detail ? ` —— ${res.detail}` : ''}${
      res.ok ? '' : `；失败：${res.error ?? '未知原因'}`
    }`;
    hooks.emit({ kind: 'step', step, summary, ok: res.ok });
    await hooks.taskStep(taskId, summary, res.ok).catch(() => undefined);

    if (res.ok) {
      if (res.noChange) {
        // 动作执行了，但地址/标题/节点数都没动 —— 多半没点中、被弹层挡住，或这颗按钮只是唤起手机 App
        staleClicks += 1;
        if (staleClicks === FAILS_BEFORE_ASK) {
          hooks.emit({
            kind: 'note',
            level: 'info',
            text: '点了两次页面都没有可见变化：可能没点中、被弹层挡住，或者这颗按钮只是用来唤起手机 App。我再试一次，不行就停下来问你。',
          });
        }
        if (staleClicks >= STALE_BEFORE_ASK) {
          hooks.emit({
            kind: 'ask',
            reason: 'no_page_change',
            question:
              `连着 ${STALE_BEFORE_ASK} 次点了页面都没动静（最后一次：${summary.replace(/\s+/g, ' ').slice(0, 200)}）。我不再盲点了，给你两条路：` +
              '① 这一页可能需要你先登录，或者这颗按钮只是「打开手机 App」（网页里点不了）——那就在卡片里换一个能在网页里完成的操作；' +
              '② 把按钮上的准确文字告诉我，我再试一次；或者你自己在卡片里点一下，然后点「继续」——我会先读你当前停留的页面再接着做。',
          });
          hooks.phase('paused', '连点三次页面无变化，等用户指导');
          await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
          return finish('stuck');
        }
        result = toResult(res);
        continue;
      }
      staleClicks = 0;
      fails = 0;
      result = toResult(res);
      continue;
    }

    // 搜索兜底：type 找不到输入框时不要空转两次再放弃 —— 直接开搜索结果页，一步到位。
    // （只对"目标是搜索"生效：从 goal 里抠得出关键词才走这条路。）
    if (action.action === 'type' && NO_INPUT_FOUND.test(res.error ?? '')) {
      const kw = searchKeyword(goal);
      if (kw) {
        const url = searchUrl(kw);
        hooks.emit({ kind: 'note', level: 'info', text: `没找到输入框，改用搜索结果页直接搜「${kw}」：${url}` });
        const fallback = await hooks.exec({ action: 'open_url', url });
        if (fallback.pageSnapshot) lastSnapshot = fallback.pageSnapshot;
        const fbSummary = `步 ${step}（搜索兜底）：打开 ${url}${fallback.ok ? ' —— 已跳转' : `；失败：${fallback.error ?? '未知原因'}`}`;
        hooks.emit({ kind: 'step', step, summary: fbSummary, ok: fallback.ok });
        await hooks.taskStep(taskId, fbSummary, fallback.ok).catch(() => undefined);
        result = toResult(fallback);
        if (fallback.ok) {
          fails = 0;
          staleClicks = 0;
        } else {
          fails += 1;
        }
        continue;
      }
    }

    fails += 1;
    if (fails >= FAILS_BEFORE_ASK) {
      // 连败两次，第三次不许再盲试——本地兜底直接转 ask。
      // 必须给「可能原因 + 一个明确的下一步」，不能退回「是否确认打开某某网站」。
      const detail = (res.error ?? '原因未知').replace(/\s+/g, ' ').slice(0, 240);
      const q =
        `连着两步都没成（最后一次：${detail}）。我不再瞎点了，给你两条路：` +
        '① 把按钮上的准确文字告诉我，我再试一次；② 你自己在卡片里点一下，然后点「继续」——' +
        '我会先读你当前停留的页面再接着做，不会从头再来。';
      hooks.emit({ kind: 'ask', reason: 'consecutive_failures', question: q });
      hooks.phase('paused', '连续失败两次，等用户指导');
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return finish('stuck');
    }
    result = toResult(res);
  }
}
