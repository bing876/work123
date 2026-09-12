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

// ---------------------------------------------------------------------------
// 第 5 步（重做版）：账号契约 —— XYZ 对外号 + 两套真登录 + 微信占位
//
// - 对外号 xyz_id：系统生成 `XYZ` + 数字（5 位起，用尽升 6/7 位），用户不能自选；
//   register/login 的成功 JSON 都带它。
// - 登录 A：手机号 + 短信验证码（未注册自动建号）；B：XYZ 号 + 密码（没设密码→明确失败）。
// - 微信本步只预留：status.enabled=false；login 直接 501，不发 JWT。
// - 没有邮箱主账号，没有 /chat/stream，不接大模型。
// ---------------------------------------------------------------------------

/** 登录用户对外可见的部分（不含任何密码/手机号明文；phone 只有打码形态） */
export interface AuthUser {
  id: number;
  /** 对外号：XYZ+数字，唯一，系统生成 */
  xyz_id: string;
  /** 是否已设置过密码（false 时 XYZ+密码登录会明确失败提示先设密码） */
  has_password: boolean;
  /** 打码手机号（1 开头 11 位显示为 138****0000 形态；未绑定手机则 null） */
  phone_masked: string | null;
}

/** 注册成功自动创建的项目 */
export interface ProjectSummary {
  id: number;
  name: string;
}

/** 注册成功自动创建的 Agent「小助」 */
export interface AgentSummary {
  id: number;
  name: string;
}

/** 登录成功响应（桌面端存的就是这个；token 不许打印到控制台） */
export interface AuthSession {
  token: string;
  user: AuthUser;
  project: ProjectSummary;
  agents: AgentSummary[];
}

/** GET /auth/me 的响应（同 AuthSession 但不回显 token） */
export type AuthProfile = Omit<AuthSession, 'token'>;

/** GET /auth/wechat/status —— 本步恒为未开通 */
export interface WechatStatus {
  enabled: boolean;
}

/** POST /auth/sms/send 的响应 —— 刻意不含验证码 */
export interface SmsSendResult {
  sent: boolean;
  /** 有效期（秒） */
  expires_in: number;
}

// ---------------------------------------------------------------------------
// 第 6 步：流式聊天契约（AI 只会说话，不指挥浏览器——那是第 7 步）
// 桌面用 fetch 读流（不用 EventSource：它带不了 Authorization 头）
// ---------------------------------------------------------------------------

/** 库里一条聊天消息（历史接口回传的形态；text 是服务端解密后的明文，库里只有密文）。
    顶部那个旧的 ChatMessage 是第 2 步假聊天的遗留壳，别看错。 */
export interface ChatRow {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  created_at?: string;
}

/** GET /chat/history 的响应：没有会话时 conversationId 为 null、messages 为空数组 */
export interface ChatHistoryResult {
  conversationId: number | null;
  messages: ChatRow[];
}

/** /chat/stream 的 SSE 事件负载（data: 里的 JSON） */
export type ChatStreamEvent =
  | { conversationId: number; userMessageId: number } // event: meta（流第一帧）
  | { delta: string } // 打字机：逐段追加
  | { conversationId: number; messageId: number; contentLength: number } // event: done（助手已落库）
  | { error: string }; // event: error（中断/失败：半截不算数）
