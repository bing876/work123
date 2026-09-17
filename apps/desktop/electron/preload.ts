import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { BrowserAction, BrowserEvent, WorkbenchBridge, WorkbenchSettings } from '@ai-workbench/shared';

/**
 * preload —— 渲染进程与主进程之间唯一的桥。
 *
 * 这里只暴露「明确白名单」的方法，绝不把 ipcRenderer / require / process 整个丢出去。
 * 配合 BrowserWindow 的 contextIsolation: true + nodeIntegration: false，
 * 渲染进程即使被 XSS 也只能调用下面这几个函数。
 */

/** 主进程 → 渲染进程的 UI 指令通道前缀 */
const BROWSER_CHANNEL_PREFIX = 'workbench:browser:';

const bridge: WorkbenchBridge = {
  platform: process.platform,
  appVersion: process.env.npm_package_version ?? '0.1.0',
  ping: () => ipcRenderer.invoke('app:ping'),

  // ---- 内嵌浏览器区域：渲染进程只发指令，显示/隐藏由主进程转发回来决定 ----
  openBrowser: (url?: string) => ipcRenderer.invoke('workbench:open', url),
  showBrowser: () => ipcRenderer.invoke('workbench:show'),
  hideBrowser: () => ipcRenderer.invoke('workbench:hide'),
  focusBrowser: () => ipcRenderer.invoke('workbench:focus'),

  // ---- 第 3 步：驾驶内嵌页（动作进 → 结果出），渲染层只发指令 ----
  drive: (action: BrowserAction, targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:drive', action, targetWebContentsId),
  readPage: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:read-page', targetWebContentsId),
  pauseDriving: () => ipcRenderer.invoke('workbench:pause-driving', true),
  resumeDriving: () => ipcRenderer.invoke('workbench:pause-driving', false),

  // ---- 第 4 步：任务状态机（权威状态在主进程，这里只发指令 / 取镜像）----
  // 第 22 步：启动任务必须点名要驾驶哪张页（主进程不再盲选第一个 webview）
  startTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:start', targetWebContentsId),
  // 子阶段 A：暂停 / 继续也支持点名某一张页 —— 多路真并行时「暂停这一路」必须能指定目标，
  // 否则只能按「此刻在跑的那张」猜，验不出「暂停 1 号、2 号照跑」。不传 = 沿用旧行为。
  pauseTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:pause', targetWebContentsId),
  resumeTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:resume', targetWebContentsId),
  resetTask: () => ipcRenderer.invoke('workbench:task:reset'),
  // 子阶段 A：可点名读**某一张页**的状态（driver 侧本来就是 per-target 的，只是这个读口
  // 一直只回聚合视图）。不传 = 聚合视图（左栏横幅用的那条路），老调用点不受影响。
  getTaskState: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:state', targetWebContentsId),

  // ---- 第 7 步：云端驾驶员循环（编排就在主进程；token 只递给主进程用，不打印）----
  // 第 17 步：多带一个 targetWebContentsId —— 这次驾驶**哪一张**内嵌页（两路并行必须点名）
  // 第 21 步：opts = {loopId, agentId} —— 循环的脑在服务端，loopId 是 /chat/stream 建好的那个；
  //           agentId 让服务端挡住「A 的循环点到 B 的页上」
  agentStart: (
    goal: string,
    apiBase: string,
    token: string,
    targetWebContentsId?: number,
    opts?: { agentId?: number | null; loopId?: string },
  ) => ipcRenderer.invoke('workbench:agent:start', goal, apiBase, token, targetWebContentsId, opts ?? {}),
  agentStop: () => ipcRenderer.invoke('workbench:agent:stop'),
  // 第 16 步：用户改口时放下当前任务（保留凭证），旧目标不会被「继续」重新捡起来
  // 第 17 步：带 id 只放下那一路（那张页），别路照跑；不带则全部放下
  agentDrop: (targetWebContentsId?: number) => ipcRenderer.invoke('workbench:agent:drop', targetWebContentsId),
  /** 第 17 步：正在驾驶哪几张内嵌页（guest id 列表）——开第 3 张页时用来挑空闲的那张 */
  agentLanes: () => ipcRenderer.invoke('workbench:agent:lanes'),
  /**
   * Phase 3：登记「这张内嵌页是哪个智能体开的」。
   * 分区改成按项目之后，主进程从分区名里读不到 agentId，下载记录靠这个标记 owner。
   */
  browserOwner: (webContentsId: number, agentId: number) =>
    ipcRenderer.invoke('workbench:browser:owner', webContentsId, agentId),
  agentAnswer: (text: string, targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:agent:answer', text, targetWebContentsId),

  // ---- 第 8 步：结果文档下载 + 服务端任务快照（红点以它为准）----
  downloadDoc: (taskId: number, apiBase: string, token: string) =>
    ipcRenderer.invoke('workbench:doc:download', taskId, apiBase, token),

  // ---- 第 22 步：可调配置（并发数 / 多实例上限）。权威副本在主进程 userData 下的 JSON ----
  getSettings: () => ipcRenderer.invoke('workbench:settings:get'),
  setSettings: (patch: Partial<WorkbenchSettings>) =>
    ipcRenderer.invoke('workbench:settings:set', patch),

  /**
   * 简易订阅：把主进程发来的 'workbench:browser:*' 转成回调。
   * 返回取消订阅函数（contextBridge 会把函数代理过去）。
   */
  on: (event: BrowserEvent, callback: (payload?: string) => void) => {
    const channel = `${BROWSER_CHANNEL_PREFIX}${event}`;
    const listener = (_e: IpcRendererEvent, payload?: string) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('workbench', bridge);
