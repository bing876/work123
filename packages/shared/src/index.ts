/**
 * @ai-workbench/shared
 *
 * 只放「类型」——渲染进程、Electron 主进程、以及未来的 apps/server 都从这里取契约。
 * 全部是 type-only 导出，编译后不产生任何运行时代码，任何环境引入都零成本。
 */

/** 一条消息的角色 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 单条聊天消息 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** ISO 8601 时间戳，例如 2026-09-11T10:00:00.000Z */
  createdAt: string;
}

/** 一个会话（消息列表 + 元信息） */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

/** 内嵌浏览器区域可订阅的事件名（state：第 4 步状态机广播，payload 为 TaskState 的 JSON） */
export type BrowserEvent = 'open' | 'show' | 'hide' | 'focus' | 'state';

// ---------------------------------------------------------------------------
// 第 4 步：任务状态机
//
// 权威状态只有一个：主进程 electron/driver.ts 里的 phase；
// 渲染层的横幅 / 状态行只是它的镜像（通过 'state' 事件广播同步）。
// 约束不变：不接大模型——"决定下一步"是基于 read_page 快照的规则判断，
// 且永远不重放暂停前的步骤（恢复时先读用户当前真实页面，再决定）。
// ---------------------------------------------------------------------------

/** 状态机：idle 待命 → running 驾驶中 ⇄ paused 用户接管 → done / failed 终止 */
export type TaskPhase = 'idle' | 'running' | 'paused' | 'done' | 'failed';

/** 主进程广播 / getTaskState 返回的状态快照 */
export interface TaskState {
  phase: TaskPhase;
  /** 人可读的进度或失败原因，直接展示在界面上 */
  detail: string;
  /** 本次运行段已执行的步数（调试用） */
  step: number;
  /** 自动 click / type 当前是否被拒（主进程 paused 门的镜像，调试区据此如实显示） */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// 第 3 步：本地驾驶（遥控器先通，不接 AI）
//
// 一个动作进 → 在内嵌 webview 里执行 → 返回 { ok, pageSnapshot }。
// 这里只有类型，真正的执行在主进程 electron/driver.ts（webContents + CDP）。
// ---------------------------------------------------------------------------

/**
 * 可以在内嵌页上执行的动作。
 *
 * `ask_user` / `done` 本步**只定类型、不接业务**（第 3 步不接大模型），
 * 执行器遇到它们只会返回“未实现”，留着给后面的步骤填。
 */
export type BrowserAction =
  | { action: 'open_url'; url: string }
  | { action: 'click'; target: string }
  | { action: 'type'; target: string; text: string; submit?: boolean }
  | { action: 'scroll'; direction: 'up' | 'down' }
  | { action: 'wait'; seconds: number }
  | { action: 'read_page' }
  | { action: 'screenshot' }
  | { action: 'ask_user'; reason: string; question: string }
  | { action: 'done'; summary: string; document_title: string; document_outline: string[] };

/** 动作名，便于日志与结果回执 */
export type BrowserActionType = BrowserAction['action'];

/** 内嵌页当前状态的只读快照（read_page 的返回值） */
export interface PageSnapshot {
  /** 当前地址 */
  url: string;
  /** document.title */
  title: string;
  /** 可见按钮上的文字 */
  buttons: string[];
  /** 可见链接上的文字 */
  links: string[];
  /** 可见输入框的可读标识（placeholder / name / 当前值） */
  inputs: string[];
}

/** 一次动作的执行结果 */
export interface DriveResult {
  /** 是否执行成功 */
  ok: boolean;
  /** 回执是哪个动作 */
  action: BrowserActionType;
  /** 补充说明（例如「点击了 BUTTON「百度一下」」、type 实际用了哪种写入方式） */
  detail?: string;
  /** 执行后的页面快照（open_url / click / type / scroll / read_page 都会带上） */
  pageSnapshot?: PageSnapshot;
  /** 失败原因（可读文本，直接贴给用户看） */
  error?: string;
  /** screenshot 动作的产物：data URL，只放内存，不落库 */
  screenshot?: string;
}

/**
 * preload 通过 contextBridge 暴露到 window.workbench 的能力白名单。
 * 渲染进程只能看到这里声明的方法，拿不到 ipcRenderer / require / process。
 */
export interface WorkbenchBridge {
  /** 运行平台，例如 win32 / darwin / linux */
  platform: string;
  /** 应用版本号 */
  appVersion: string;
  /** 连通性自检：主进程返回 pong */
  ping: () => Promise<string>;
  /** 打开内嵌浏览器区域；url 省略时沿用当前地址 */
  openBrowser: (url?: string) => Promise<void>;
  /** 显示内嵌浏览器区域 */
  showBrowser: () => Promise<void>;
  /** 隐藏内嵌浏览器区域 */
  hideBrowser: () => Promise<void>;
  /** 聚焦内嵌浏览器区域（隐藏时先显示） */
  focusBrowser: () => Promise<void>;
  /**
   * 第 3 步：在内嵌 webview 上执行一个动作（open_url / click / type / scroll / wait / read_page …）。
   *
   * @param action 要执行的动作
   * @param targetWebContentsId 内嵌 webview 的 guest webContents id
   *        （渲染层用 `webview.getWebContentsId()` 拿）；省略时主进程会自行寻找内嵌 webview。
   */
  drive: (action: BrowserAction, targetWebContentsId?: number) => Promise<DriveResult>;
  /** 只读一次当前页面（等价于 drive({ action: 'read_page' })） */
  readPage: (targetWebContentsId?: number) => Promise<DriveResult>;
  /** 暂停驾驶：之后 click / type 一律拒绝执行，把页面交还给用户手动操作 */
  pauseDriving: () => Promise<boolean>;
  /** 恢复驾驶：允许再次自动 click / type */
  resumeDriving: () => Promise<boolean>;

  // ---- 第 4 步：任务状态机（idle | running | paused | done | failed）----
  /** 启动任务：主进程先 read_page 读当前真实页面，再决定下一步；running/paused 中调用不产生副作用 */
  startTask: () => Promise<TaskState>;
  /** 暂停：立即停止自动 click/type，内嵌页交还用户手点（running 时中断任务循环） */
  pauseTask: () => Promise<TaskState>;
  /** 继续：先 read_page 读用户当前真实页面再决定下一步，禁止重放暂停前的步骤 */
  resumeTask: () => Promise<TaskState>;
  /** 复位：任意状态回到 idle，用于从 done / failed 重新开始 */
  resetTask: () => Promise<TaskState>;
  /** 读取主进程权威状态（渲染进程挂载时初始同步用） */
  getTaskState: () => Promise<TaskState>;

  /** 订阅主进程转发过来的 UI 指令，返回取消订阅函数 */
  on: (event: BrowserEvent, callback: (payload?: string) => void) => () => void;
}
