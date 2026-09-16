import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  drive,
  setDrivingPaused,
  setTaskListener,
  getTaskState,
  startTask,
  pauseTask,
  resumeTask,
  resetTask,
  takeoverRun,
  setExternalPhase,
  isDrivingPaused,
} from './driver';
import { runAgentLoop } from './agent';
import { startSensitiveAutoResume } from './driver';
import type {
  AgentActionResponse,
  AgentEventPayload,
  BrowserAction,
  PageSnapshot,
} from '@ai-workbench/shared';

/**
 * Electron 主进程 —— 只有它能碰 Node / 系统能力。
 * 渲染进程跑在独立沙箱里，通过 preload 暴露的白名单通道通信。
 */

/** 开发模式下 Vite Dev Server 的地址（与 vite.config.ts 的 server.port 保持一致）。
 * 打包后的 app.isPackaged=true，即使用户环境里意外留有 VITE_DEV_SERVER_URL，
 * 也必须加载安装包内的 dist/index.html，而不是依赖 npm run dev 的 Vite。 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !app.isPackaged && Boolean(DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

/** 只允许 http(s) —— 其余协议（bytedance: / snssdk / itms-apps: / market: …）一律不进导航 */
const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * 第 20 步：一个智能体 = 一套独立浏览器环境。
 *
 * 渲染层的 <webview> 用 `partition="persist:workbench-browser-agent-<agentId>"`，
 * Electron 会把这个分区落到 `<userData>/Partitions/<分区名>/` —— 这天然就是
 * 「每个 bot 在 userData 下有自己的子目录」（cookie / localStorage / 站点数据全在里面）。
 *
 * 这里额外做一件渲染层做不到的事：**把下载也按智能体分开**。
 * ⚠️ 主进程 import 不到渲染层代码，所以分区命名规则在这里是**同规则的第二份**
 * （渲染层见 apps/desktop/src/browser/url.ts 的 partitionFor），**改一处要同时改两处**。
 */
const AGENT_PARTITION_RE = /workbench-browser-agent-(\d+)/;

/** 已经挂过 will-download 的分区（同一个分区可能被多次 attach，别重复挂） */
const downloadHooked = new Set<string>();

/** 某个智能体自己的下载目录（不存在就建出来） */
function agentDownloadDir(agentId: number): string {
  const dir = path.join(app.getPath('userData'), 'browser-agents', String(agentId), 'downloads');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[download] 建目录失败：', (error as Error).message);
  }
  return dir;
}

/**
 * 给「某个智能体的浏览器分区」挂下载落盘规则：文件直接进它自己的 downloads 目录，
 * 不弹系统「另存为」，也不会串到别的智能体那儿。
 * 认不出分区的（例如主窗口自己那个默认 session）一律不管。
 */
function hookAgentDownloads(contents: WebContents): void {
  const ses = contents.session;
  const storage = ses.getStoragePath() ?? '';
  const m = AGENT_PARTITION_RE.exec(storage);
  if (!m) return;
  if (downloadHooked.has(storage)) return;
  downloadHooked.add(storage);
  const agentId = Number(m[1]);
  ses.on('will-download', (_event, item) => {
    const savePath = path.join(agentDownloadDir(agentId), item.getFilename());
    item.setSavePath(savePath);
    console.log(`[download] 智能体 ${agentId} 的下载落到：${savePath}`);
  });
}

/**
 * 内嵌页不允许创建新窗口：点击 target=_blank / window.open 时，改为让**同一个 guest**导航。
 *
 * 这是用户在卡片里手点搜索结果、帮助链接时的必要行为；若只简单 deny，页面看起来就会“点了没反应”。
 * 全程没有 BrowserWindow，也不会打开系统 Edge / Chrome。
 *
 * 第 17 步「拦住系统弹窗」：
 *   - window.open / target=_blank 的非 http(s) 请求：直接忽略（不交给系统，不弹「获取打开此链接的应用」）；
 *   - **整页跳转**到非 http(s)：用 will-navigate / will-redirect / will-frame-navigate 拦下并留在当前页。
 *     抖音那类站点的「打开 App / bytedance://」按钮就是走这条路，不拦就会把当前页冲掉、
 *     甚至弹出 Windows 的「获取打开此链接的应用」系统框。
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  // 第 20 步：这个内嵌页属于哪个智能体，它的下载就落到那个智能体自己的目录
  hookAgentDownloads(contents);

  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      // 必须放到下一个 tick 再导航：在处理函数里同步 loadURL 会和这次 window.open
      // 的处理流程打架，导航经常被丢弃，表现就是“点了没反应”。
      setImmediate(() => {
        if (!contents.isDestroyed()) {
          void contents.loadURL(url).catch((error) => {
            console.warn('[webview] 在当前内嵌页打开链接失败：', error.message);
          });
        }
      });
    } else {
      console.warn('[webview] 已拦下非 http(s) 的 window.open（不弹系统框、不新开窗口）：', url);
    }
    return { action: 'deny' };
  });

  // 整页导航到自定义协议 → 取消，留在当前页
  contents.on('will-navigate', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    console.warn('[webview] 已拦截非 http(s) 跳转，留在当前页：', url);
  });
  // 3xx 重定向到自定义协议 → 同样取消
  contents.on('will-redirect', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    console.warn('[webview] 已拦截非 http(s) 重定向，留在当前页：', url);
  });
  // 子框架（iframe / 广告位）里的跳转也要拦，否则照样能唤起系统
  contents.on('will-frame-navigate', (details: unknown) => {
    const d = details as { url?: string; preventDefault?: () => void } | undefined;
    const url = d?.url ?? '';
    if (!url || isHttpUrl(url)) return;
    d?.preventDefault?.();
    console.warn('[webview] 已拦截子框架的非 http(s) 跳转：', url);
  });

  /**
   * 第 17 步：让内嵌页更像普通 Chrome 桌面。
   * 只做两件最小的事（不上整套指纹方案）：
   *   1. UA 由 app.userAgentFallback 去掉 Electron/<版本> 与产品名 token（见文件末尾的设置）；
   *   2. 页面里若没有 window.chrome，补一个空对象——不少站点的「是不是真 Chrome」检测就认这个。
   */
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return;
    void contents
      .executeJavaScript(
        `(() => {
          try {
            if (!window.chrome) {
              Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
            }
          } catch (_) {}
          return true;
        })()`,
      )
      .catch(() => {
        /* 页面脚本被禁之类的情况：不影响驾驶，忽略 */
      });
  });
});

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'AI 工作台',
    backgroundColor: '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // ---- 安全桥三件套 ----
      // 1. preload 独立上下文，渲染进程拿不到 require / process
      preload: path.join(__dirname, 'preload.js'),
      // 2. 渲染进程与 preload 隔离在不同 JS 上下文
      contextIsolation: true,
      // 3. 禁用 Node 集成
      nodeIntegration: false,
      // 额外：开启 Chromium 沙箱
      sandbox: true,
      webSecurity: true,
      // 4. 允许渲染层使用 <webview> 内嵌真实网页（工作台浏览器区域）
      webviewTag: true,
    },
  });

  // 等首帧渲染完再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 任何 window.open / 外链都交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 第 17 步：只有 http(s) 才交给系统浏览器。自定义协议（bytedance: / market: …）
    // 丢给 shell 会弹出 Windows 的「获取打开此链接的应用」——正是要拦掉的那个系统框。
    if (isHttpUrl(url)) void shell.openExternal(url);
    else console.warn('[main] 已拦下非 http(s) 的外链（不弹系统框）：', url);
    return { action: 'deny' };
  });

  // 禁止渲染进程被导航到外部站点（防止钓鱼 / 劫持）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_SERVER_URL!)) return;
    event.preventDefault();
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ---------------------------------------------------------------------------
// 内嵌浏览器区域（工作台浏览器）
//
// 注意：这里**不再创建任何 BrowserWindow**。
// 网页由渲染层的 <webview partition="persist:workbench-browser-agent-<agentId>"> 承载
// （第 20 步：按智能体分区，一个智能体一套 cookie / 登录态），
// 主进程只做一件事：把渲染进程发来的指令原样转发回去，由渲染层决定显示 / 隐藏 / 聚焦。
//
// 这样做的原因：浏览器区域是主窗口界面的一部分（右侧那一栏），
// 用独立窗口反而要多维护一套窗口生命周期（位置、还原、关闭、焦点竞争）。
// ---------------------------------------------------------------------------
function sendToMainWindow(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// IPC：渲染进程只能走这里注册的通道，preload 里再做一层白名单收敛
// ---------------------------------------------------------------------------
ipcMain.handle('app:ping', () => `pong from electron ${process.versions.electron}`);

// 第 2 步（内嵌版）：主窗口渲染进程 -> 主进程 -> 主窗口渲染进程
// 绕一圈的意义：显示 / 隐藏这类 UI 指令将来可能来自任务系统、快捷键或主进程侧逻辑，
// 统一从主进程走，渲染层只需要订阅。
ipcMain.handle('workbench:open', (_event, url?: string) => {
  sendToMainWindow('workbench:browser:open', url);
});

ipcMain.handle('workbench:show', () => {
  sendToMainWindow('workbench:browser:show');
});

ipcMain.handle('workbench:hide', () => {
  sendToMainWindow('workbench:browser:hide');
});

ipcMain.handle('workbench:focus', () => {
  sendToMainWindow('workbench:browser:focus');
});

// ---------------------------------------------------------------------------
// 第 3 步：本地驾驶（遥控器先通）
//
// 渲染进程把「一个动作」丢过来，主进程在内嵌 webview 的 guest webContents 上
// 用 debugger / CDP 执行，再把 { ok, pageSnapshot } 原样回给渲染层。
// 渲染进程全程碰不到 BrowserWindow / webContents / debugger，只认 preload 白名单。
// ---------------------------------------------------------------------------
ipcMain.handle(
  'workbench:drive',
  (_event, action: BrowserAction, targetWebContentsId?: number) =>
    drive(action, targetWebContentsId),
);

ipcMain.handle('workbench:read-page', (_event, targetWebContentsId?: number) =>
  drive({ action: 'read_page' }, targetWebContentsId),
);

// 暂停 / 恢复驾驶：暂停后 click / type 会被执行器拒绝，页面交还给用户手动点
// （第 4 步起与状态机同进同退：setDrivingPaused 内部就是 applyPaused）
ipcMain.handle('workbench:pause-driving', (_event, value: boolean) => setDrivingPaused(value));

// ---------------------------------------------------------------------------
// 第 4 步：任务状态机（idle | running | paused | done | failed）
//
// 权威状态在主进程 driver.ts；这里只做两件事：
//   1. 收渲染层的四个指令（start / pause / resume / reset）+ 一个初始读取；
//   2. 状态一变就广播 'workbench:browser:state'，渲染层横幅「AI 正在控制 / 你正在控制」
//      只是镜像——按钮与聊天框谁按下的都不影响"以主进程为准"这一条。
// ---------------------------------------------------------------------------
setTaskListener((state) => {
  sendToMainWindow('workbench:browser:state', JSON.stringify(state));
});

ipcMain.handle('workbench:task:start', () => startTask());
ipcMain.handle('workbench:task:pause', () => pauseTask());
// 第 7 步：有挂起的驾驶员任务时，「继续」= 重启 AI 循环（第一步仍是 read_page，按当前页决策，
// 不重放旧动作）；没有则维持第 4 步 demo 语义。
// 第 17 步：两路并行时「继续」= 把**所有**挂起的那几路一起重新发车（每路各读自己那张页）。
ipcMain.handle('workbench:task:resume', () => {
  // 第 9 步：敏感等待中点「继续」= 手动兜底唤醒（和自动信号走同一条路）
  if (anyLaneWaiting()) {
    notifyAllResume();
    return getTaskState();
  }
  const paused = [...pendingGoals.keys()];
  if (paused.length > 0) {
    for (const wcId of paused) {
      const goal = pendingGoals.get(wcId);
      if (goal) startAgentLoop(wcId, goal, false);
    }
    return getTaskState();
  }
  return resumeTask();
});
ipcMain.handle('workbench:task:reset', () => {
  abortAllLanes();
  notifyAllResume();
  pendingGoals.clear();
  pendingAnswers.clear();
  return resetTask();
});
ipcMain.handle('workbench:task:state', () => getTaskState());

// ---------------------------------------------------------------------------
// 第 7 步：云端驾驶员「一步一问」循环的编排层（就在主进程；渲染进程不直连 CDP）
//   - 调后端 /agent/next-action 要带第 5 步 JWT——token 只存在这里（内存），绝不打印全文；
//   - 执行永远走现有 driver.ts；暂停由 driver 的 paused 闸 + 循环自查双保险；
//   - API Key 不经过这里：它只在 apps/server/.env。
// ---------------------------------------------------------------------------
/**
 * 第 20 步：**并发驾驶不再有硬顶**（原来的 `MAX_LANES = 10` 已删）。
 *
 * 旧行为是「第 11 路直接拒绝」，它按活页数算，会变成「页能开 30 张、第 11 张一发车就被拒」，
 * 与本步「取消活页硬顶」相反。现在只保留一条语义：
 * **同一张页同一时间只有一路**（这张页上的新指令 → 覆盖旧目标，最新指令优先）。
 *
 * 卡顿是本步明确接受的已知代价（页多、路多就是会卡），不再靠拒绝/关页来「治」。
 */

/**
 * 一路驾驶 = **一张内嵌页** + 一个目标 + 自己那一份循环状态。
 *
 * 第 16 步之前这些都是全局单例（agentEpoch / agentGoal / sensitiveWaiters …），
 * 因为全窗口只有一张 webview。第 17 步要两路同时跑，就必须按 **guest webContents id** 拆开：
 *   - 同一张页上的新指令 → 覆盖这一路的旧指令（第 16 步「最新指令优先」的忠实推广）；
 *   - 不同页上的指令 → 互不打扰（第二句不会把第一张降级成不能动的占位）。
 */
interface Lane {
  wcId: number;
  goal: string;
  /** 被作废（新指令顶掉 / 用户放下 / 登出）时置 true，循环在下一个检查点自己退出 */
  aborted: boolean;
  running: boolean;
  /** 敏感输入等待：loop 挂在 promise 上；自动恢复 watch / 手动继续 / 用户答复 都来唤醒 */
  waiters: Array<() => void>;
  stopWatch: (() => void) | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** 这一路正在聊天里等用户答复（答复只喂给它，不串到别路） */
  awaiting: boolean;
  answers: string[];
}

/** 正在跑的那几路 */
const lanes = new Map<number, Lane>();
/** 跑完一段但还没结束的那几路（ask_user / 暂停 / 步数上限）：留着目标等「继续」或答复 */
const pendingGoals = new Map<number, string>();
/** 用户答复按「哪张页」分开暂存 */
const pendingAnswers = new Map<number, string[]>();

let agentApiBase = 'http://127.0.0.1:8787';
let agentJwt = '';

function anyLaneWaiting(): boolean {
  for (const lane of lanes.values()) if (lane.waiters.length > 0) return true;
  return false;
}

/** 唤醒**这一路**挂着的等待（敏感输入 / 答复） */
function notifyResume(lane: Lane): void {
  if (lane.stopWatch) {
    lane.stopWatch();
    lane.stopWatch = null;
  }
  if (lane.holdTimer) {
    clearTimeout(lane.holdTimer);
    lane.holdTimer = null;
  }
  const waiters = lane.waiters;
  lane.waiters = [];
  for (const resolve of waiters) resolve();
}

function notifyAllResume(): void {
  for (const lane of [...lanes.values()]) notifyResume(lane);
}

function abortAllLanes(): void {
  for (const lane of [...lanes.values()]) {
    lane.aborted = true;
    lane.running = false;
    notifyResume(lane);
  }
  lanes.clear();
}

/** 敏感等待态（第 9 步语义保留，第 17 步按路隔离）：前置窗口 + 聚焦**这一路那张页** + 挂自动恢复观察 */
function sensitiveHold(lane: Lane): Promise<void> {
  mainWindow?.show();
  mainWindow?.focus();
  // 渲染层：把焦点交给这一路那张页（两路并行时必须点名，不能瞎给）
  sendToMainWindow('workbench:browser:focus', String(lane.wcId));
  lane.stopWatch = startSensitiveAutoResume(() => notifyResume(lane), lane.wcId);
  // 2 分钟还没动静：提示手动兜底，等待继续挂着（不算失败，只是没自动化）
  lane.holdTimer = setTimeout(() => {
    emitAgent({
      kind: 'note',
      level: 'info',
      text: '没检测到页面变化。若你已完成输入并提交，点「继续」即可恢复驾驶。',
    });
  }, 120_000);
  return new Promise<void>((resolve) => {
    lane.waiters.push(resolve);
  });
}

/**
 * 第 17 步：事件里带上 wcId —— 两路可能属于不同智能体，
 * 渲染层靠它把步摘要/问话/结论落回**发起时那个智能体**的聊天里，绝不串。
 */
function emitAgent(payload: AgentEventPayload, wcId?: number): void {
  sendToMainWindow('workbench:browser:agent', JSON.stringify(wcId === undefined ? payload : { ...payload, wcId }));
}

async function agentPost<T>(path: string, body: unknown): Promise<T> {
  if (!agentJwt) throw new Error('没有可用的登录凭证（请先在窗口里登录）');
  let res: Response;
  try {
    res = await fetch(`${agentApiBase.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentJwt}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`连不上后端 ${agentApiBase}：${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    const code = (data as { code?: string }).code;
    if (code === 'llm_not_configured') throw new Error('未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server');
    if (res.status === 401) throw new Error('登录已过期：重新登录后再点「继续」');
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 第 17 步：在某一张内嵌页上发车（或改道）。
 *
 * - 这张页上已经有一路在跑 → **最新指令优先**：旧循环作废，用新目标重发（第一步仍是 read_page）；
 * - 这张页上没有 → 新起一路（第 20 步起**没有路数上限**，不再拒绝）；
 * - 别路（别的页）**完全不动** —— 第二句不会把第一张降级成不能动的占位。
 */
function startAgentLoop(wcId: number, goal: string, fresh: boolean): ReturnType<typeof getTaskState> {
  const prev = lanes.get(wcId);
  if (prev) {
    prev.aborted = true;
    prev.running = false;
    notifyResume(prev);
  }

  const lane: Lane = {
    wcId,
    goal,
    aborted: false,
    running: true,
    waiters: [],
    stopWatch: null,
    holdTimer: null,
    awaiting: false,
    answers: pendingAnswers.get(wcId) ?? [],
  };
  pendingAnswers.delete(wcId);
  pendingGoals.set(wcId, goal);
  lanes.set(wcId, lane);

  const detail = fresh
    ? `AI 驾驶中 · 任务：${goal.slice(0, 36)}`
    : `继续任务（先读当前页）：${goal.slice(0, 36)}`;
  const state = takeoverRun(lanes.size > 1 ? `${lanes.size} 路驾驶中 · 本路任务：${goal.slice(0, 30)}` : detail);

  void runAgentLoop(goal, {
    nextAction: (body: { taskId: number | null; goal: string; stepsSummary: string[]; snapshot: PageSnapshot }) =>
      agentPost<AgentActionResponse>('/agent/next-action', body).then((r) => {
        if (!r || typeof (r.action as { action?: string })?.action !== 'string') throw new Error('大脑回了畸形 JSON');
        return r;
      }),
    // 第 17 步：动作一律打到**这一路自己的那张页**上（两路并行时绝不能盲选 guest）
    exec: (action) => drive(action, wcId),
    readSnapshot: async () => {
      const r = await drive({ action: 'read_page' }, wcId);
      if (!r.ok || !r.pageSnapshot) throw new Error(r.error ?? 'read_page 没拿到快照');
      return r.pageSnapshot;
    },
    isPaused: () => isDrivingPaused(),
    aborted: () => lane.aborted,
    emit: (payload) => {
      if (payload.kind === 'ask' || payload.kind === 'sensitive') lane.awaiting = true;
      emitAgent(payload, wcId);
    },
    phase: setExternalPhase,
    taskStart: async (g) => {
      try {
        const r = await agentPost<{ taskId: number }>('/agent/task/start', { goal: g });
        return typeof r.taskId === 'number' ? r.taskId : null;
      } catch {
        return null; // 记账失败不拦驾驶
      }
    },
    taskStep: async (id, summary, ok) => {
      if (id === null) return;
      await agentPost('/agent/task/step', { taskId: id, summary, ok }).catch(() => undefined);
    },
    taskStatus: async (id, status) => {
      if (id === null) return;
      await agentPost('/agent/task/status', { taskId: id, status }).catch(() => undefined);
    },
    sensitiveHold: () => sensitiveHold(lane),
    takeAnswers: () => {
      const list = lane.answers;
      lane.answers = [];
      lane.awaiting = false;
      return list;
    },
    // 第 8 步：done 收尾（服务端整理文档 + unread=true + 调通知桩；这里失败不卡 done）
    taskFinish: async (id, doneBits, pagePoints) => {
      const r = await agentPost<{ unreadHint?: string; docTitle?: string }>('/agent/task/finish', {
        taskId: id,
        summary: doneBits.summary,
        document_title: doneBits.document_title,
        document_outline: doneBits.document_outline,
        pagePoints,
      });
      return { unreadHint: r.unreadHint, docReady: Boolean(r.docTitle) };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
    .then((reason) => finishLane(lane, reason))
    .catch((err) => {
      // 循环本体不抛穿（内部都 catch 了）；真到这就是编程错误，也得说人话而不是崩
      console.error('[agent] 循环异常：', err);
      emitAgent({ kind: 'note', level: 'error', text: `驾驶员内部错误：${(err as Error).message}` }, wcId);
      setExternalPhase('failed', `驾驶员内部错误 — ${(err as Error).message}`);
      finishLane(lane, 'brain_failed');
    });
  return state;
}

/** 一路循环收尾：从运行表里摘掉，并按剩余路数决定全局状态机怎么显示 */
function finishLane(lane: Lane, reason: string): void {
  lane.running = false;
  notifyResume(lane);
  if (lanes.get(lane.wcId) === lane) lanes.delete(lane.wcId);
  console.log(`[agent] 第 ${lane.wcId} 路循环结束：${reason}`);
  if (lane.aborted) {
    pendingGoals.delete(lane.wcId); // 被新指令顶掉：旧目标不再提起
    return;
  }
  if (reason === 'done' || reason === 'read_failed' || reason === 'brain_failed') {
    pendingGoals.delete(lane.wcId);
  } else {
    // paused / ask_user / stuck / budget：留着目标等「继续」或用户答复
    pendingGoals.set(lane.wcId, lane.goal);
  }
  if (lanes.size > 0) {
    setExternalPhase('running', `${lanes.size} 路仍在驾驶中（另一路已停：${reason}）`);
    return;
  }
  if (reason === 'done') setExternalPhase('done', `完成 — ${lane.goal.slice(0, 40)}`);
  else if (reason === 'paused' || reason === 'ask_user' || reason === 'stuck' || reason === 'budget') {
    setExternalPhase('paused', `等你的下一步：${lane.goal.slice(0, 30)}`);
  } else setExternalPhase('failed', `驾驶员已停止（${reason}）`);
}

ipcMain.handle(
  'workbench:agent:start',
  (_event, goal: unknown, apiBase: unknown, token: unknown, targetRaw: unknown) => {
    const g = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
    if (!g) return getTaskState();
    // 第 17 步：两路并行时必须点名「驾驶哪一张页」——不点名就宁可不开车，
    // 也绝不让主进程自己瞎挑一张（那会把动作打到另一路正在跑的页面上）。
    const wcId = Number(targetRaw);
    if (!Number.isInteger(wcId)) {
      emitAgent({ kind: 'note', level: 'error', text: '这一路没有指定要驾驶哪张内嵌页，没有发车。' });
      return getTaskState();
    }
    if (typeof apiBase === 'string' && apiBase) agentApiBase = apiBase;
    if (typeof token === 'string') agentJwt = token; // 只存内存；绝不 console
    return startAgentLoop(wcId, g, true);
  },
);

/** 第 17 步：当前正在驾驶的 webview guest id 列表（渲染层开第 3 张页时用来挑「没在跑的那张」） */
ipcMain.handle('workbench:agent:lanes', () => [...lanes.keys()]);

// 第 8 步：结果文档下载。渲染层把 apiBase+token 传进来（刷新后主进程可能没会话）；
// 拿到 Markdown 后：先本地脱敏兜底，再弹系统“保存为”对话框（只有 1 个窗口，不新增窗）。
ipcMain.handle('workbench:doc:download', async (_event, taskIdRaw: unknown, apiBaseRaw: unknown, tokenRaw: unknown) => {
  const taskId = Number(taskIdRaw);
  const apiBase = typeof apiBaseRaw === 'string' && apiBaseRaw ? apiBaseRaw : agentApiBase;
  const token = typeof tokenRaw === 'string' && tokenRaw ? tokenRaw : agentJwt;
  if (!Number.isInteger(taskId)) return { saved: false, error: '没有可用的任务号（taskId 非法）' };
  if (!token) return { saved: false, error: '没有登录凭证：先登录再下载' };
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, '')}/agent/task/doc?taskId=${taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as { markdown?: string; title?: string; error?: string };
    if (!res.ok) return { saved: false, error: data.error ?? `HTTP ${res.status}` };
    let md = String(data.markdown ?? '');
    if (!md.trim()) return { saved: false, error: '文档是空的，别下载；去后端日志看收尾是否被跳过' };
    // 脱敏兜底：Key/JWT/手机号绝不进文件（服务端文档本不该有，这里再滤一遍）
    md = md
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [已隐去]')
      .replace(/sk-[A-Za-z0-9_\-]{6,}/g, '[已隐去密钥]')
      .replace(/\b1[3-9]\d{9}\b/g, '[已隐去手机号]');
    const safeTitle = String(data.title || '任务记录')
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 60) || '任务记录';
    const options: Electron.SaveDialogOptions = { defaultPath: `${safeTitle}.md`, filters: [{ name: 'Markdown 文档', extensions: ['md'] }] };
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { canceled, filePath } = target ? await dialog.showSaveDialog(target, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { saved: false, canceled: true };
    await writeFile(filePath, `<!-- 由 AI 工作台导出 · 只含任务结论，凭证与手机号已过滤 -->\n\n${md}`, 'utf8');
    return { saved: true, path: filePath };
  } catch (err) {
    return { saved: false, error: (err as Error).message };
  }
});


// 第 9 步：用户对「补资料」提问的回答。只许普通资料（模型层+执行层双闸挡敏感值）；
// 只进内存与步摘要，不进 messages/memories。等待中收到答复 = 自动唤醒继续。
// 第 17 步：两路并行时答复只喂给**提问的那一路**（带 targetWebContentsId），不串到别路。
ipcMain.handle('workbench:agent:answer', (_event, text: unknown, targetRaw: unknown) => {
  const t = typeof text === 'string' ? text.trim().slice(0, 200) : '';
  if (!t) return getTaskState();
  const asked = Number(targetRaw);
  const targets = new Set<number>();
  if (Number.isInteger(asked)) {
    targets.add(asked);
  } else {
    // 没点名：优先给正在等答复的那几路；一路都没有就按挂起的目标猜
    for (const lane of lanes.values()) if (lane.awaiting) targets.add(lane.wcId);
    if (targets.size === 0) for (const wcId of pendingGoals.keys()) targets.add(wcId);
  }
  for (const wcId of targets) {
    const lane = lanes.get(wcId);
    if (lane && lane.awaiting && lane.waiters.length > 0) {
      lane.answers.push(t); // 循环还挂在敏感等待上：喂进去 + 唤醒
      notifyResume(lane);
      continue;
    }
    const goal = lane?.goal ?? pendingGoals.get(wcId);
    if (!goal) continue;
    pendingAnswers.set(wcId, [...(pendingAnswers.get(wcId) ?? []), t]);
    startAgentLoop(wcId, goal, false); // 上一轮以 ask_user 停了：带答复重启（仍先读当前页）
  }
  return getTaskState();
});

ipcMain.handle('workbench:agent:stop', () => {
  abortAllLanes();
  agentJwt = '';
  notifyAllResume(); // 别让挂在敏感等待上的循环僵住
  pendingGoals.clear();
  pendingAnswers.clear();
  emitAgent({ kind: 'note', level: 'info', text: '驾驶员循环已中止（登出/停止）。' });
});

/**
 * 第 16 步：**放下**当前任务但保留登录凭证 —— 用户改口时用。
 *
 * 场景：正在做任务 A（例如看旧店铺后台），用户直接说「打开油管」。
 * 最新指令优先级最高：旧循环立刻作废，旧目标清空（不会被「继续」重新捡起来），
 * 状态机回 idle。凭证保留，所以新任务不用重新登录。
 *
 * 第 17 步：带 targetWebContentsId 时**只放下那一路**（那一张页），
 * 另一路在别的页上继续跑 —— 这正是「第二句不会把第一张废掉」。
 * 不带则放下全部（登出 / 停止）。
 */
ipcMain.handle('workbench:agent:drop', (_event, targetRaw: unknown) => {
  const wcId = Number(targetRaw);
  if (Number.isInteger(wcId)) {
    const lane = lanes.get(wcId);
    if (lane) {
      lane.aborted = true;
      lane.running = false;
      notifyResume(lane);
      lanes.delete(wcId);
    }
    pendingGoals.delete(wcId);
    pendingAnswers.delete(wcId);
    if (lanes.size === 0) resetTask();
    return;
  }
  abortAllLanes();
  notifyAllResume();
  pendingGoals.clear();
  pendingAnswers.clear();
  resetTask();
  emitAgent({ kind: 'note', level: 'info', text: '按你的最新指令：已经放下上一件事（旧任务不再提起）。' });
});

// 单实例锁：重复启动时聚焦已有窗口，而不是再开一个
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已经有实例在跑。如果不打印这行，新进程会「1 秒内静默退出、退出码 0」，
  // 看起来像启动成功了但窗口没出现，非常难排查。
  console.warn('[main] 检测到已有实例在运行，本次启动退出（已聚焦原窗口）。');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    /**
     * 第 17 步：让内嵌页的 UA 像**普通 Chrome 桌面**——只去掉 `Electron/<版本>` 与产品名 token。
     * 目的很窄：少一眼被站点认成「内嵌壳」。明确**不做**指纹浏览器那一套（不改 Canvas/WebGL/字体…）。
     */
    const rawUa = app.userAgentFallback || '';
    if (rawUa) {
      const clean = rawUa
        .replace(/\sElectron\/[^\s]+/g, '')
        .replace(/\s(ai-workbench|AI\s*工作台)\/[^\s]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (clean && clean !== rawUa) {
        app.userAgentFallback = clean;
        console.log('[main] 内嵌页 UA 已去掉 Electron token（贴近普通 Chrome 桌面）。');
      }
    }

    createMainWindow();

    // macOS：点 Dock 图标且无窗口时重建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

// Windows / Linux：关掉所有窗口即退出；macOS 保留在 Dock
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
