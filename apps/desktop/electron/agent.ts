/**
 * 第 7 步：云端驾驶员循环（跑在 Electron 主进程；这里刻意不 import electron，
 * 全部依赖注入 —— main.ts 负责接线，单测直接喂假实现）。渲染进程绝不直连 CDP。
 *
 * 循环顺序（说明书钉死的，别发明第二套）：
 *   read_page 当前真实页 → POST /agent/next-action（带第 5 步 JWT）→ 拿【一个】动作
 *   → 交现有 driver 执行 → 记一步人话摘要 → 再读页 → 再问……直到 done / ask_user / 用户暂停。
 *
 * 硬保证（本地先停，再同步服务端）：
 *   - 每步开头与执行后都查暂停；暂停后绝不点、绝不问下一步，并把 paused 同步给 tasks 表；
 *   - 「继续」= 重启本循环：第一步永远是重新 read_page，按当前真实页面决策，不重放旧动作；
 *   - 同一动作连续失败 2 次 → 第 3 次不再盲试，本地直接转 ask_user；
 *   - 模型/网络/未配置错误 → 明确 note + failed，绝不假装有动作；
 *   - 记步只存一行人话摘要，整页 HTML/快照绝不出现在 steps 里。
 */
import type { AgentActionResponse, AgentEventPayload, BrowserAction, DriveResult, PageSnapshot } from '@ai-workbench/shared';

export interface AgentLoopHooks {
  /** 问云端要下一步；实现方负责带 JWT。出错请 throw（带人话 message） */
  nextAction(body: {
    taskId: number | null;
    goal: string;
    stepsSummary: string[];
    snapshot: PageSnapshot;
  }): Promise<AgentActionResponse>;
  /** 现有 driver.ts 的单动作执行器 */
  exec(action: BrowserAction): Promise<DriveResult>;
  /** 当前页面快照（内部走 read_page） */
  readSnapshot(): Promise<PageSnapshot>;
  /** 用户是否已接管（暂停标志）——循环每步都查 */
  isPaused(): boolean;
  /** 循环是否已作废（reset / stop / 被新任务顶掉） */
  aborted(): boolean;
  /** 向渲染进程广播（'agent' 事件）；实现方 JSON 序列化并发送 */
  emit(payload: AgentEventPayload): void;
  /**
   * 第 9 步：敏感字段等待态——实现方负责【窗口前置+聚焦已完成（exec 做过）】、
   * 启动自动恢复观察、并在“用户输完提交/手动继续/回答资料”任一信号时 resolve。
   * 循环 await 它：醒来后下一轮第一件事仍是 read_page（当前真实页），不重放旧步骤。
   */
  sensitiveHold?(): Promise<void>;
  /** 第 9 步：取走用户对「补资料」提问的回答（一次性，取完即清） */
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

export const MAX_AGENT_STEPS = 16;
const FAILS_BEFORE_ASK = 2;

type ExecutableAction = Extract<
  BrowserAction,
  { action: 'open_url' | 'click' | 'type' | 'scroll' | 'wait' | 'fill_form' }
>;

const REASON_CN: Record<string, string> = {
  password: '密码',
  otp_guess: '验证码/动态口令',
  payment_guess: '支付信息',
  id_guess: '身份证号',
};

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
    case 'wait':
      return `等 ${a.seconds} 秒`;
    case 'ask_user':
      return '请你指导';
    case 'done':
      return '完成任务';
    case 'fill_form':
      return `代填 ${a.fields.length} 项普通资料`;
    case 'focus_sensitive_field':
      return '定位敏感输入框（等你输入）';
    default:
      return String((a as { action: string }).action);
  }
}

/** 「找不到输入框」类失败：模型给的 target 对不上页面上任何输入框 */
const NO_INPUT_FOUND = /没找到可输入的输入框|找不到.{0,6}输入框/;

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
 */
function searchUrl(keyword: string): string {
  return `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`;
}

/** 跑一整轮驾驶循环；返回结束原因（给 main.ts 记日志用，不进渲染层） */
export async function runAgentLoop(goal: string, hooks: AgentLoopHooks): Promise<string> {
  const steps: string[] = [];
  let taskId: number | null = null;
  try {
    taskId = await hooks.taskStart(goal);
  } catch {
    taskId = null; // 记账失败不拦驾驶
  }
  let fails = 0;
  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    if (hooks.aborted()) return 'aborted';
    if (hooks.isPaused()) {
      // 本地已经停手了，这里只补同步
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return 'paused';
    }
    // 第 9 步：把用户对上一轮提问的回答并进上下文（只进 stepsSummary，不落任何库）
    if (hooks.takeAnswers) {
      for (const a of hooks.takeAnswers()) steps.push(`用户答复：${a}`);
    }
    let snap: PageSnapshot;
    try {
      snap = await hooks.readSnapshot(); // 第 3 拍：每轮先看页（继续时也走这里，绝不重放旧步）
    } catch (err) {
      const msg = `读不到内嵌页：${(err as Error).message}。循环已停止，没有执行任何动作。`;
      hooks.emit({ kind: 'note', level: 'error', text: msg });
      hooks.phase('failed', msg);
      await hooks.taskStatus(taskId, 'failed').catch(() => undefined);
      return 'read_failed';
    }
    let next: AgentActionResponse;
    try {
      next = await hooks.nextAction({ taskId, goal, stepsSummary: steps.slice(-12), snapshot: snap });
    } catch (err) {
      const msg = `问不到下一步：${(err as Error).message}`;
      hooks.emit({ kind: 'note', level: 'error', text: msg });
      hooks.phase('failed', msg);
      await hooks.taskStatus(taskId, 'failed').catch(() => undefined);
      return 'brain_failed';
    }
    if (hooks.aborted()) return 'aborted';
    if (hooks.isPaused()) {
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return 'paused';
    }
    const action = next.action;
    steps.push(`步 ${step}：模型选「${label(action)}」`);

    if (action.action === 'ask_user') {
      hooks.emit({ kind: 'ask', reason: action.reason, question: action.question });
      hooks.phase('paused', `ask_user：${action.question.slice(0, 40)}`);
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return 'ask_user';
    }
    if (action.action === 'done') {
      await hooks.taskStep(taskId, `步 ${step}：done（${action.summary}）`, true).catch(() => undefined);
      // 第 8 步：先让服务端把文档/红点做好（taskStatus done 由 finish 端点顺手置）；
      // 页面要点只给标题/按钮级信息——整页 HTML 不进整理、不进库。
      let docInfo: { unreadHint?: string; docReady?: boolean } | undefined;
      if (taskId !== null && hooks.taskFinish) {
        const pagePoints = [`url: ${snap.url}`, `title: ${snap.title}`, ...(snap.buttons ?? []).slice(0, 8).map((b) => `按钮：${b}`)];
        try {
          docInfo = await hooks.taskFinish(
            taskId,
            { summary: action.summary, document_title: action.document_title, document_outline: action.document_outline },
            pagePoints,
          );
        } catch {
          docInfo = undefined; // 收尾失败不吞掉“完成”本身：聊天照报结论
        }
        if (!docInfo) {
          await hooks.taskStatus(taskId, 'done').catch(() => undefined);
        }
      } else {
        await hooks.taskStatus(taskId, 'done').catch(() => undefined);
      }
      hooks.emit({
        kind: 'done',
        summary: action.summary,
        documentTitle: action.document_title,
        documentOutline: action.document_outline,
        docReady: docInfo?.docReady ?? false,
        unreadHint: docInfo?.unreadHint,
      });
      hooks.phase('done', `完成 — ${action.summary.slice(0, 40)}`);
      return 'done';
    }

    if (action.action === 'focus_sensitive_field') {
      // 第 9 步敏感流程：定位聚焦 → paused → 等“输完自动继续”信号（watch 或手动兜底）
      try {
        await hooks.exec(action as never);
      } catch {
        /* 定位失败也进入等待：用户看得见页面，输完照样能手动继续 */
      }
      steps.push(`步 ${step}：定位敏感输入框（${action.fieldReason}），等用户输入`);
      await hooks.taskStep(taskId, `步 ${step}：已定位敏感输入框，等用户输入（值不经 AI、不落库）`, true).catch(() => undefined);
      hooks.phase('paused', `等待用户输入${REASON_CN[action.fieldReason] ?? '敏感信息'}——输完会自动继续`);
      hooks.emit({
        kind: 'sensitive',
        fieldReason: action.fieldReason,
        message: `需要你输入${REASON_CN[action.fieldReason] ?? '敏感信息'}，浏览器已帮你前置并定位到输入框；输完并提交后我会自动继续（我不会碰这个框，也不会读它的内容）。`,
      });
      if (hooks.sensitiveHold) {
        await hooks.sensitiveHold();
        if (hooks.aborted()) return 'aborted';
        hooks.phase('running', `敏感输入完成，按当前页面继续：${goal.slice(0, 30)}`);
        continue; // 下一轮第一件事 = read_page 当前真实页
      }
      return 'paused';
    }

    let res: DriveResult;
    try {
      res = await hooks.exec(action as ExecutableAction); // 第 5 拍：本地执行这【一个】动作
    } catch (err) {
      res = { ok: false, action: action.action, error: (err as Error).message };
    }
    if (hooks.aborted()) return 'aborted';
    const summary = `步 ${step}：${label(action)}${res.detail ? ` —— ${res.detail}` : ''}${res.ok ? '' : `；失败：${res.error ?? '未知原因'}`}`;
    steps.push(summary);
    hooks.emit({ kind: 'step', step, summary, ok: res.ok });
    await hooks.taskStep(taskId, summary, res.ok).catch(() => undefined);
    if (res.ok) {
      fails = 0;
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
        const fbSummary = `步 ${step}（搜索兜底）：打开 ${url}${fallback.ok ? ' —— 已跳转' : `；失败：${fallback.error ?? '未知原因'}`}`;
        steps.push(fbSummary);
        hooks.emit({ kind: 'step', step, summary: fbSummary, ok: fallback.ok });
        await hooks.taskStep(taskId, fbSummary, fallback.ok).catch(() => undefined);
        if (fallback.ok) {
          fails = 0;
          continue;
        }
        res = fallback;
      }
    }

    fails += 1;
    if (fails >= FAILS_BEFORE_ASK) {
      // 说明书第 11 条：连败两次，第三次不许再盲点——本地兜底直接转 ask_user
      const q = `连着两步都没成（最后一次：${res.error ?? '原因未知'}）。我不想瞎点了，请你指导一下：告诉我点哪里，或者你手动操作后点「继续」。`;
      hooks.emit({ kind: 'ask', reason: 'consecutive_failures', question: q });
      hooks.phase('paused', '连续失败两次，等用户指导');
      await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
      return 'stuck';
    }
  }
  const q = `步数到上限（${MAX_AGENT_STEPS} 步）还没做完，先停下来。要我继续的话点「继续」，或告诉我下一步。`;
  hooks.emit({ kind: 'ask', reason: 'step_budget', question: q });
  hooks.phase('paused', q);
  await hooks.taskStatus(taskId, 'paused').catch(() => undefined);
  return 'budget';
}
