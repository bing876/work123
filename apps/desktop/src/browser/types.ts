/**
 * 第 18 步 · 浏览器模块：类型。
 *
 * 这个目录是**工作台浏览器**的全部家当（第 18 步把边界划清之后，
 * 以后浏览器相关的改动都写在这里，不要再往 App.tsx 里堆）：
 *
 *   browser/
 *     types.ts                —— 一张活页长什么样（这个文件）
 *     url.ts                  —— 地址与上限的纯函数（含桌面侧协议闸）
 *     sites.ts                —— 「打开百度」→ URL 的登记表 + 纯字符串判定
 *     intent.ts               —— 「在这张页面上做事 / 停 / 继续」的判定
 *     useBrowserWorkspace.ts  —— tab 状态 + 开/关/切/上限 10 + 驾驶接口
 *     BrowserPanel.tsx        —— 中栏那块 UI（tab + URL 栏 + webview 宿主）
 *     styles.css              —— 这块 UI 的样式（第 19 步只改这里）
 *     index.ts                —— 唯一对外入口
 *
 * 主进程侧的协议拦截仍在 electron/（那里才是权威闸），但**桌面侧浏览器 UI/状态
 * 一律以本目录为准**。
 */

/** 一张活页在前端的样子 */
export interface BrowserTabView {
  id: number;
  /** 初次加载的地址：**建好之后不再变**（React 反复改 src 会让 webview 重新加载） */
  bootUrl: string;
  /** 当前地址（跟着页面自己走，只用于 URL 栏显示） */
  url: string;
  /** 标签文字：优先页面标题，拿不到就用域名 */
  title: string;
}

/** 页面自己动了（点链接 / SPA 跳转 / 标题变化）时回报给工作区 */
export interface BrowserPageInfo {
  url?: string;
  title?: string;
}
