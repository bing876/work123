import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import { mkdirSync, appendFileSync } from 'node:fs';
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
import { runToolLoop } from './agent';
import { startSensitiveAutoResume } from './driver';
import { getSettings, onSettingsChange, setSettings } from './settings';
import { initResourceGuard, syncDrivingFlags } from './resource-guard';
import type {
  AgentEventPayload,
  AgentLoopNextResult,
  AgentLoopStartResult,
  BrowserAction,
  TaskPhase,
  WorkbenchSettings,
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
 * Phase 3：**登录态隔离粒度 = 项目**（同项目的多个智能体共用一套 cookie / localStorage）。
 *
 * 渲染层的 <webview> 用 `partition="persist:workbench-browser-project-<projectId>"`，
 * Electron 会把这个分区落到 `<userData>/Partitions/<分区名>/` —— 这天然就是
 * 「每个项目在 userData 下有自己的子目录」（cookie / localStorage / 站点数据全在里面）。
 *
 * ⚠️ 与标签页粒度别混：标签页 / 任务 / 暂停继续仍然**按 agentId** 隔离（那是渲染层的事）；
 *    主进程这边只关心分区（= 项目），外加「下载记录要能标出是哪个智能体触发的」。
 *
 * ⚠️ 主进程 import 不到渲染层代码，所以分区命名规则在这里是**同规则的第二份**
 *    （渲染层见 apps/desktop/src/browser/url.ts 的 partitionFor），**改一处要同时改两处**。
 */
const PROJECT_PARTITION_RE = /workbench-browser-project-(\d+)/;

/** 已经挂过 will-download 的分区（同一个分区可能被多次 attach，别重复挂） */
const downloadHooked = new Set<string>();

/**
 * Phase 3：guest webContents id → 开这张页的智能体。
 *
 * 分区名里现在只放得下 projectId，agentId 放不下了 —— 主进程要知道「这次下载是哪个智能体触发的」，
 * 只能由渲染层在页就绪时报一次（IPC `workbench:browser:owner`，见 preload 的 browserOwner()）。
 * 另外驾驶中的那几路还有 `lastAgentByWc` 兜底。
 */
const webviewOwner = new Map<number, number>();

/** 这次下载是哪个智能体触发的（拿不到就说拿不到，**绝不瞎猜成某一个**） */
function ownerAgentOf(wcId: number): { agentId: number | null; source: string } {
  const fromRenderer = webviewOwner.get(wcId);
  if (typeof fromRenderer === 'number') return { agentId: fromRenderer, source: 'renderer' };
  const fromLane = lastAgentByWc.get(wcId);
  if (typeof fromLane === 'number') return { agentId: fromLane, source: 'lane' };
  return { agentId: null, source: 'unknown' };
}

/** 按项目存下载的根目录（不存在就建出来） */
function projectRootDir(): string {
  const dir = path.join(app.getPath('userData'), 'browser-projects');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[download] 建目录失败：', (error as Error).message);
  }
  return dir;
}

/** 某个项目自己的下载目录（不存在就建出来） */
function projectDownloadDir(projectId: number): string {
  const dir = path.join(projectRootDir(), String(projectId), 'downloads');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[download] 建目录失败：', (error as Error).message);
  }
  return dir;
}

/**
 * 下载记录（append-only JSONL，落在 `<userData>/browser-projects/_downloads.jsonl`）。
 *
 * 这是「呈现给用户/排查用」的那份记录：**物理目录按项目合并了，但每条记录都带 agentId**，
 * 所以「这个文件是哪个智能体下载的」永远查得到，不会因为合并目录而丢失。
 */
function appendDownloadRecord(record: Record<string, unknown>): void {
  try {
    appendFileSync(path.join(projectRootDir(), '_downloads.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.warn('[download] 写下载记录失败：', (error as Error).message);
  }
}

/**
 * 给「某个项目的浏览器分区」挂下载落盘规则：文件进这个项目自己的 downloads 目录，
 * 不弹系统「另存为」。
 *
 * Phase 3 的两件事一起做：
 *   1. 物理目录按**项目**（同一项目的多个智能体下的文件落在同一处）；
 *   2. **记录里仍标 agentId** —— 目录合并了，归属信息不合并。
 *
 * 认不出分区的（例如主窗口自己那个默认 session）一律不管。
 */
function hookProjectDownloads(contents: WebContents): void {
  const ses = contents.session;
  const storage = ses.getStoragePath() ?? '';
  const m = PROJECT_PARTITION_RE.exec(storage);
  if (!m) return;
  if (downloadHooked.has(storage)) return;
  downloadHooked.add(storage);
  const projectId = Number(m[1]);
  // ⚠️ 归属必须取**第三个参数**（真正发起这次下载的那个 guest），不能闭包里的 `contents`：
  // Phase 3 起一个项目一个分区，**同一 session 被该项目的多个智能体共用**，
  // `contents` 只是第一个创建这个 session 的页 —— 拿它当「谁下载的」会把同项目其他智能体
  // 的下载全记到那第一只头上（真机取证时确实踩到了：A2 的下载被记成 A1）。
  ses.on('will-download', (_event, item, fromWc) => {
    const filename = item.getFilename();
    const savePath = path.join(projectDownloadDir(projectId), filename);
    item.setSavePath(savePath);
    const owner = ownerAgentOf((fromWc ?? contents).id);
    appendDownloadRecord({
      at: new Date().toISOString(),
      projectId,
      agentId: owner.agentId,
      agentSource: owner.source,
      filename,
      savePath,
      url: item.getURL(),
      partition: storage,
    });
    console.log(
      `[download] 项目 ${projectId} / 智能体 ${owner.agentId ?? '未知'}（${owner.source}）的下载落到：${savePath}`,
    );
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

  // Phase 3：这个内嵌页属于哪个项目，它的下载就落到那个项目自己的目录（记录里仍标 agentId）
  hookProjectDownloads(contents);

  // 页没了就把 owner 登记清掉，别让 wcId 被复用后认错人
  contents.once('destroyed', () => {
    webviewOwner.delete(contents.id);
  });

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
// 网页由渲染层的 <webview partition="persist:workbench-browser-project-<projectId>"> 承载
// （Phase 3：按项目分区 —— 同项目的智能体共用一套 cookie / 登录态，跨项目完全隔离），
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

// 第 22 步：启动任务必须点名要驾驶哪张页（driver.resolveTarget 已删掉盲选兜底）
ipcMain.handle('workbench:task:start', (_event, targetWebContentsId?: number) =>
  startTask(targetWebContentsId),
);
/**
 * 子阶段 A：暂停 / 继续也支持**点名某一张页**。
 *
 * 为什么必须加：driver 侧早就是 per-target（`pauseTask(wcId)` / `applyPaused(wcId)`），
 * 但这两个 IPC 一直不接 target，落到 `activeTaskWcId()` 上 —— 多路真并行时那等于
 * 「按 Map 里第一条在跑的猜」，**验不出「暂停 1 号、2 号照跑」**，也做不到用户想停哪路停哪路。
 * 不传 target 时行为与以前**完全一致**（沿用「此刻在跑 / 最近碰过的那张」），所以老调用点不用改。
 */
ipcMain.handle('workbench:task:pause', (_event, targetWebContentsId?: unknown) => {
  const wcId = Number(targetWebContentsId);
  return pauseTask(Number.isInteger(wcId) ? wcId : undefined);
});
// 第 7 步：有挂起的驾驶员任务时，「继续」= 重启 AI 循环（第一步仍是 read_page，按当前页决策，
// 不重放旧动作）；没有则维持第 4 步 demo 语义。
// 第 17 步：两路并行时「继续」= 把**所有**挂起的那几路一起重新发车（每路各读自己那张页）。
ipcMain.handle('workbench:task:resume', (_event, targetWebContentsId?: unknown) => {
  const wcIdRaw = Number(targetWebContentsId);
  const only = Number.isInteger(wcIdRaw) ? wcIdRaw : null;
  // 点名了某一页：只动这一路，别路绝不碰
  if (only !== null) {
    const lane = lanes.get(only);
    if (lane && lane.waiters.length > 0) {
      notifyResume(lane);
      return getTaskState(only);
    }
    const goal = pendingGoals.get(only) ?? lane?.goal;
    if (goal) {
      startAgentLoop(only, goal, false, { agentId: lane?.agentId ?? lastAgentByWc.get(only) ?? null });
      return getTaskState(only);
    }
    return resumeTask(only);
  }
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
/**
 * 子阶段 A：状态读口也支持**点名某一张页**。
 *
 * A1.5 已经把状态改成 per-target，但 `getTaskState()` 不接 target 时回的是**聚合视图**
 * （左栏横幅需要的那条）。多路真并行时这就读不出「1 号已暂停、2 号还在跑」——
 * 聚合视图按「running > paused」挑，只会回 2 号。不传 target 时行为不变。
 */
ipcMain.handle('workbench:task:state', (_event, targetWebContentsId?: unknown) => {
  const wcId = Number(targetWebContentsId);
  return getTaskState(Number.isInteger(wcId) ? wcId : undefined);
});

// ---------------------------------------------------------------------------
// 第 22 步：可调配置（A1.5 的并发数 / D 的多实例上限）
//
// 权威副本在 electron/settings.ts（userData 下的 JSON，用户手改也认）；
// 这里只做两件事：转发 IPC + 变更时广播给渲染层。
// ---------------------------------------------------------------------------
ipcMain.handle('workbench:settings:get', () => getSettings());
ipcMain.handle('workbench:settings:set', (_event, patch: unknown) =>
  setSettings((patch ?? {}) as Partial<WorkbenchSettings>),
);
onSettingsChange((s) => sendToMainWindow('workbench:browser:settings', JSON.stringify(s)));

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
  /**
   * 第 21 步：这一路在**服务端**的那个工具循环 id（脑在服务端，这里只当手）。
   * 建循环与「停」都要带上它，服务端才认得出「停的是哪一路」。
   */
  loopId: string | null;
  /** 第 21 步：这一路属于哪个智能体（服务端据此挡住「A 的循环点到 B 的页上」） */
  agentId: number | null;
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
/**
 * 第 21 步：每张页最后是哪个智能体在驾驶 —— 「继续」会新起一轮循环，
 * 新循环也要记住同一个智能体（否则服务端会把它当成别的 bot 的循环，直接 409）。
 */
const lastAgentByWc = new Map<number, number>();

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
      // 第 21 步：后端正常时最长一次模型调用 60s（服务端自己会掐），这里留 90s 上限。
      // 没有这个上限，后端半路挂掉会让驾驶循环永远停在「等下一步」上。
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? '后端 90 秒没有回应（服务端可能卡住了）' : (err as Error).message;
    throw new Error(`连不上后端 ${agentApiBase}：${msg}`);
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
 * - 这张页上已经有一路在跑 → **最新指令优先**：旧循环作废，用新目标重发（第一步仍是读当前页）；
 * - 这张页上没有 → 新起一路（第 20 步取消了**按活页数**的硬顶；
 *   第 22 步改由配置项 `maxConcurrentAgentTasks` 管并发，默认 1 —— 见下面的 A1.5 注释）；
 * - 别路（别的页）**完全不动** —— 第二句不会把第一张降级成不能动的占位。
 *
 * 第 21 步：循环的**脑在服务端**。这里要么用渲染层带下来的 loopId（/chat/stream 已经建好），
 * 要么自己调 /agent/loop/start 建一个；然后 runToolLoop 只负责「要工具 → 执行 → 喂回执」。
 */
function startAgentLoop(
  wcId: number,
  goal: string,
  fresh: boolean,
  opts: { loopId?: string; agentId?: number | null } = {},
): ReturnType<typeof getTaskState> {
  const prev = lanes.get(wcId);
  if (prev) {
    prev.aborted = true;
    prev.running = false;
    // 旧那一路在服务端的循环也要停：否则它还会被问下一步（白烧 token）
    if (prev.loopId) void agentPost('/agent/loop/stop', { loopId: prev.loopId, reason: 'superseded' }).catch(() => undefined);
    notifyResume(prev);
  } else {
    /**
     * 第 22 步 · A1.5：**并发上限**（默认 1，设置里可调，绝不写死）。
     *
     * 「同一张页上的新指令覆盖旧指令」不算新增一路，所以只在 `!prev` 时判。
     * 超限就**拒绝发车**并把话说清楚 —— 既不静默丢弃，也不偷偷挤掉正在跑的那一路。
     * 一期把默认值定成 1，是为了让「驾驶状态按 target 独立存储」的数据结构先跑起来；
     * 以后在设置里把它调大就是真并行，**不需要改数据结构**（这正是 A1.5 的意思）。
     */
    const limit = getSettings().maxConcurrentAgentTasks;
    if (lanes.size >= limit) {
      emitAgent(
        {
          kind: 'note',
          level: 'info',
          text:
            `现在已经有 ${lanes.size} 路在驾驶了，并发上限是 ${limit}（可以在设置里调大）。` +
            '要换一张页跑，先对正在跑的那张点「停」，或者把上限调大。',
        },
        wcId,
      );
      return getTaskState();
    }
  }

  const lane: Lane = {
    wcId,
    goal,
    loopId: typeof opts.loopId === 'string' && opts.loopId ? opts.loopId : null,
    agentId: typeof opts.agentId === 'number' ? opts.agentId : null,
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
  // 第 22 步：状态机**按 target**，所以接管时要把「哪一张页」说清楚
  const state = takeoverRun(
    wcId,
    lanes.size > 1 ? `${lanes.size} 路驾驶中 · 本路任务：${goal.slice(0, 30)}` : detail,
  );

  void (async () => {
    // 1) 拿到这一路的循环 id（渲染层没带就自己建一个：同一条服务端引擎，没有第二套）
    if (!lane.loopId) {
      const r = await agentPost<AgentLoopStartResult>('/agent/loop/start', {
        agentId: lane.agentId,
        goal,
        wcId,
      });
      if (!r || typeof r.loopId !== 'string') throw new Error('服务端没有给出循环号');
      lane.loopId = r.loopId;
      console.log(`[agent] 第 ${wcId} 路新循环 ${r.loopId}（上限 ${r.maxSteps} 步）`);
    }
    if (lane.aborted) return;

    // 2) 当「手」：要工具 → 用现有 driver 在**这一路自己那张页**上执行 → 喂回执
    return runToolLoop(lane.loopId, goal, {
      next: (loopId, result) =>
        agentPost<AgentLoopNextResult>('/agent/loop/next', {
          loopId,
          agentId: lane.agentId,
          wcId,
          result,
        }).then((r) => {
          if (!r || !r.decision || typeof (r.decision as { kind?: string }).kind !== 'string') {
            throw new Error('服务端回了畸形的决策');
          }
          return r.decision;
        }),
      // 第 17 步：动作一律打到**这一路自己的那张页**上（两路并行时绝不能盲选 guest）
      exec: (action) => drive(action, wcId),
      // 第 22 步：暂停门按 target 判 —— 只问**这一路自己那张页**有没有被按住
      isPaused: () => isDrivingPaused(wcId),
      aborted: () => lane.aborted,
      emit: (payload) => {
        if (payload.kind === 'ask' || payload.kind === 'sensitive') lane.awaiting = true;
        emitAgent(payload, wcId);
      },
      stopLoop: (reason) => {
        if (!lane.loopId) return;
        void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason }).catch(() => undefined);
      },
      sensitiveNotice: (question) => {
        // 敏感字段：窗口前置 + 聚焦这一路那张页 + 🔒 人话提示（值不经 AI、不落库）
        mainWindow?.show();
        mainWindow?.focus();
        sendToMainWindow('workbench:browser:focus', String(wcId));
        lane.awaiting = true;
        emitAgent({ kind: 'sensitive', fieldReason: 'sensitive', message: question }, wcId);
      },
      // 第 22 步：外部循环汇报的状态同样落到**这一路那张页**上
      phase: (next, detail) => setExternalPhase(wcId, next, detail),
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
    });
  })()
    .then((reason) => finishLane(lane, reason ?? 'done'))
    .catch((err) => {
      // 循环本体不抛穿（内部都 catch 了）；真到这就是编程错误，也得说人话而不是崩
      console.error('[agent] 循环异常：', err);
      emitAgent({ kind: 'note', level: 'error', text: `驾驶员内部错误：${(err as Error).message}` }, wcId);
      setExternalPhase(wcId, 'failed', `驾驶员内部错误 — ${(err as Error).message}`);
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
    /**
     * 第 22 步：把**这张页**的状态收干净，否则聚合视图会一直显示「AI 驾驶中」
     * （用户点了「停」、状态却永远停在 running，确认按钮跟着一直是灰的）。
     *
     * 但要小心两种「已中止」：
     *   - 同一张页上**换了新的一路**（最新指令优先）→ 绝不能动状态，否则会把新循环的
     *     running 覆盖成 idle；
     *   - 用户停手 / 登出（`abortAllLanes` 已把 lanes 清空）→ 这时才收。
     */
    const current = lanes.get(lane.wcId);
    if (!current || current === lane) {
      setExternalPhase(lane.wcId, 'idle', '已停手（这一路已结束）');
    }
    return;
  }
  if (reason === 'done' || reason === 'read_failed' || reason === 'brain_failed') {
    pendingGoals.delete(lane.wcId);
  } else {
    // paused / ask_user / stuck / budget：留着目标等「继续」或用户答复
    pendingGoals.set(lane.wcId, lane.goal);
  }
  /**
   * 第 22 步：状态按 target 存 —— 这一路如实记成**它自己的结局**。
   *
   * 以前这里会把**全局**状态硬写成 running 并说「N 路仍在驾驶中」；
   * 现在「还有别的路在跑」由左栏的聚合视图自然体现（它会挑一条在跑的显示），
   * 不需要把已经停下的这一路也说成 running。
   */
  const mine: TaskPhase =
    reason === 'done'
      ? 'done'
      : reason === 'paused' || reason === 'ask_user' || reason === 'stuck' || reason === 'budget'
        ? 'paused'
        : 'failed';
  const tail =
    mine === 'done'
      ? `完成 — ${lane.goal.slice(0, 40)}`
      : mine === 'paused'
        ? `等你的下一步：${lane.goal.slice(0, 30)}`
        : `驾驶员已停止（${reason}）`;
  setExternalPhase(lane.wcId, mine, tail);
}

ipcMain.handle(
  'workbench:agent:start',
  (_event, goal: unknown, apiBase: unknown, token: unknown, targetRaw: unknown, optsRaw: unknown) => {
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
    /**
     * 第 21 步：opts = {loopId?, agentId?}。
     * loopId 是 /chat/stream 的任务轮已经建好的那个服务端循环（带上就不用再建）；
     * agentId 记下这一路属于哪个智能体（服务端用它挡住串到别的 bot 的页）。
     */
    const opts = (optsRaw ?? {}) as { loopId?: unknown; agentId?: unknown };
    const loopId = typeof opts.loopId === 'string' && opts.loopId ? opts.loopId : undefined;
    const agentIdRaw = Number(opts.agentId);
    const agentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null;
    if (agentId !== null) lastAgentByWc.set(wcId, agentId);
    return startAgentLoop(wcId, g, true, { loopId, agentId });
  },
);

/** 第 17 步：当前正在驾驶的 webview guest id 列表（渲染层开第 3 张页时用来挑「没在跑的那张」） */
ipcMain.handle('workbench:agent:lanes', () => [...lanes.keys()]);

/**
 * Phase 3：渲染层登记「这张内嵌页是哪个智能体开的」。
 *
 * 分区名里现在只放得下 projectId，而下载记录必须能标出「哪个智能体触发的」——
 * 所以由渲染层在页就绪时报一次（见 preload 的 browserOwner / BrowserPanel 的 dom-ready）。
 */
ipcMain.handle('workbench:browser:owner', (_event, wcIdRaw: unknown, agentIdRaw: unknown) => {
  const wcId = Number(wcIdRaw);
  const agentId = Number(agentIdRaw);
  if (!Number.isInteger(wcId) || wcId < 0) return;
  if (!Number.isInteger(agentId) || agentId <= 0) return;
  webviewOwner.set(wcId, agentId);
});

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
    // 第 21 步：带答复重启（仍是先读当前页）；智能体沿用这张页上一次那个
    startAgentLoop(wcId, goal, false, { agentId: lane?.agentId ?? lastAgentByWc.get(wcId) ?? null });
  }
  return getTaskState();
});

ipcMain.handle('workbench:agent:stop', () => {
  // 第 21 步：先告诉服务端「这些循环都别走了」（否则它还会被问下一步，白烧 token）
  for (const lane of lanes.values()) {
    if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'agent_stop' }).catch(() => undefined);
  }
  abortAllLanes();
  agentJwt = '';
  notifyAllResume(); // 别让挂在敏感等待上的循环僵住
  pendingGoals.clear();
  pendingAnswers.clear();
  lastAgentByWc.clear();
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
      // 第 21 步：只停**这一路**在服务端的那个循环（别路照跑）
      if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'dropped' }).catch(() => undefined);
      notifyResume(lane);
      lanes.delete(wcId);
    }
    pendingGoals.delete(wcId);
    pendingAnswers.delete(wcId);
    lastAgentByWc.delete(wcId);
    if (lanes.size === 0) resetTask();
    return;
  }
  for (const lane of lanes.values()) {
    if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'dropped_all' }).catch(() => undefined);
  }
  abortAllLanes();
  notifyAllResume();
  pendingGoals.clear();
  pendingAnswers.clear();
  lastAgentByWc.clear();
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

    /**
     * Phase 4：资源守护者 —— 持续采集本应用的内存 / CPU、按两档阈值判定、落盘并暴露 IPC。
     *
     * 注入两样东西：
     *   - `sendToMainWindow`：警戒提示往渲染层广播（本阶段复用既有单行提示通道，不新增 UI）；
     *   - `getDriving`：**有未结束任务的页**（lanes 里在跑的 + pendingGoals 里挂着等继续的）
     *     —— 主进程才是权威，提示里"这个别关"必须按它说，不能听渲染层转述。
     *
     * ⚠️ 它**不改任何浏览器行为**：不关页、不限开、不插进驾驶循环。
     *    监控自己出问题时，配置里 `resourceGuardEnabled=0` 就能让它闭嘴，不用改代码。
     */
    initResourceGuard(sendToMainWindow, () => [...lanes.keys(), ...pendingGoals.keys()]);

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
