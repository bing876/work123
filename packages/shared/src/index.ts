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
 *   settings：第 22 步配置变更广播，payload 为 WorkbenchSettings 的 JSON；
 *   resources：Phase 4 资源守护者广播，payload 为 ResourceAlert 的 JSON）
 */
export type BrowserEvent =
  | 'open'
  | 'show'
  | 'hide'
  | 'focus'
  | 'state'
  | 'agent'
  | 'settings'
  | 'resources';

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

  // ---- Phase 4：资源守护者（采集在主进程；渲染层只读 + 上报实例清单）----
  /**
   * 读资源守护者实时视图（最新采样 + 档位 + 阈值 + 去抖计数 + 落盘目录）。
   * 这是本阶段「数据可查」的正门：后续 UI 阶段做提示界面时用的就是它。
   */
  resourceSnapshot: () => Promise<ResourceGuardSnapshot>;
  /**
   * 读历史：最近 `minutes` 分钟内的**汇总点**（60s 粒度）。
   * 原始 5s 采样只在主进程内存里留最近 1 小时，落盘的只有汇总（不让监控自己变成磁盘负担）。
   */
  resourceHistory: (minutes?: number) => Promise<ResourceAggregate[]>;
  /** 读历史警戒事件（最近的在前？不是——按时间正序，取最后 `limit` 条） */
  resourceEvents: (limit?: number) => Promise<ResourceAlert[]>;
  /**
   * 上报当前浏览器实例清单（含每个实例的最后使用时间）——
   * 「最久未使用」排序靠它，主进程自己看不到标签页。
   * 只在**变化时**发（事件驱动），不做固定心跳。
   */
  resourceInstances: (list: BrowserInstanceInfo[]) => Promise<void>;

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

  // ---- Phase 4：资源守护者（阈值与采集频率都在这里，**绝不写死在代码里**）----
  /**
   * 资源守护者开关：**1 = 开（默认）**，0 = 关。
   *
   * 关掉只影响「采集 + 判定 + 提示」，**不影响任何浏览器行为**（不关页、不限开）。
   * 存在的意义有两个：① 验收时做「开监控 / 关监控」的对照测量；
   * ② 万一监控自己出问题，用户/我们有一个开关能立刻让它闭嘴（而不是去改代码）。
   */
  resourceGuardEnabled: number;
  /** 采集间隔（毫秒，默认 5000）。见 electron/resource-guard.ts 顶部对频率取舍的说明。 */
  resourceSampleMs: number;
  /** 内存健康线（MB，默认 3072）：在这条线以下**完全不打扰用户** */
  resourceMemHealthMB: number;
  /** 内存警戒线（MB，默认 4096）：越过它（连续 3 个采样点）触发一次提示 */
  resourceMemWarnMB: number;
  /** CPU 健康线（**全机口径**百分比，默认 20） */
  resourceCpuHealthPct: number;
  /** CPU 警戒线（**全机口径**百分比，默认 35） */
  resourceCpuWarnPct: number;
  /**
   * 「系统可用内存」兜底信号：**1 = 开，0 = 关（默认关）**。
   *
   * 它看的不是本应用占了多少，而是**整机还剩多少**——别的程序先把内存吃掉时，
   * 本应用占用很正常却照样会卡死，这个信号就是为那种情况准备的。
   * 默认关是因为它天然更吵（聊的是整机，不只是我们自己）。
   */
  resourceSysMemGuard: number;
  /** 兜底信号的底线（MB，默认 1536）：系统可用内存低于它 → 也算越线 */
  resourceSysMemFloorMB: number;
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

  // Phase 4：资源守护者（开关类的用 0/1 —— 本套配置全是数值字段，保持同一形态）
  resourceGuardEnabled: { min: 0, max: 1 },
  resourceSampleMs: { min: 1000, max: 60000 },
  resourceMemHealthMB: { min: 256, max: 65536 },
  resourceMemWarnMB: { min: 512, max: 131072 },
  resourceCpuHealthPct: { min: 1, max: 100 },
  resourceCpuWarnPct: { min: 2, max: 100 },
  resourceSysMemGuard: { min: 0, max: 1 },
  resourceSysMemFloorMB: { min: 128, max: 32768 },
} as const;

/**
 * 默认值（子阶段 A：并发默认 **20**；D：多实例上限默认 **4**；Phase 4：资源阈值见下）。
 *
 * Phase 4 这几个数的依据（本机 15.82 GB / 12 逻辑核，子阶段 A 实测 8 页 ≈ 0.67~1.04 GB）：
 *   - 单页边际 ≈ 123 MB → 4 GB ≈ 30 页，是本机内存的 25%；
 *   - 空闲 CPU 基线只有 0.03~0.23%（全机口径），35% = 约 4.2 个核在满载；
 *   - 3072/4096 之间留一段「灰区」，避免阈值抖动导致反复提示。
 * 这三个数**都是可调的**（见上），改配置即可，不需要改代码。
 */
export const DEFAULT_SETTINGS: WorkbenchSettings = {
  maxConcurrentAgentTasks: 20,
  maxBrowserInstances: 4,
  resourceGuardEnabled: 1,
  resourceSampleMs: 5000,
  resourceMemHealthMB: 3072,
  resourceMemWarnMB: 4096,
  resourceCpuHealthPct: 20,
  resourceCpuWarnPct: 35,
  resourceSysMemGuard: 0,
  resourceSysMemFloorMB: 1536,
};

// ---------------------------------------------------------------------------
// Phase 4：资源守护者（持续资源监控）
//
// 产品理念：**不写死浏览器数量上限**，而是「接近资源极限时才友好提示」。
// 所以这一层只做三件事，**任何一件都不改浏览器行为**：
//   1. 持续采集本应用整体的内存 / CPU（主进程 app.getAppMetrics()，不与任务抢线程）；
//   2. 两档阈值：健康线以内完全不打扰；越过警戒线触发**一次**提示（不阻止任何操作）；
//   3. 把数据落盘 + 经 IPC 暴露，供后续 UI 阶段渲染提示界面（本阶段不做正式 UI）。
//
// 三条红线（与本阶段边界一一对应）：
//   - 不设任何写死的实例数量上限（上限仍只有 maxBrowserInstances 那一个可调配置）；
//   - **绝不自动关闭任何浏览器**，决定权永远在用户手里；
//   - 提示里必须标出「正在跑任务」的实例，否则用户可能照着列表关掉正在干活的页。
// ---------------------------------------------------------------------------

/** 资源档位：ok 健康 / elevated 灰区（不提示，只记录）/ warning 警戒（触发提示） */
export type ResourceLevel = 'ok' | 'elevated' | 'warning';

/** 越线原因（可同时成立）：内存 / CPU / 系统可用内存兜底 */
export type ResourceReason = 'mem' | 'cpu' | 'sys-mem';

/** 单个 Electron 进程的资源明细（与任务管理器逐进程对齐用） */
export interface ResourceProcInfo {
  pid: number;
  /** Electron 给的进程类型：Browser / Tab / GPU / Utility … */
  type: string;
  name?: string;
  /** 工作集（MB）—— 与 tasklist / 任务管理器的「内存」同口径 */
  memMB: number;
  /**
   * 这个进程占**整机** CPU 的百分比（= Electron `percentCPUUsage` 原值）。
   *
   * ⚠️ 别看见它就除以核数：Electron 源码里已经除过了 ——
   * `cpu_dict.Set("percentCPUUsage", GetPlatformIndependentCPUUsage() / processor_count)`
   * （`shell/browser/api/electron_api_app.cc`）。所以 12 核机器上一个核满载，这个值读出来是
   * **8.33**（= 100/12），不是 100。整机口径 100% = 所有逻辑核一起跑满。
   */
  cpuPct: number;
}

/**
 * 一条资源采样（主进程算好，渲染层只读 —— 采集口径只有一份，避免两边算得不一样）。
 */
export interface ResourceSample {
  /** epoch 毫秒 */
  at: number;
  atIso: string;
  /** 本应用**全部进程**的工作集之和（MB）。判定用的就是它。 */
  memMB: number;
  /**
   * 本应用**全部进程**占整机 CPU 的百分比 = 各进程 `percentCPUUsage` 之和。
   *
   * **判定与展示都用它**，且**不要再除核数**：Electron 给的每个进程读数已经是整机口径
   * （源码里除过 `processor_count` 了），再加总就是"本应用占整机多少"，
   * 与任务管理器 / `typeperf \Process(*)\% Processor Time` 逐进程求和**同一口径、可直接对比**
   * （100% = 所有逻辑核跑满）。
   *
   * 第一版这里犯的错：把"各进程之和"当成"占一个核的百分比"又除以一次核数 ——
   * 12 核机器上把 CPU 判定灵敏度整整缩小 12 倍（20% 的警戒线实际要等 240% 才可能触发）。
   * 真机取证时发现：一个内嵌页跑满一个核，单进程读数 8.25 ≈ 100/12，正是这个口径的证据。
   */
  cpuPct: number;
  /** 把 cpuPct 换算成"相当于几个核"（`cpuPct/100*logicalCores`）—— 只用于文案，不参与判定 */
  cpuCoresUsed: number;
  /** 逻辑核数（随样本一起给出，便于复核 cpuPct ↔ 核数之间的换算关系） */
  logicalCores: number;
  procCount: number;
  procs: ResourceProcInfo[];
  /** 系统可用内存（MB）；**兜底信号关闭时为 null**（不采集就不假装知道） */
  sysFreeMB: number | null;
  /** 本机物理内存总量（MB），用于把阈值换算成"占整机多少"给人看 */
  sysTotalMB: number;
  /**
   * 这一点所属的**状态档位**（已去抖，与 ResourceGuardSnapshot.level 同一口径）：
   * `ok` 健康 / `elevated` 灰区（只记录、不提示）/ `warning` 已进入警戒。
   */
  level: ResourceLevel;
  /**
   * **这一点自己**的越线原因（**未去抖**；没越线就是空数组）。
   * 所以会出现「reasons 非空但 level=ok」的采样点 —— 那正是一次还没凑够
   * 连续 3 点的毛刺，如实记录而不当成问题。
   */
  reasons: ResourceReason[];
}

/** 一个浏览器实例（给「最久未使用」排序用）——由渲染层上报（它才掌握标签页生命周期） */
export interface BrowserInstanceInfo {
  /** guest webContents id（实例的唯一身份） */
  wcId: number;
  /** 开这张页的智能体（标签页/任务归属仍按它，Phase 3 起没变） */
  agentId: number;
  /** 这张页所属项目（登录态归属，Phase 3 起） */
  projectId: number | null;
  /** 标签显示名（标题优先，兜底域名） */
  title: string;
  url: string;
  /** 建页时间 */
  createdAt: number;
  /** 最后一次「有用」的时间：切到它 / 导航 / 标题变化 / 被驾驶员推进 */
  lastActiveAt: number;
  /** **正在被驾驶员操作** —— 提示里必须标出来（别让用户把在干活的页关掉） */
  driving: boolean;
}

/** 阈值快照（提示事件里存一份：事后能复核"当时是按哪套阈值判的"） */
export interface ResourceThresholds {
  memHealthMB: number;
  memWarnMB: number;
  cpuHealthPct: number;
  cpuWarnPct: number;
  sysMemGuard: number;
  sysMemFloorMB: number;
}

/** 一次警戒提示（主进程拼装好；本阶段只落盘 + 广播，正式样式留给 UI 阶段） */
export interface ResourceAlert {
  /** 事件号（同一次警戒只发一个） */
  id: string;
  at: number;
  atIso: string;
  level: 'warning';
  /** 触发那一刻的采样 */
  sample: ResourceSample;
  reasons: ResourceReason[];
  thresholds: ResourceThresholds;
  /**
   * **最久未使用的排在最前**（按 lastActiveAt 升序）。
   * 含全部实例；`driving=true` 的实例**不从列表里剔除**，只做标记 ——
   * 关不关是用户的决定，我们的责任是把"这个正在干活"如实说清楚。
   */
  idleRanking: BrowserInstanceInfo[];
  /** 人话文案（本阶段复用既有单行提示通道显示，UI 阶段可换成正式组件） */
  text: string;
}

/**
 * 一条**汇总**采样（60s 粒度，落盘的就是这个）。
 *
 * 为什么落盘的不是原始 5s 点：5s × 86400 = 17280 条/天 ≈ 3.5MB/天，
 * 而 60s 汇总只要 1440 条/天 ≈ 290KB/天。监控**不能自己变成新的负担**，
 * 所以落盘只留汇总；原始 5s 点留在主进程内存的环形缓冲里（最近 1 小时）。
 */
export interface ResourceAggregate {
  /** 这个汇总窗口的起点（epoch 毫秒，按 60s 对齐） */
  windowAt: number;
  windowAtIso: string;
  /** 窗口内的点数 */
  count: number;
  memAvgMB: number;
  memMaxMB: number;
  cpuAvgPct: number;
  cpuMaxPct: number;
  /** 窗口内出现过的最高档位 */
  maxLevel: ResourceLevel;
}

/** 资源守护者的实时视图（IPC `workbench:resources:snapshot` 的返回） */
export interface ResourceGuardSnapshot {
  enabled: boolean;
  sampleMs: number;
  /**
   * 主进程自己的 pid。
   *
   * 有了它，"监控自身的开销"才能被**单独**量出来（只看这一个进程的 CPU，
   * 而不是把整个应用的进程一起算）—— 那正是验收标准③要的那个数。
   */
  mainPid: number;
  level: ResourceLevel;
  /** 最新一次采样（还没采到时为 null） */
  sample: ResourceSample | null;
  thresholds: ResourceThresholds;
  /** 连续越线计数（去抖用，暴露出来便于验收核对"连续 3 点"这条） */
  overStreak: number;
  underStreak: number;
  lastAlertAt: number | null;
  /** 同类提示的冷却（毫秒） */
  cooldownMs: number;
  /** 落盘位置（数据可查处，供后续 UI / 排查用） */
  dir: string;
  /** 内存环形缓冲里现有多少点（默认保留最近 1 小时） */
  buffered: number;
}
