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

/**
 * 内嵌浏览器区域可订阅的事件名
 * （state：第 4 步状态机广播，payload 为 TaskState 的 JSON；
 *   settings：第 22 步配置变更广播，payload 为 WorkbenchSettings 的 JSON）
 */
export type BrowserEvent = 'open' | 'show' | 'hide' | 'focus' | 'state' | 'agent' | 'settings';

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
  /**
   * 第 22 步：这份状态属于**哪一张内嵌页**（guest webContents id）。
   *
   * 状态机本身已按 target 独立存储，所以每份状态都知道自己是谁的；
   * 左栏横幅拿到的**聚合视图**也会带上「代表性那一张」的 id（多路时可能省略）。
   */
  wcId?: number;
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
  | { action: 'done'; summary: string; document_title: string; document_outline: string[] }
  /**
   * 第 9 步：一次性代填【普通】字段（姓名/地址/搜索词…）。
   * 敏感字段（密码/验证码/支付/身份证）服务端与本地执行器都有硬闸，填了也会被拒。
   */
  | { action: 'fill_form'; fields: { target: string; text: string }[] }
  /** 第 9 步：定位敏感字段（不带任何值）：聚焦输入框 + 等用户输完自动恢复驾驶 */
  | { action: 'focus_sensitive_field'; target: string; fieldReason: string };

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
  /**
   * 第 21 步：可见正文片段（标题 / 段落 / 列表项上的文字，去重限长）。
   * 没有它，纯正文页（搜索结果、文章、列表）在模型眼里几乎是空的，
   * 「把这一页整理成列表」这类任务做不了。仍然只是片段，不是整页 HTML。
   */
  texts?: string[];
  /**
   * 第 9 步：字段分类标注（敏感字段不出现 value 的任何痕迹）。
   * 由本地 fieldClass.classifyField 生成——服务器只转述，不自己发明规则。
   */
  inputFields?: FieldClassInfo[];
  /**
   * 第 16 步：这一页像不像登录页（有 password 框，或标题/地址带登录字样）。
   * 工具层要能给出「失败原因 + 一个下一步」——「需要先登录」是最常见的真实原因之一。
   */
  loginLike?: boolean;
  /** 第 16 步：是否检测到疑似弹窗/遮罩（会挡住按钮，点击失败的常见原因） */
  overlay?: boolean;
}

/** 一个输入框的分类信息（label 是给人和模型看的描述，绝不含敏感值） */
export interface FieldClassInfo {
  label: string;
  kind: 'sensitive' | 'normal';
  reason: string;
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
  /**
   * 第 17 步：动作执行了，但页面看不出任何变化（地址/标题/节点数都没动）。
   * 用来兑现「点了 2~3 次仍无变化 → 给原因 + 一个下一步」这条，
   * 不是失败（ok 仍为 true），只是给驾驶循环一个「这次多半没点中」的信号。
   */
  noChange?: boolean;
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
   *        （渲染层用 `webview.getWebContentsId()` 拿）。
   *        ⚠️ 第 22 步起**必须显式给出**：多张页并存时主进程不再「自己找一张」，
   *        省略（或给了已失效的 id）会直接返回失败 —— 这是预期的 fail-fast，不是回归。
   */
  drive: (action: BrowserAction, targetWebContentsId?: number) => Promise<DriveResult>;
  /**
   * 只读一次当前页面（等价于 drive({ action: 'read_page' })）。
   * ⚠️ 同 drive：第 22 步起必须显式给出 targetWebContentsId。
   */
  readPage: (targetWebContentsId?: number) => Promise<DriveResult>;
  /** 暂停驾驶：之后 click / type 一律拒绝执行，把页面交还给用户手动操作 */
  pauseDriving: () => Promise<boolean>;
  /** 恢复驾驶：允许再次自动 click / type */
  resumeDriving: () => Promise<boolean>;

  // ---- 第 4 步：任务状态机（idle | running | paused | done | failed）----
  /**
   * 启动任务：主进程先 read_page 读当前真实页面，再决定下一步；running/paused 中调用不产生副作用。
   * @param targetWebContentsId 第 22 步：要驾驶**哪一张**页。必须显式给出（不再盲选）；
   *        省略时沿用上一次那张（「暂停 → 继续」场景）；从来没有目标则当场置 failed。
   */
  startTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /** 暂停：立即停止自动 click/type，内嵌页交还用户手点（running 时中断任务循环） */
  pauseTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /** 继续：先 read_page 读用户当前真实页面再决定下一步，禁止重放暂停前的步骤 */
  resumeTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /** 复位：任意状态回到 idle，用于从 done / failed 重新开始 */
  resetTask: () => Promise<TaskState>;

  /**
   * 第 7 步：启动云端驾驶员循环（一次一步）。
   * @param goal   用户确认过的任务目标
   * @param apiBase 后端地址（http://127.0.0.1:8787）
   * @param token  第 5 步的 JWT——只递给主进程用于请求头，绝不打印
   * @param targetWebContentsId 第 17 步：这次驾驶**哪一张**内嵌页的 guest id。
   *        两路并行时主进程按它分路——同一张页上的新指令覆盖旧指令，
   *        不同页上的指令互不干扰（第二句不会把第一张废掉）。
   * @param opts 第 21 步：工具循环的两个身份——
   *        `agentId`（这一路属于哪个智能体，服务端据此挡住串到别的 bot 的页）
   *        与 `loopId`（/chat/stream 已经建好的那个循环；不带就由主进程自己建一个）。
   */
  agentStart: (
    goal: string,
    apiBase: string,
    token: string,
    targetWebContentsId?: number,
    opts?: { agentId?: number | null; loopId?: string },
  ) => Promise<TaskState>;
  /** 中止**所有**驾驶员循环并清 token（退出登录时也要调） */
  agentStop: () => Promise<void>;
  /**
   * 第 16 步：**放下**当前驾驶员任务但保留登录凭证。
   * 用户改口（例如「打开油管」）时用它：旧任务立刻作废，不再被「继续」重启，
   * 也不会在下一轮把旧目标重新捡起来。
   *
   * 第 17 步：带 targetWebContentsId 时只放下**那一路**（那张页），别路的任务照跑；
   * 不带则放下全部（登出 / 停止）。
   */
  agentDrop: (targetWebContentsId?: number) => Promise<void>;
  /**
   * 第 17 步：当前正在驾驶的 webview guest id 列表。
   * 开第 3 张页时用它挑「没在跑的那张」顶掉——跑着的那张不能动。
   */
  agentLanes: () => Promise<number[]>;

  /**
   * Phase 3：把「这张内嵌页（guest webContents id）是哪个智能体开的」告诉主进程。
   *
   * 为什么需要：分区粒度改成按项目之后，主进程从分区名里只读得到**项目**，
   * 读不到智能体；而下载记录必须能标出「这是哪个智能体触发的」。
   * 渲染层在页就绪时登记一次，主进程据此给下载记录打 owner 标记。
   */
  browserOwner: (webContentsId: number, agentId: number) => Promise<void>;

  /**
   * 第 9 步：把用户对「补资料」提问的回答交给主进程（仅普通资料；敏感值别走这里）。
   * 第 17 步：带 targetWebContentsId 时只喂给**那一路**（那张页），别路不串。
   */
  agentAnswer: (text: string, targetWebContentsId?: number) => Promise<void>;

  /**
   * 第 8 步：下载任务结果文档（.md）。走主进程存盘对话框；内容里由主进程再做一道
   * 脱敏兜底（Bearer/sk-/手机号一律替换），绝不把 Key/JWT/手机号写进文件。
   */
  downloadDoc: (
    taskId: number,
    apiBase: string,
    token: string,
  ) => Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }>;

  /** 读取主进程权威状态（渲染进程挂载时初始同步用） */
  getTaskState: (targetWebContentsId?: number) => Promise<TaskState>;

  /**
   * 第 22 步：读可调配置。权威副本在主进程（userData 下的 JSON），
   * 渲染层启动时同步一次，之后跟随 'settings' 广播。
   */
  getSettings: () => Promise<WorkbenchSettings>;
  /**
   * 第 22 步：改配置（只传要改的字段即可）。主进程会夹到合法区间、落盘，并广播 'settings'，
   * 返回值是夹过之后的**完整**配置，调用方以它为准。
   */
  setSettings: (patch: Partial<WorkbenchSettings>) => Promise<WorkbenchSettings>;

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

/** 一个项目（注册时自动建的那条「默认项目」，以及子阶段 2-A 起用户自己建的项目） */
export interface ProjectSummary {
  id: number;
  name: string;
  /** 是不是「当前使用中的项目」。一个账号同一时刻只有一个 true（没有时回落到 is_default 那条） */
  isCurrent?: boolean;
  /** 是不是建号时自动建的那条默认项目（**不可删**，也是没有 current 时的兜底） */
  isDefault?: boolean;
  /** 子阶段 2-A：这个项目随项目一起创建的「母鸡」智能体 id（老项目/默认项目可能没有） */
  henAgentId?: number | null;
  createdAt?: string;
}

/** GET /projects —— 当前用户的项目列表 */
export interface ProjectListResult {
  projects: ProjectSummary[];
  /** 当前使用中的项目 id（= 列表里 isCurrent 为 true 的那条） */
  currentProjectId: number | null;
}

/** POST /projects 成功响应 */
export interface ProjectCreateResult {
  project: ProjectSummary;
}

/** PATCH /projects/:id（重命名）与 POST /projects/:id/activate（设为当前）成功响应 */
export interface ProjectUpdateResult {
  project: ProjectSummary;
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
  | { conversationId: number; userMessageId: number; agentId?: number | null } // event: meta（流第一帧）
  | { delta: string } // 打字机：逐段追加
  | { conversationId: number; messageId: number; contentLength: number } // event: done（助手已落库）
  /**
   * 第 21 步：这一轮是「页面任务」，服务端已经为它建好工具循环。
   * 桌面拿 loopId 去 /agent/loop/next 要下一步工具，并在**这张页**上执行。
   */
  | { loopId: string; maxSteps: number; agentId?: number | null; pageUrl?: string }
  | { error: string }; // event: error（中断/失败：半截不算数）

// ---------------------------------------------------------------------------
// 第 7 步：云端驾驶员循环 —— 看页 → 只输出一步动作 → 本地执行
//
// 动作类型复用上面的 BrowserAction，不另起第二套。
// 桌面主进程把 read_page 快照 POST 给服务端，服务端只回【一个】动作。
// ---------------------------------------------------------------------------

/** POST /agent/next-action 的请求体（snapshot 就是 read_page 的 PageSnapshot） */
export interface AgentActionRequest {
  /** 服务端 tasks 表里的任务 id（start 之后带上来，用于记步） */
  taskId?: number;
  /** 用户确认过的目标（一句话） */
  goal: string;
  /** 已执行步骤的人话摘要（最近若干条，不含整页 HTML） */
  stepsSummary: string[];
  /** 当前页面快照（url/title/可见元素），继续时一定是最新的 */
  snapshot: PageSnapshot;
  /** true=用户接管中：服务端禁止返回 click/type/open_url */
  paused?: boolean;
}

/** POST /agent/next-action 的响应：单个动作 + 可选的人话备注 */
export interface AgentActionResponse {
  action: BrowserAction;
  note?: string;
}

/** 主进程 → 渲染进程 'agent' 事件负载（JSON 字符串） */
export type AgentEventPayload =
  | { kind: 'step'; step: number; summary: string; ok: boolean }
  | { kind: 'ask'; reason: string; question: string }
  | { kind: 'done'; summary: string; documentTitle: string; documentOutline: string[]; docReady?: boolean; unreadHint?: string }
  | { kind: 'note'; level: 'info' | 'error'; text: string }
  /** 第 9 步：敏感字段等待态——浏览器已前置并聚焦，人话提示在 message 里 */
  | { kind: 'sensitive'; fieldReason: string; message: string };

// ---------------------------------------------------------------------------
// 第 10 步：用户档案记忆 ——「记住这个人」，确认后才注入执行
// ---------------------------------------------------------------------------

/** 一条记忆（服务端已解密成人话文本才下发；库里只有密文） */
export interface MemoryItem {
  id: number;
  type: 'preference' | 'decision' | 'fact';
  content: string;
  updatedAt: string;
}

/** GET /memories：active 进「我的记忆」列表，pending 上确认卡 */
export interface MemoryListResult {
  active: MemoryItem[];
  pending: MemoryItem[];
}

/** POST /memories/extract：preference 已静默入库；pending 才是卡片内容 */
export interface MemoryExtractResult {
  extracted: number;
  pending: MemoryItem[];
  skipped?: string;
}

// ---------------------------------------------------------------------------
// 第 11 步：知识库 —— 用户上传资料的原文片段（独立于 memories，绝不混表）
// ---------------------------------------------------------------------------

/** 一份资料的前端展示元信息。正文不下发；服务端库里文件名和片段正文都是 AES 密文。 */
export interface KnowledgeDocument {
  id: number;
  filename: string;
  kind: 'txt' | 'md' | 'pdf';
  byteSize: number;
  chunkCount: number;
  createdAt: string;
  /** 子阶段 2-A：这份资料归属哪个项目（列表与检索都按项目隔离） */
  projectId?: number;
}

/** GET /knowledge：当前登录用户自己的资料列表及每份资料的已入库段数。 */
export interface KnowledgeListResult {
  documents: KnowledgeDocument[];
}

/** POST /knowledge/upload 成功响应。 */
export interface KnowledgeUploadResult {
  document: KnowledgeDocument;
}

/**
 * 第 19 步 DELETE /knowledge/:id 成功响应。
 * 删除范围是「当前账号的这份资料 + 它的全部切块」；别人的资料删不到，只会得到 404。
 */
export interface KnowledgeDeleteResult {
  id: number;
  deleted: true;
  /** 这次一并删掉的切块数，用于桌面侧回一句人话 */
  removedChunks: number;
}

// ---------------------------------------------------------------------------
// 第 15 步：多智能体（添加 + 聊天内引导表）+ 两层记忆
//
// - 一个智能体 = 一份独立聊天（自己的 conversation）+ 一份项目记忆；
// - 人设（引导表那四格）是**智能体配置**，不是记忆条目；
// - 两层记忆：用户记忆库（账号级，所有智能体都读）/ 项目记忆（智能体级，绝不串）。
// ---------------------------------------------------------------------------

/** 引导表填出来的四格人设。字段名就是表里的行标题，别改名。 */
export interface AgentPersona {
  /** 名称：左栏和聊天里显示的名字 */
  name: string;
  /** 它是谁 */
  who: string;
  /** 怎么说话 */
  tone: string;
  /** 干什么 */
  duty: string;
}

/** 一个智能体在前端可见的形态（GET /agents 的元素） */
export interface AgentView {
  id: number;
  name: string;
  /** 'assistant' = 自带的「小助」（不可删、不强制走引导表）；'custom' = 用户点「添加」新建的；
   *  'hen' = 子阶段 2-A 起「随项目一起创建的母鸡」（不可删、有建智能体的权限） */
  kind: string;
  /** 能不能删（小助与母鸡恒为 false） */
  deletable: boolean;
  /** 子阶段 2-A：这个智能体属于哪个项目 */
  projectId?: number;
  /** 子阶段 2-A：有没有「创建智能体」的权限（母鸡与小助为 true，普通智能体默认 false） */
  canCreateAgents?: boolean;
  /** 'pending' = 引导表还没填完；'ready' = 已按人设干活 */
  personaStatus: 'pending' | 'ready';
  persona: AgentPersona | null;
  /** 这个智能体自己的那条会话；null = 还没有（第一次发消息时服务端会建） */
  conversationId: number | null;
  /** 第 16 步：是否处于「启动并保活」监听态（挂在会话状态上；空闲不调模型） */
  listening?: boolean;
}

/** GET /agents */
export interface AgentListResult {
  agents: AgentView[];
}

/** POST /agents 成功响应：新智能体 + 已经为它建好的空会话 */
export interface AgentCreateResult {
  agent: AgentView;
}

/** 一条记忆（服务端解密成人话才下发；库里只有密文） */
export interface MemoryEntry {
  id: number;
  content: string;
  updatedAt: string;
}

/** GET /memory/user 与 GET /agents/:id/memory 的统一形态 */
export interface MemoryLayerList {
  items: MemoryEntry[];
}

/** POST /agents/:id/tidy：把这段聊天总结进两层记忆（不存整段聊天） */
export interface AgentTidyResult {
  userAdded: number;
  projectAdded: number;
  /** 跳过原因：llm_not_configured / nothing_worth_remembering / empty_transcript … */
  skipped?: string;
}

/** 记忆层：'user' = 账号级用户记忆库；'agent' = 该智能体的项目记忆 */
export type MemoryLayer = 'user' | 'agent';

// ---------------------------------------------------------------------------
// 第 16 步：轻量会话状态（随会话持久化在现有 Postgres 的 conversations 表上）
//
// 这些字段每轮都进模型上下文 —— 否则光改提示词是无效的。
//   current_task     当前任务（最新一句用户消息覆盖它，改口立刻切换）
//   browser_confirmed 本会话是否已确认过用浏览器（已确认 → 普通点击/搜索/滚动/读页不再问）
//   keepalive         「启动并保活」监听态；空闲**不调模型**，来消息才走 /chat/stream
// ---------------------------------------------------------------------------

/** 一个会话的轻量状态（GET /chat/state 回传；字段名与库里列名一致） */
export interface ConversationStateView {
  conversationId: number;
  current_task: string;
  latest_user_intent: string;
  browser_confirmed: boolean;
  login_required: boolean;
  sensitive_action: boolean;
  last_page_summary: string;
  already_told_user_login_themselves: boolean;
  keepalive: boolean;
}

/** GET /chat/state 与 POST /chat/state 的统一响应；还没有会话时 state 为 null */
export interface ChatStateResult {
  conversationId: number | null;
  state: ConversationStateView | null;
}

// ---------------------------------------------------------------------------
// 第 21 步：工具循环（**脑在服务端**，手在桌面主进程）
//
//   用户下任务 → 服务端用 DeepSeek 的 function call 选工具 → 桌面在**当前智能体**
//   的那张 webview 上执行 → 结果（URL / 读页摘要 / 点没点到）喂回模型 → 再选下一步，
//   直到 stop 或用户叫停。循环本体（消息历史、步数上限、prompt、工具表）只在服务端；
//   桌面只当「手」，不自己决定下一步，也不再另写一套 JSON 动作话术。
//
//   工具只有这 6 个，且**全部落在 apps/desktop/src/browser/ 那一套浏览器上**：
//   open_url / read_page / click / type / scroll / stop。
// ---------------------------------------------------------------------------

/** 循环里允许出现的工具名（就是这 6 个，不多不少） */
export type LoopToolName = 'open_url' | 'read_page' | 'click' | 'type' | 'scroll' | 'stop';

/** 模型选出来的一个工具调用 */
export interface LoopToolCall {
  /** 上游给的调用 id（回执要用它对应） */
  id: string;
  name: LoopToolName;
  args: Record<string, unknown>;
}

/** 桌面执行完一个工具后回给服务端的回执（只有人话摘要，不含整页 HTML） */
export interface LoopToolResult {
  ok: boolean;
  /** 执行细节（例如「点击了 BUTTON「百度一下」」） */
  detail?: string;
  /** 失败原因（人话，直接进模型上下文） */
  error?: string;
  /** 动作执行了但页面看不出变化（点没点中） */
  noChange?: boolean;
  /** 执行后的页面快照（read_page / open_url / click / type / scroll 都带） */
  page?: PageSnapshot;
  /** 工具压根没执行（被本地安全闸拦下）时的原因 */
  refused?: string;
  /** 用户在循环跑着的时候补的一句答复（只进上下文，不落库） */
  userAnswer?: string;
}

/** 服务端对循环的一次推进结果：要么给一个工具，要么收尾/提问 */
export type AgentLoopDecision =
  | { kind: 'tool'; call: LoopToolCall; step: number; text?: string }
  | { kind: 'ask'; reason: string; question: string; step: number }
  | { kind: 'done'; summary: string; document_title: string; document_outline: string[]; step: number }
  | { kind: 'say'; text: string; step: number }
  | { kind: 'stopped'; reason: string; step: number };

/** POST /agent/loop/start 的响应 */
export interface AgentLoopStartResult {
  loopId: string;
  /** 这一路属于哪个智能体（服务端用它挡住「串到别的 bot 的页」） */
  agentId: number | null;
  /** 每轮最多几步（配置项，默认 10，允许 8~12） */
  maxSteps: number;
  step: number;
}

/** POST /agent/loop/next 的响应 */
export interface AgentLoopNextResult {
  decision: AgentLoopDecision;
}

// ---------------------------------------------------------------------------
// 第 22 步（浏览器多实例融合）：可调配置
//
// 两条都是**设置里可调**的，绝不写死在代码里：
//   - maxConcurrentAgentTasks —— A1.5 的「同时几路 active agent task」。
//     数据结构按 target 独立设计（见 electron/driver.ts），所以调大这个数就能
//     解锁真并行，**不需要重新设计数据结构**；
//     **子阶段 A 起默认值 = 20**（原来 1）：本阶段要验证的是「技术上真并发没问题」，
//     动态资源限制是后面的子阶段 B。这个开关**本身保留**（继续用它做压力测试 / 临时限流）。
//   - maxBrowserInstances —— D 的多实例上限（默认 4，不是 6）。每张内嵌页 = 一个独立
//     渲染进程 + 一块 session 存储，所以必须有上限防内存失控。
// ---------------------------------------------------------------------------

/** 主进程持久化的可调配置（权威副本在主进程 userData 下的 JSON 里） */
export interface WorkbenchSettings {
  /** 同时最多几路 agent 任务在跑（子阶段 A 起默认 20；调小即临时限流，调大即解锁更多并行） */
  maxConcurrentAgentTasks: number;
  /** 最多同时开几张内嵌页（默认 4；**只拒绝新开，绝不偷偷关掉已有页**） */
  maxBrowserInstances: number;
}

/**
 * 配置的取值范围。主进程读写时一律夹到这个区间里 ——
 * 防止有人手改 JSON 改出负数或 0（那会让功能直接不可用）。
 */
export const SETTINGS_RANGE = {
  /**
   * 子阶段 A：上限从 8 放宽到 20 —— 默认值 20 必须落在合法区间里，
   * 否则「夹到区间」这一步会把默认值本身改回 8。
   */
  maxConcurrentAgentTasks: { min: 1, max: 20 },
  maxBrowserInstances: { min: 1, max: 20 },
} as const;

/** 默认值（子阶段 A：并发默认 **20**；D：多实例上限默认 **4**） */
export const DEFAULT_SETTINGS: WorkbenchSettings = {
  maxConcurrentAgentTasks: 20,
  maxBrowserInstances: 4,
};
