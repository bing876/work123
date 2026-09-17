/**
 * 第 20 步 · 浏览器模块：类型。
 *
 * 这个目录是**工作台浏览器**的全部家当（第 18 步把边界划清之后，
 * 以后浏览器相关的改动都写在这里，不要再往 App.tsx 里堆）：
 *
 *   browser/
 *     types.ts                —— 一张活页长什么样（这个文件）
 *     url.ts                  —— 地址、分区名、页数提示的纯函数（含桌面侧协议闸）
 *     sites.ts                —— 「打开百度」→ URL 的登记表 + 纯字符串判定
 *     intent.ts               —— 「在这张页面上做事 / 停 / 继续」的判定
 *     useBrowserWorkspace.ts  —— 按智能体分桶的 tab 状态 + 开/关/切 + 驾驶接口
 *     BrowserPanel.tsx        —— 中栏那块 UI（tab + URL 栏 + webview 宿主）
 *     styles.css              —— 这块 UI 的样式（第 19 步只改这里）
 *     index.ts                —— 唯一对外入口
 *
 * 主进程侧的协议拦截仍在 electron/（那里才是权威闸），但**桌面侧浏览器 UI/状态
 * 一律以本目录为准**。
 *
 * 第 20 步的关键变化：一张活页**属于某个智能体**（`agentId`）。
 * 工作区状态是按智能体分桶的，切智能体只换「哪一桶可见」，页本身一直活着。
 */

/** 一张活页在前端的样子 */
export interface BrowserTabView {
  id: number;
  /**
   * 这张页是哪个智能体开的。
   * **标签页归属 / 驾驶 / 暂停继续 / 聊天落回哪一路，全按它隔离** —— 绝不跨智能体合并。
   */
  agentId: number;
  /**
   * 这张页的智能体属于哪个项目（Phase 3 起）。
   * **登录态（cookie / localStorage / session）按它隔离** —— 同项目的智能体共用一套。
   *
   * 开页那一刻定下就不再变：页属于哪个项目的登录态，是它出生时的事，
   * 之后用户切到别的项目也不改（所以切项目不会把已开的页重载或换成别的登录态）。
   * null = 认不出项目 → 落到兜底分区，**不跟任何真项目混**。
   */
  projectId: number | null;
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
