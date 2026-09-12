import { app, BrowserWindow, ipcMain, shell } from 'electron';
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

/** 开发模式下 Vite Dev Server 的地址（与 vite.config.ts 的 server.port 保持一致） */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

/**
 * 内嵌页不允许创建新窗口：点击 target=_blank / window.open 时，改为让**同一个 guest**导航。
 *
 * 这是用户在右栏手点搜索结果、帮助链接时的必要行为；若只简单 deny，页面看起来就会“点了没反应”。
 * 全程没有 BrowserWindow，也不会打开系统 Edge / Chrome。
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    // 只放行 http(s)。about:blank / data: 之类的伪 URL 不能丢给 guest，
    // 否则会把当前搜索页冲成空白页（表现为“点了链接反而白屏”）。
    if (/^https?:\/\//i.test(url)) {
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
      console.warn('[webview] 忽略非 http(s) 的打开请求：', url);
    }
    return { action: 'deny' };
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
    void shell.openExternal(url);
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
// 网页由渲染层的 <webview partition="persist:workbench-browser"> 承载，
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
ipcMain.handle('workbench:task:resume', () => (agentGoal ? startAgentLoop(agentGoal, false) : resumeTask()));
ipcMain.handle('workbench:task:reset', () => {
  agentEpoch += 1; // 外部循环作废（下一个检查点退出）
  agentGoal = null;
  return resetTask();
});
ipcMain.handle('workbench:task:state', () => getTaskState());

// ---------------------------------------------------------------------------
// 第 7 步：云端驾驶员「一步一问」循环的编排层（就在主进程；渲染进程不直连 CDP）
//   - 调后端 /agent/next-action 要带第 5 步 JWT——token 只存在这里（内存），绝不打印全文；
//   - 执行永远走现有 driver.ts；暂停由 driver 的 paused 闸 + 循环自查双保险；
//   - API Key 不经过这里：它只在 apps/server/.env。
// ---------------------------------------------------------------------------
let agentEpoch = 0;
/** 非 null = 有一轮驾驶员任务挂着（done/failed/stop 后置 null；paused 时保留供「继续」） */
let agentGoal: string | null = null;
let agentApiBase = 'http://127.0.0.1:8787';
let agentJwt = '';

function emitAgent(payload: AgentEventPayload): void {
  sendToMainWindow('workbench:browser:agent', JSON.stringify(payload));
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

function startAgentLoop(goal: string, fresh: boolean): ReturnType<typeof getTaskState> {
  const epoch = ++agentEpoch;
  agentGoal = goal;
  const state = takeoverRun(fresh ? `AI 驾驶中 · 任务：${goal.slice(0, 36)}` : `继续任务（先读当前页）：${goal.slice(0, 36)}`);
  void runAgentLoop(goal, {
    nextAction: (body: { taskId: number | null; goal: string; stepsSummary: string[]; snapshot: PageSnapshot }) =>
      agentPost<AgentActionResponse>('/agent/next-action', body).then((r) => {
        if (!r || typeof (r.action as { action?: string })?.action !== 'string') throw new Error('大脑回了畸形 JSON');
        return r;
      }),
    exec: (action) => drive(action),
    readSnapshot: async () => {
      const r = await drive({ action: 'read_page' });
      if (!r.ok || !r.pageSnapshot) throw new Error(r.error ?? 'read_page 没拿到快照');
      return r.pageSnapshot;
    },
    isPaused: () => isDrivingPaused(),
    aborted: () => epoch !== agentEpoch,
    emit: emitAgent,
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
    .then((reason) => {
      if (epoch !== agentEpoch) return; // 已被新任务/复位顶掉，别动全局
      if (reason === 'done' || reason === 'read_failed' || reason === 'brain_failed') agentGoal = null;
      // paused / ask_user / stuck / budget：留着 agentGoal，「继续」从这里重启
      console.log(`[agent] 循环结束：${reason}`);
    })
    .catch((err) => {
      // 循环本体不抛穿（内部都 catch 了）；真到这就是编程错误，也得说人话而不是崩
      console.error('[agent] 循环异常：', err);
      emitAgent({ kind: 'note', level: 'error', text: `驾驶员内部错误：${(err as Error).message}` });
      setExternalPhase('failed', `驾驶员内部错误 — ${(err as Error).message}`);
      agentGoal = null;
    });
  return state;
}

ipcMain.handle('workbench:agent:start', (_event, goal: unknown, apiBase: unknown, token: unknown) => {
  const g = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
  if (!g) return getTaskState();
  if (typeof apiBase === 'string' && apiBase) agentApiBase = apiBase;
  if (typeof token === 'string') agentJwt = token; // 只存内存；绝不 console
  return startAgentLoop(g, true);
});

ipcMain.handle('workbench:agent:stop', () => {
  agentEpoch += 1;
  agentGoal = null;
  agentJwt = '';
  emitAgent({ kind: 'note', level: 'info', text: '驾驶员循环已中止（登出/停止）。' });
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
