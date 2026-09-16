/**
 * 第 18 步 · 浏览器模块的唯一对外入口。
 *
 * 以后要改浏览器相关的东西，**只改这个目录**，不要再往 App.tsx 里堆：
 *   App.tsx 只负责 <BrowserPanel ws={browser} /> 挂载 + 调 browser.openUrl / browser.stopDriving。
 *
 * 目录：
 *   types.ts                一张活页长什么样
 *   url.ts                  地址与上限（含桌面侧协议闸、MAX_LIVE_PAGES）
 *   sites.ts                「打开百度」→ URL
 *   intent.ts               「在这张页面上做事 / 停 / 继续」的判定
 *   useBrowserWorkspace.ts  tab 状态 + 开/关/切/上限 10 + 驾驶接口
 *   BrowserPanel.tsx        中栏那块 UI（tab + URL 栏 + webview 宿主）
 *   styles.css              这块 UI 的样式（第 19 步只改这里）
 */

export { BrowserPanel } from './BrowserPanel';
export { useBrowserWorkspace } from './useBrowserWorkspace';
export type { BrowserWorkspace } from './useBrowserWorkspace';
export type { BrowserPageInfo, BrowserTabView } from './types';
export { HOME_URL, detectOpenUrl, isPureOpenCommand } from './sites';
export {
  CONFIRM_ASK_RE,
  CONTINUE_STRONG_RE,
  CONTINUE_WEAK_RE,
  detectBrowseIntent,
  detectStopIntent,
} from './intent';
export { MAX_LIVE_PAGES, hostLabel, isHttpUrl, sameSite, toHttpUrl } from './url';
