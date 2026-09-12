import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { BrowserAction, BrowserEvent, WorkbenchBridge } from '@ai-workbench/shared';

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
  startTask: () => ipcRenderer.invoke('workbench:task:start'),
  pauseTask: () => ipcRenderer.invoke('workbench:task:pause'),
  resumeTask: () => ipcRenderer.invoke('workbench:task:resume'),
  resetTask: () => ipcRenderer.invoke('workbench:task:reset'),
  getTaskState: () => ipcRenderer.invoke('workbench:task:state'),

  // ---- 第 7 步：云端驾驶员循环（编排就在主进程；token 只递给主进程用，不打印）----
  agentStart: (goal: string, apiBase: string, token: string) =>
    ipcRenderer.invoke('workbench:agent:start', goal, apiBase, token),
  agentStop: () => ipcRenderer.invoke('workbench:agent:stop'),
  agentAnswer: (text: string) => ipcRenderer.invoke('workbench:agent:answer', text),

  // ---- 第 8 步：结果文档下载 + 服务端任务快照（红点以它为准）----
  downloadDoc: (taskId: number, apiBase: string, token: string) =>
    ipcRenderer.invoke('workbench:doc:download', taskId, apiBase, token),

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
