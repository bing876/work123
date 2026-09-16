import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  AgentCreateResult,
  AgentEventPayload,
  AgentListResult,
  AgentPersona,
  AgentTidyResult,
  AgentView,
  AuthProfile,
  AuthSession,
  ChatHistoryResult,
  ChatStateResult,
  ConversationStateView,
  KnowledgeDocument,
  KnowledgeListResult,
  KnowledgeUploadResult,
  MemoryEntry,
  MemoryLayerList,
  TaskState,
} from '@ai-workbench/shared';
import {
  BrowserPanel,
  CONFIRM_ASK_RE,
  CONTINUE_STRONG_RE,
  CONTINUE_WEAK_RE,
  HOME_URL,
  detectBrowseIntent,
  detectOpenUrl,
  detectStopIntent,
  isPureOpenCommand,
  useBrowserWorkspace,
} from './browser';

/**
 * 第 2 步（内嵌版）「脸和门」：
 *   - 脸：主窗口做成一个能看懂的简易聊天界面（假数据 + 内存状态）
 *   - 门：内嵌一个 <webview>，能直接显示真实网页（不再开独立窗口）
 *        —— 第 13 步起这块网页从右栏搬到了中栏聊天的浏览器卡片里
 *
 * 第 3 步「遥控器先通」：
 *   - 右栏底部加一块**很丑的调试区**，用几个按钮证明程序能驾驶这块内嵌页
 *   - 驾驶走 preload → 主进程 → 内嵌 webview 的 webContents（CDP），不接大模型
 *   - 调试区刻意不做美化，UI 统一留给前端会话
 *
 * 第 4 步「任务状态机」：
 *   - idle | running | paused | done | failed 的**权威状态在主进程 driver.ts**，
 *     这里只订阅它的 'state' 广播做镜像（大字横幅 / 状态行）
 *   - 「暂停 / 我来操作」、以及**左侧聊天发一句话**，都让主进程立刻停止自动 click/type
 *   - 「继续」= 主进程先 read_page 读你当前的真实页面再决定下一步（不重放暂停前步骤）
 *   - 不接大模型、不新开窗口、不加标签页、不动右栏宽度与整体 UI
 *
 * 第 5 步（重做版）「账号」：
 *   - 打开先见登录页（手机验证码 / XYZ号+密码 / 微信占位），登录成功才渲染原三栏工作台；
 *   - 注册/登录成功拿到系统分配的对外号 `XYZ+数字`（不可自选），左栏可见；
 *   - 登录后才谈密码：左栏小块可设置/修改（≥8 位，服务端只存哈希）。
 *
 * 第 6 步「真聊天」：
 *   - 中间聊天不再是内存假数据：发一句 → POST /chat/stream 带第 5 步 JWT，SSE 逐字打字机；
 *   - 用 fetch 读流（EventSource 加不了 Authorization 头，所以不用它）；
 *   - 刷新/重启仍登录时 GET /chat/history 还原（服务端从加密的 messages 表解密回传）；
 *   - 第 4 步规矩还在：running 时发这句 = 先让主进程 paused，聊天照发；
 *   - AI 只会说话：不指挥浏览器、不假装开过网页（服务端系统提示词也这么钉死）。
 *
 * 第 7 步「云端驾驶员」：
 *   - 聊天里模型说「这需要用工作台浏览器，确认后我开始操作」时，气泡下出现【确认按钮】；
 *     按钮只挂在**最后一条**确认回复上（旧按钮不再渲染），goal 取该确认之前最近的
 *     那句**用户原话**（例如「打开百度搜天气」）——不读输入框、不取更早的消息，取不到就不开车；
 *   - 循环在**主进程**：read_page → POST /agent/next-action（带 JWT）→ 拿【一个】动作 →
 *     走现有 driver 执行 → 记一步摘要 → 再读页……直到 done / ask_user / 你暂停；
 *   - 暂停语义沿用第 4 步：暂停立刻停手；
 *   - 渲染层只是镜像：聊天里的 ⚠️/✅ 都来自 'agent' 事件。
 *
 * 第 13 步「聊天内浏览器卡片 + 收干净右栏」：
 *   - 用户发**明确开网页指令**（打开百度 / 打开抖音 / 打开 https://… / 打开浏览器）时不再要确认：
 *     中栏聊天里直接插一张卡片，卡片里是**真实 <webview>**（partition=persist:workbench-browser），
 *     能点、能在页面输入框打字；卡片上只有「展开 / 收起」一个按钮，不新开窗口、不做多标签；
 *   - 纯闲聊 / 问知识库 / 问「你是谁」：不弹网页、不加载（判定见 browser/sites.ts 的 detectOpenUrl）；
 *   - 右栏驾驶台（开始任务/暂停/继续/我来操作/复位/示例任务/黄框调试区/浏览器开关）全部撤掉，
 *     状态机保留在主进程内部，不在右栏画状态；右栏只在有任务结果时出现一张结果卡；
 *   - 驾驶目标改为**卡片里这张页**（getWebviewId 拿的就是卡片的 guest），流程没变；
 *   - 敏感闸没动：聊天输入框发 123456 仍被拦下、不落库、不代填；验证码/密码请在网页里自己打。
 *
 * 第 15 步「添加智能体 + 引导表 + 两层记忆」：
 *   - 左栏是**智能体列表**（自带「小助」+ 用户点「添加」建的），点「添加」不发弹窗、不开新窗口：
 *     服务端建一个智能体 + 立刻给它建一条空会话，界面直接切到那个新会话；
 *   - 新会话里第一张就是**引导表**（名称 / 它是谁 / 怎么说话 / 干什么，四行简单表格），
 *     确认后这个智能体才按这份描述干活；没填完也能留着这个会话，模型只引导、不空人设乱聊；
 *   - **会话隔离**：一个智能体一份聊天（各自的 conversation + 各自的消息列表），
 *     切智能体 = 换聊天；流式回包按**发起时那个智能体**落桶，绝不写进别的智能体；
 *   - 网页卡片仍是第 13 步那一张：谁当前在聊谁用，切换后旧卡片降级成一行占位（全窗口恒 1 个 webview）；
 *   - 两层记忆：用户记忆库（账号级，所有智能体都读）/ 项目记忆（智能体级，绝不串）。
 *
 * 第 16 步「智能体行为（最新指令优先 + 确认例外）」：
 *   - 确认是**例外**：用户回「继续 / 可以」且本会话确实有个待确认的浏览器任务时，
 *     桌面直接开卡片 + 立刻起任务（不再让用户点按钮、模型也不再问一遍）；
 *   - 改口立刻切换：running 中用户发明确开页指令（「打开油管」）→ 主进程 agentDrop 掉旧任务，
 *     旧目标不会被「继续」重新捡起来，也不会再问「现在到底是 A 还是 B」；
 *   - 会话状态（current_task / browser_confirmed / keepalive…）存在服务端现有会话表里，
 *     聊天顶部显示状态行，进程重启后据此恢复当前任务；
 *   - 「启动并保活」只标监听态：空闲时服务端一次模型都不调（看 /health 的 llmCalls），
 *     仍在这一个窗口里，不新开窗口、不起新进程。
 *
 * 第 18 步「浏览器模块 + 工作区框架」：
 *   - 浏览器相关的东西**全部收进 apps/desktop/src/browser/**（tab 状态、开/关页、上限 10、
 *     URL 栏、webview 宿主、协议拦截、驾驶接口）；这个文件只挂载 <BrowserPanel ws={browser} />，
 *     不再往里堆开页逻辑。主进程的协议拦截仍在 electron/，桌面侧的浏览器 UI/状态以 browser/ 为准。
 *   - 中栏是**钉住的浏览器工作区**（tab + URL + 当前页），它是 .chat 的兄弟节点，
 *     滚聊天滚不没；切智能体也不收起、不卸载（正在跑的驾驶因此不断）。
 *   - 聊天只说话和结论：开页成功只看 tab，不再每页一条记录；关页只从工作区消失，
 *     聊天里最多留一句人话（单条提示，不列「已关闭」清单）。
 *   - 闲聊不打断驾驶；只有明确的「停」口令才停手（见 browser/intent.ts 的 detectStopIntent）。
 */

type Role = 'user' | 'assistant' | 'browser';
/** 第 17 步：浏览器那行消息记下它对应的 tab，点一下就能把那张页切到前面 */
type Message = { id: number; role: Role; text: string; cardUrl?: string; tabId?: number };
/** 第 15 步：一个智能体 = 一份聊天（自己的消息列表 + 自己的会话号） */
type AgentChat = { messages: Message[]; convId: number | null };
/** 空列表用同一个常量：切智能体时引用稳定，不会每次渲染都造新数组 */
const EMPTY_MESSAGES: Message[] = [];

/**
 * 第 16 步：确认是**例外**，不是默认。
 *
 * 模型只在「本会话第一次要用浏览器、且这句不是明确开页指令」时回那句固定话术；
 * 桌面靠 CONFIRM_ASK_RE（见 ./browser）识别「有一个待确认的浏览器任务」。
 * 用户回「继续 / 可以」= 同意 → **直接开页并起任务**，不再让他点按钮、也不再问一遍。
 * （和 server 端 promptPolicy.isContinueMarker 保持同一套词表。）
 */

/** 第 8 步：GET /agent/task/current 的形态（红点/结果都认这个，不信内存假数据） */
interface CurrentTask {
  id: number;
  status: string;
  goal: string;
  steps: string[];
  unread: boolean;
  summary?: string;
  docTitle?: string;
  unreadHint?: string;
  outline?: string[];
}

/**
 * 第 6 步：不再放写死的开场白。
 * 历史一律以服务端 `/chat/history` 为准（库里的密文解密回传）；
 * 一条都没有时中间区显示一句空态提示，而不是拿假对话冒充“聊过”。
 * 第 15 步：这份历史是**按智能体**分开的——每个智能体只拉自己那条会话。
 */

// ---------------------------------------------------------------------------
// 第 5 步（重做版）：先登录，再进工作台
//
// - 登录页三入口：① 手机号+短信验证码（未注册自动建号，会分到 XYZ 对外号）
//                ② XYZ号+密码（没设过密码会被服务端**明确拒绝**，提示先走手机号）
//                ③ 微信「即将开通」——点它只会出提示，**永远不会进工作台**（服务端 501，不发 token）
// - 登录成功把 JWT 存 localStorage（key: workbench.token）。**绝不往 console 打 token 全文**，
//   下面唯一的日志只输出长度。重开应用时用 /auth/me 静默续会话（effect 带 off 标志防卸载后 setState）。
// - 连不上后端 / 库没起：把服务端的“人话”直接贴给用户，别甩一堆 fetch 栈。
// - 未登录时整个工作台不渲染（登录门控在 App 的 return 处），不做“游客看假数据”那一套。
// ---------------------------------------------------------------------------

/** 后端地址：默认 127.0.0.1:8787；联调别的端口时在 devtools 里 setItem('workbench.apiBase', ...) */
const API_BASE = () => localStorage.getItem('workbench.apiBase') || 'http://127.0.0.1:8787';
const TOKEN_KEY = 'workbench.token';

async function authFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(`连不上后端 ${API_BASE()}：先起库（npm run db:up），再起服务（npm run dev:server）`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

type AuthTab = 'sms' | 'xyz' | 'wechat';

function AuthScreen({ onSession }: { onSession: (s: AuthSession) => void }) {
  const [tab, setTab] = useState<AuthTab>('sms');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [xyz, setXyz] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  /** 获取验证码后的 60 秒冷却（和服务端 60 秒防连发对齐） */
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const smsCodeSent = async () => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      await authFetchJson('/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone: phone.trim() }) });
      setCooldown(60);
      setHint('验证码已发送：开发模式下到跑 dev:server 的终端里抄 [sms:mock] 那行的 6 位码（响应里不会带码）。');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const login = async (path: string, body: Record<string, string>) => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      const sess = await authFetchJson<AuthSession>(path, { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem(TOKEN_KEY, sess.token);
      console.info(`[auth] 登录成功：${sess.user.xyz_id}（token 已保存 ${sess.token.length} 字符，全文不打印）`);
      onSession(sess);
    } catch (e) {
      // 「该账号还没设置过密码…」这类服务端人话原样显示，不吞
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (id: AuthTab, label: string) => (
    <button type="button" className={tab === id ? 'authTab authTab--on' : 'authTab'} onClick={() => { setTab(id); setErr(''); setHint(''); }}>
      {label}
    </button>
  );

  return (
    <div className="authWrap">
      <div className="authCard">
        <h3>登录 AI 工作台</h3>
        <div className="authTabs">
          {tabBtn('sms', '手机验证码')}
          {tabBtn('xyz', 'XYZ号+密码')}
          {tabBtn('wechat', '微信')}
        </div>

        {tab === 'sms' && (
          <>
            <input className="authInput" placeholder="大陆手机号（11 位）" value={phone} maxLength={11}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
            <div className="authRow">
              <input className="authInput" style={{ flex: 1 }} placeholder="6 位验证码" value={code} maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button type="button" className="btn" disabled={busy || cooldown > 0 || phone.length !== 11} onClick={() => void smsCodeSent()}>
                {cooldown > 0 ? `${cooldown}s 后可重发` : '获取验证码'}
              </button>
            </div>
            <button type="button" className="btn btn--go" disabled={busy || phone.length !== 11 || code.length !== 6}
              onClick={() => void login('/auth/login/sms', { phone: phone.trim(), code })}>
              登录 / 注册
            </button>
            <div className="small">未注册的手机号会自动建号，并分配对外号 XYZ+数字（不能自选）。</div>
          </>
        )}

        {tab === 'xyz' && (
          <>
            <input className="authInput" placeholder="XYZ 号（如 XYZ10001，也可只输数字）" value={xyz}
              onChange={(e) => setXyz(e.target.value)} />
            <input className="authInput" type="password" placeholder="密码（≥8 位）" value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn--go" disabled={busy || !xyz || !password}
              onClick={() => void login('/auth/login/xyz', { xyz, password })}>
              登录
            </button>
            <div className="small">没设置过密码的号会在这里被明确拒绝：先用手机号验证码登录后到左栏设密码。</div>
          </>
        )}

        {tab === 'wechat' && (
          <>
            <div className="small" style={{ padding: '8px 0' }}>
              微信登录「即将开通」：本步只在数据库预留了 openid/unionid 字段，未接入真实微信。
            </div>
            <button type="button" className="btn btn--go" onClick={() => setHint('微信登录即将开通，本步点它没有用——请走手机号或 XYZ号+密码。')}>
              用微信登录（即将开通）
            </button>
          </>
        )}

        {hint && <div className="small">{hint}</div>}
        {err && <div className="authErr">{err}</div>}
      </div>
    </div>
  );
}

/** 左栏头像里的那个字：小助固定「助」，自建智能体取名字首字（还没名字就是「新」） */
function agentGlyph(a: AgentView): string {
  if (a.kind === 'assistant') return '助';
  const n = (a.persona?.name || a.name || '').trim();
  return n ? n.slice(0, 1) : '新';
}

/**
 * 第 15 步：聊天里的「引导表」。
 *
 * 用户点「添加」后，**新会话里先摆这张表**（不是先弹一个独立设置窗、更不是后台配置页）：
 * 四行简单表格——名称 / 它是谁 / 怎么说话 / 干什么，加一个确认按钮。
 * 确认 → 服务端存人设 → personaStatus 变 ready，这个智能体才按这份描述干活；
 * 没填完也可以先留着这个会话（服务端这时只让模型引导用户填表，不空人设乱聊）。
 */
function AgentGuide({
  agent,
  onSave,
  onDelete,
}: {
  agent: AgentView;
  onSave: (p: AgentPersona) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(agent.persona?.name ?? '');
  const [who, setWho] = useState(agent.persona?.who ?? '');
  const [tone, setTone] = useState(agent.persona?.tone ?? '');
  const [duty, setDuty] = useState(agent.persona?.duty ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const rows: Array<{ label: string; value: string; ph: string; set: (v: string) => void; max: number }> = [
    { label: '名称', value: name, ph: '它叫什么？', set: setName, max: 24 },
    { label: '它是谁', value: who, ph: '例如：一个只懂电商运营的老手', set: setWho, max: 120 },
    { label: '怎么说话', value: tone, ph: '例如：短句、直接、别客套', set: setTone, max: 120 },
    { label: '干什么', value: duty, ph: '例如：帮我盯店铺数据、写商品标题', set: setDuty, max: 120 },
  ];

  const submit = async () => {
    if (!name.trim() || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSave({ name: name.trim(), who: who.trim(), tone: tone.trim(), duty: duty.trim() });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guide">
      <div className="guide__head">先给这个智能体定个样子</div>
      <div className="small">填完点确认，它才按这份描述干活；没填完也能先留着这个会话。</div>
      <table className="guide__table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td>
                <input
                  className="guide__input"
                  value={r.value}
                  placeholder={r.ph}
                  maxLength={r.max}
                  onChange={(e) => r.set(e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons-row">
        <button type="button" className="btn btn--go guide__ok" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? '保存中…' : '确认，就按这个来'}
        </button>
        <button type="button" className="btn guide__del" onClick={onDelete}>
          删掉这个智能体
        </button>
      </div>
      {err && <div className="authErr">{err}</div>}
    </div>
  );
}

export default function App() {
  /** 头像右上角红点：第 8 步起由服务端 tasks.unread 驱动（登录后拉 current，done 事件点亮，看完熄灭） */
  const [hasUnread, setHasUnread] = useState(false);
  const [curTask, setCurTask] = useState<CurrentTask | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [docNote, setDocNote] = useState('');
  /**
   * 第 4 步：任务状态机的镜像。
   * 权威状态在主进程（driver.ts），挂载时取一次 + 之后靠 'state' 广播同步；
   * 大字横幅「AI 正在控制 / 你正在控制」由它推导，不再用本地 state 猜测。
   */
  const [task, setTask] = useState<TaskState>({
    phase: 'idle',
    detail: '等待主进程同步…',
    step: 0,
    blocked: false,
  });
  const [input, setInput] = useState('');
  /**
   * 第 15 步：**一个智能体一份聊天**。
   * chats[agentId] = { messages, convId }；切换智能体只是换渲染哪一份，
   * 绝不把两个智能体的消息揉成一条时间线。
   */
  const [chats, setChats] = useState<Record<number, AgentChat>>({});
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  const chatsRef = useRef<Record<number, AgentChat>>({});
  chatsRef.current = chats;
  /** 左栏选中的那个智能体；null = 还没拿到列表 */
  const [curAgentId, setCurAgentId] = useState<number | null>(null);
  /** 异步回调里读「此刻是哪个智能体」——直接用 state 会拿到挂载时的旧闭包值 */
  const curAgentRef = useRef<number | null>(null);
  curAgentRef.current = curAgentId;
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  const historyLoadedRef = useRef<Set<number>>(new Set());

  /** 只改**某一个**智能体的那份聊天。异步回包（尤其是流式）必须用它，别用下面的 setMessages */
  const patchChat = (agentId: number, patch: (c: AgentChat) => AgentChat) => {
    setChats((prev) => {
      const cur = prev[agentId] ?? { messages: [], convId: null };
      const next = patch(cur);
      return next === cur ? prev : { ...prev, [agentId]: next };
    });
  };
  const curChat = curAgentId === null ? undefined : chats[curAgentId];
  const messages = curChat?.messages ?? EMPTY_MESSAGES;
  /** 往「当前智能体」那份聊天里追加/替换消息（沿用第 6 步以来的调用点写法） */
  const setMessages = (updater: Message[] | ((prev: Message[]) => Message[])) => {
    const id = curAgentRef.current;
    if (id === null) return;
    patchChat(id, (c) => ({ ...c, messages: typeof updater === 'function' ? updater(c.messages) : updater }));
  };
  /** 第 1 步的 IPC 自检，留着当回归哨兵 */
  const [bridgeInfo, setBridgeInfo] = useState('检测中…');

  // ---- 第 5 步：会话。JWT 从 localStorage 读回后只放内存 state；绝不 console 打全文 ----
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(() => Boolean(localStorage.getItem(TOKEN_KEY)));
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  /** 带已存 token 调 /auth/me：能换回 profile 就静默登录，换不回来就清 token 回登录页 */
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    let off = false; // 卸载标志：慢回来的响应不再 setState
    authFetchJson<AuthProfile>('/auth/me', { headers: { authorization: `Bearer ${saved}` } })
      .then((p) => { if (!off) setSession({ ...p, token: saved }); })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        if (!off) setSession(null);
      })
      .finally(() => { if (!off) setCheckingAuth(false); });
    return () => { off = true; };
  }, []);

  // ---- 第 6 步：流式聊天状态（真聊天，不再是内存假数据）----
  /**
   * 第 13 步：这一轮的**用户原话**是不是「开网页指令」。
   * 是的话，即使模型仍回了「确认后我开始操作」那句老话，也不再挂确认按钮——
   * 网页已经在工作区里打开了，再要用户点确认就是自相矛盾。
   * 第 15 步：按智能体分别记（否则在 A 里开的网页会压掉 B 里的确认按钮）。
   */
  const lastUserWasOpenRef = useRef<Record<number, boolean>>({});
  const [streaming, setStreaming] = useState(false);
  /** 第 15 步：这轮流式是**哪个**智能体在打字——切走后不该在别的智能体里冒出打字气泡 */
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  /** 打字机中的半截助手回复（done 之前只活在这里；库里只有完成的全文） */
  const [streamText, setStreamText] = useState('');
  /** 聊天区一条可关闭的提示（未配置模型 / 出错 / 已先行暂停等），不冒充 AI 的话 */
  const [chatNote, setChatNote] = useState('');

  /**
   * 第 9 步：驾驶员在聊天里等用户回答普通资料（need_info）——回答后自动继续，不用点「继续」。
   * 第 15 步：驾驶员的循环是**全进程一个**（第 7 步的设计），但「这句答复该不该喂给它」要按智能体判——
   * agentAwaitAgent 记住这个提问是**哪个智能体**在等，别的智能体聊天里的回答不会串进去。
   */
  const [agentAwaitInfo, setAgentAwaitInfo] = useState(false);
  const [agentAwaitAgent, setAgentAwaitAgent] = useState<number | null>(null);
  /** 第 17 步：提问来自**哪一张页**（答复只喂给那一路，不串到另一路） */
  const [agentAwaitWcId, setAgentAwaitWcId] = useState<number | null>(null);
  /** 当前这个智能体在等驾驶员提问吗（切到别的智能体就不提示） */
  const awaitHere = agentAwaitInfo && agentAwaitAgent === curAgentId;
  /** 第 15 步：左栏智能体列表（服务端为准）。personaStatus==='pending' 时聊天里摆引导表 */
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentNote, setAgentNote] = useState('');
  /** 第 15 步 · 第一层：用户记忆库（账号级，所有智能体都能读，界面上也列出来） */
  const [userMem, setUserMem] = useState<MemoryEntry[]>([]);
  const [userMemOpen, setUserMemOpen] = useState(false);
  /** 第 15 步 · 第二层：**当前智能体**的项目记忆（智能体级，切智能体就整块换掉） */
  const [projMem, setProjMem] = useState<MemoryEntry[]>([]);
  const [projMemOpen, setProjMemOpen] = useState(false);
  /**
   * 第 16 步：每个智能体的**会话状态**（服务端现有 Postgres 的 conversations 表为准）。
   * current_task / browser_confirmed / keepalive 都从这里来；进程重启后靠它恢复「当前任务」。
   * 异步回包里要用 ref 读最新值（闭包会拿到旧的）。
   */
  const [agentStates, setAgentStates] = useState<Record<number, ConversationStateView>>({});
  const agentStatesRef = useRef<Record<number, ConversationStateView>>({});
  agentStatesRef.current = agentStates;
  /** 保活开关正在请求中（防连点） */
  const [keepaliveBusy, setKeepaliveBusy] = useState(false);
  /** 第 11 步：知识库资料独立于 memories；只展示当前账号的文件元信息和已入库段数。 */
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocument[]>([]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);
  const [knowledgeNote, setKnowledgeNote] = useState('');
  const knowledgeFileRef = useRef<HTMLInputElement | null>(null);
  /** 第 7 步：主进程 'agent' 事件的镜像（步摘要/文档结论），权威循环在主进程 */
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentDoc, setAgentDoc] = useState<{ title: string; outline: string[] } | null>(null);

  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  const pushChatLine = (text: string) => {
    setMessages((prev) => prev.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }));
  };

  /**
   * 第 17 步：按智能体落桶的系统泡。
   * 两路驾驶可能分属两个智能体，事件里的 wcId 决定这条话进谁的聊天 ——
   * 绝不按「此刻正在看的那个智能体」乱写（那正是「聊天串了」）。
   */
  const pushChatLineFor = (agentId: number, text: string) => {
    patchChat(agentId, (c) => ({
      ...c,
      messages: c.messages.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }),
    }));
  };

  /**
   * 第 16 步：找到「最近一次要确认」之前那句用户原话 —— 它就是用户回「继续」时要执行的目标。
   * 取法沿用第 7/8 步（不读输入框、不拿更早的消息）：从该智能体最后一条助手消息往前找，
   * 是确认话术就继续往前找最近一条用户消息；找不到就返回空（那就明确不执行，绝不拿空目标开车）。
   */
  const lastUserGoalBeforeConfirm = (agentId: number): string => {
    const list = chatsRef.current[agentId]?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role !== 'assistant' || !CONFIRM_ASK_RE.test(list[i].text)) continue;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (list[j].role === 'user') return list[j].text.trim();
      }
      return '';
    }
    return '';
  };

  // ---- 第 15 步：两层记忆 + 智能体列表（一切以服务端为准，界面只做展示） ----
  const memHeaders = () => ({ authorization: `Bearer ${sessionRef.current?.token ?? ''}` });

  /** 第一层：用户记忆库（账号级）——任何智能体都读得到，界面也一样列出来 */
  const loadUserMemory = async () => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>('/memory/user', { headers: memHeaders() });
      setUserMem(r.items);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };
  /** 第二层：某个智能体的项目记忆（智能体级）——切智能体就整块换成它自己的 */
  const loadProjectMemory = async (agentId: number) => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>(`/agents/${agentId}/memory`, { headers: memHeaders() });
      // 切走之后晚到的响应不能覆盖当前智能体的那份
      if (curAgentRef.current !== agentId) return;
      setProjMem(r.items);
    } catch {
      /* 同上 */
    }
  };

  /**
   * 第 16 步：拉某个智能体的会话状态（当前任务 / 是否已同意用浏览器 / 是否保活）。
   * 进程重启后靠它把「当前任务」恢复出来，而不是假装任务从未开始。
   */
  const loadAgentState = async (agentId: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<ChatStateResult>(`/chat/state?agentId=${agentId}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      if (r.state) setAgentStates((prev) => ({ ...prev, [agentId]: r.state as ConversationStateView }));
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };

  /**
   * 「启动并保活」：只把该会话标成监听态（服务端 conversations.keepalive）。
   * 空闲时服务端**一次模型都不调**（看 /health 的 llmCalls），有新消息才走 /chat/stream；
   * 不新开窗口、不起新进程、不做 7×24 集群。
   */
  const toggleKeepalive = async () => {
    const sess = sessionRef.current;
    const agentId = curAgentRef.current;
    if (!sess || agentId === null || keepaliveBusy) return;
    const on = !agentStatesRef.current[agentId]?.keepalive;
    setKeepaliveBusy(true);
    try {
      const r = await authFetchJson<ChatStateResult>('/chat/state', {
        method: 'POST',
        body: JSON.stringify({ agentId, keepalive: on }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.state) setAgentStates((prev) => ({ ...prev, [agentId]: r.state as ConversationStateView }));
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, listening: on } : a)));
      setChatNote(
        on
          ? '已启动并保活：这个智能体进入监听态，空闲时不调模型，有新消息才处理（仍在这一个窗口里）。'
          : '已停止保活。',
      );
    } catch (e) {
      setChatNote(`保活开关没成：${(e as Error).message}`);
    } finally {
      setKeepaliveBusy(false);
    }
  };

  /** 拉某个智能体自己的那条会话历史（一个智能体一份聊天，不串） */
  const loadAgentHistory = async (agent: AgentView) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const q = agent.conversationId !== null ? `?conversationId=${agent.conversationId}` : `?agentId=${agent.id}`;
    try {
      const h = await authFetchJson<ChatHistoryResult>(`/chat/history${q}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return; // 切号期间晚到的响应丢掉
      historyLoadedRef.current.add(agent.id);
      patchChat(agent.id, () => ({
        messages: h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
        convId: h.conversationId,
      }));
    } catch (e) {
      setChatNote(`拉取历史失败：${(e as Error).message}`);
    }
  };

  /** 拉智能体列表；当前选中的那个不在了就回到第一个（小助） */
  const loadAgents = async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<AgentListResult>('/agents', { headers: { authorization: `Bearer ${sess.token}` } });
      if (sessionRef.current?.token !== sess.token) return;
      setAgents(r.agents);
      setAgentNote('');
      const cur = curAgentRef.current;
      const stillThere = cur !== null && r.agents.some((a) => a.id === cur);
      if (stillThere) {
        void loadProjectMemory(cur as number);
        void loadAgentState(cur as number);
      } else if (r.agents.length > 0) {
        const first = r.agents[0];
        curAgentRef.current = first.id;
        setCurAgentId(first.id);
        void loadProjectMemory(first.id);
        void loadAgentHistory(first);
        void loadAgentState(first.id);
      }
    } catch (e) {
      setAgentNote(`读不到智能体列表：${(e as Error).message}`);
    }
  };

  /** 切智能体 = 换一份聊天：换消息列表、换项目记忆 */
  const selectAgent = (agent: AgentView) => {
    if (agent.id === curAgentRef.current) return;
    curAgentRef.current = agent.id; // 立刻生效，免得同一 tick 里的回调写错桶
    setCurAgentId(agent.id);
    // 第 18 步：**不动浏览器工作区**——它是窗口级的、钉在中栏，
    // 切智能体只是换聊天，打开着的页和正在跑的驾驶都留在原处。
    setProjMem([]);
    setChatNote('');
    setAgentNote('');
    void loadProjectMemory(agent.id);
    if (!historyLoadedRef.current.has(agent.id)) void loadAgentHistory(agent);
  };

  /**
   * 点「添加」：服务端建一个智能体 + 立刻给它建一条空会话，界面直接切到那个新会话。
   * 不弹独立设置窗、不开新 BrowserWindow —— 引导表就摆在这个新会话里。
   */
  const addAgent = async () => {
    const sess = sessionRef.current;
    if (!sess || agentBusy) return;
    setAgentBusy(true);
    setAgentNote('');
    try {
      const r = await authFetchJson<AgentCreateResult>('/agents', {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const a = r.agent;
      setAgents((prev) => prev.concat(a));
      historyLoadedRef.current.add(a.id);
      patchChat(a.id, () => ({ messages: [], convId: a.conversationId }));
      curAgentRef.current = a.id;
      setCurAgentId(a.id);
      setProjMem([]);
      setProjMemOpen(false);
      setChatNote('');
    } catch (e) {
      setAgentNote(`添加没成：${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  };

  /** 引导表确认：存人设 → 这个智能体从这一刻起按这份描述干活 */
  const savePersona = async (agentId: number, persona: AgentPersona) => {
    const sess = sessionRef.current;
    if (!sess) throw new Error('还没登录');
    const r = await authFetchJson<AgentCreateResult>(`/agents/${agentId}/persona`, {
      method: 'POST',
      body: JSON.stringify(persona),
      headers: { authorization: `Bearer ${sess.token}` },
    });
    setAgents((prev) => prev.map((x) => (x.id === agentId ? r.agent : x)));
    setChatNote(`好，${r.agent.name} 已就位——从现在起它按你填的这份描述干活。`);
  };

  /** 删自建智能体（「小助」服务端会拒）：它的聊天与项目记忆一并清掉，不碰别的智能体 */
  const deleteAgent = async (agentId: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson(`/agents/${agentId}`, {
        method: 'DELETE',
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const next = agents.filter((x) => x.id !== agentId);
      setAgents(next);
      setChats((prev) => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      historyLoadedRef.current.delete(agentId);
      setAgentStates((prev) => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      if (curAgentRef.current === agentId) {
        const first = next[0];
        curAgentRef.current = first ? first.id : null;
        setCurAgentId(first ? first.id : null);
        setProjMem([]);
        if (first && !historyLoadedRef.current.has(first.id)) void loadAgentHistory(first);
      }
      // 第 18 步：这个智能体开的那些网页一并关掉（它那几路驾驶也一起放下）
      browser.closeTabsOfAgent(agentId);
      setChatNote('已删掉这个智能体（它的聊天和项目记忆一并清掉，没碰别的智能体）。');
    } catch (e) {
      setChatNote(`删除没成：${(e as Error).message}`);
    }
  };

  /**
   * 「结束」：把这段聊天**总结**进两层记忆（不是把整段聊天当记忆存）。
   * 服务端按「偏口味/习惯 → 用户库；偏这个项目的业务/资料 → 该智能体项目记忆」分类，
   * 敏感信息在写入前一律整条丢弃。
   */
  const tidyCurrentAgent = async () => {
    const sess = sessionRef.current;
    const agentId = curAgentRef.current;
    if (!sess || agentId === null) return;
    const convId = chatsRef.current[agentId]?.convId ?? null;
    setChatNote('正在把这段聊天总结进两层记忆…');
    try {
      const r = await authFetchJson<AgentTidyResult>(`/agents/${agentId}/tidy`, {
        method: 'POST',
        body: JSON.stringify({ conversationId: convId ?? undefined }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.skipped === 'llm_not_configured') setChatNote('没配 DEEPSEEK_API_KEY，这次没整理记忆。');
      else if (r.skipped === 'empty_transcript') setChatNote('还没聊过天，没有可整理的。');
      else setChatNote(`整理完了：用户记忆库 +${r.userAdded} 条，本项目记忆 +${r.projectAdded} 条。`);
      void loadUserMemory();
      void loadProjectMemory(agentId);
    } catch (e) {
      setChatNote(`整理记忆没成：${(e as Error).message}`);
    }
  };

  /** 忘掉一条：user = 账号级用户记忆库；agent = 当前智能体的项目记忆 */
  const forgetEntry = async (layer: 'user' | 'agent', id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memory/forget', {
        method: 'POST',
        body: JSON.stringify({ layer, id }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (layer === 'user') void loadUserMemory();
      else if (curAgentRef.current !== null) void loadProjectMemory(curAgentRef.current);
    } catch (e) {
      setChatNote(`忘掉失败：${(e as Error).message}`);
    }
  };

  /** 第 8 步：任务快照（状态/未读/结果）——红点的唯一事实源。
   *  用 ref 拿会话：agent 订阅 effect 是挂载时建的闭包，直接引用 session 会拿到旧的 null。 */
  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;

  // ---- 第 11 步：资料上传/列表。文件直接由当前渲染进程 POST 到本机服务端，
  // 不经过 preload，不开新窗口；multipart 的 Content-Type 必须让浏览器自己带 boundary。 ----
  const loadKnowledge = async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<KnowledgeListResult>('/knowledge', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // 切号期间晚到的 A 号响应不能覆盖 B 号列表。
      if (sessionRef.current?.token !== sess.token) return;
      setKnowledgeDocs(r.documents);
    } catch {
      /* 资料列表属于辅助入口，后端暂不可达时不打扰已登录界面 */
    }
  };
  const uploadKnowledgeFile = async (file: File) => {
    const sess = sessionRef.current;
    if (!sess || knowledgeUploading) return;
    const supported = /\.(txt|md|pdf)$/i.test(file.name);
    if (!supported) {
      setKnowledgeNote('只支持 .txt、.md、.pdf 文件。');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setKnowledgeNote('文件超过 12 MB，本版请拆分后上传。');
      return;
    }
    setKnowledgeNote('');
    setKnowledgeUploading(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      let res: Response;
      try {
        res = await fetch(`${API_BASE()}/knowledge/upload`, {
          method: 'POST',
          headers: { authorization: `Bearer ${sess.token}` },
          body: form,
        });
      } catch {
        throw new Error(`连不上后端 ${API_BASE()}：先起库（npm run db:up），再起服务（npm run dev:server）`);
      }
      const data = (await res.json().catch(() => ({}))) as KnowledgeUploadResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // 若用户在上传过程中退出/切换账号，不把旧账号的成功提示带到新账号界面。
      if (sessionRef.current?.token !== sess.token) return;
      const doc = data.document;
      setKnowledgeNote(`《${doc.filename}》已入库，共 ${doc.chunkCount} 个片段。`);
      await loadKnowledge();
    } catch (e) {
      setKnowledgeNote(`上传没有入库：${(e as Error).message}`);
    } finally {
      setKnowledgeUploading(false);
    }
  };
  const onChooseKnowledgeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // 清空值后，用户选择同一份文件也会再次触发 change。
    event.currentTarget.value = '';
    if (file) void uploadKnowledgeFile(file);
  };

  const refreshTask = async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<{ task: CurrentTask | null }>('/agent/task/current', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.task) {
        setCurTask(r.task);
        setHasUnread(r.task.status === 'done' && r.task.unread);
      }
    } catch {
      /* 后端/库没起时红点保持原样，不打扰 */
    }
  };

  /** 看完结果 → 服务端标记已读、红点熄灭 */
  const openTaskResult = async () => {
    if (!curTask) return;
    setTaskDetailOpen(true);
    if (curTask.unread) {
      const sess = sessionRef.current;
      try {
        await authFetchJson('/agent/task/read', {
          method: 'POST',
          body: JSON.stringify({ taskId: curTask.id }),
          headers: { authorization: `Bearer ${sess?.token ?? ''}` },
        });
        setCurTask({ ...curTask, unread: false });
        setHasUnread(false);
      } catch {
        /* 标已读失败就留着红点，下次再点 */
      }
    }
  };

  /** 下载 .md：主进程弹“另存为”+写盘，内容经脱敏兜底 */
  const downloadTaskDoc = async () => {
    if (!curTask || !session) return;
    setDocNote('正在准备文档…');
    const r = await window.workbench?.downloadDoc(curTask.id, API_BASE(), session.token);
    if (!r) return;
    if (r.saved) setDocNote(`已保存：${r.path}`);
    else if (r.canceled) setDocNote('已取消保存');
    else setDocNote(`下载失败：${r.error ?? '未知原因'}`);
  };

  /**
   * 会话变了：把**所有**智能体的聊天缓存清掉，重新拉智能体列表 / 用户记忆库 / 任务快照 / 资料列表。
   * 具体某个智能体的历史由 loadAgents → loadAgentHistory 拉（一个智能体一份聊天，互不干扰）。
   */
  useEffect(() => {
    setChats({});
    setCurAgentId(null);
    curAgentRef.current = null;
    historyLoadedRef.current = new Set();
    setAgents([]);
    setAgentNote('');
    setUserMem([]);
    setProjMem([]);
    if (!session) return;
    void refreshTask();
    void loadAgents();
    void loadUserMemory();
    void loadKnowledge(); // 第 11 步：只拉本人资料的文件名/段数，不把正文拉回前端
  }, [session]);

  const onSubmitPassword = async () => {
    if (!session) return;
    setPwMsg('');
    try {
      const body: Record<string, string> = { new_password: pwNew };
      if (session.user.has_password) body.old_password = pwOld;
      const r = await authFetchJson<{ ok: boolean; message: string }>('/auth/password/set', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${session.token}` },
      });
      setPwMsg(r.message);
      setPwOld('');
      setPwNew('');
      setSession((s) => (s ? { ...s, user: { ...s.user, has_password: true } } : s));
    } catch (e) {
      setPwMsg((e as Error).message);
    }
  };

  const onLogout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
    setPwMsg('');
    // 第 6 步：聊天痕迹也清掉（历史本来就在服务端，重启登录后由 /chat/history 还原）
    setChatNote('');
    setStreamText('');
    // 第 15 步：所有智能体的聊天、列表、两层记忆全部清掉（会话 effect 也会兜一遍）
    setChats({});
    setCurAgentId(null);
    curAgentRef.current = null;
    historyLoadedRef.current = new Set();
    setAgents([]);
    setAgentNote('');
    setUserMem([]);
    setUserMemOpen(false);
    setProjMem([]);
    setProjMemOpen(false);
    setAgentStates({}); // 第 16 步：会话状态（当前任务/保活）不留在登录页
    setKeepaliveBusy(false);
    // 第 7 步：驾驶员循环和 token 一并停掉/清掉（主进程里也不留）
    void window.workbench?.agentStop();
    // 第 18 步：所有网页一并关掉（换号不该看见上一个号的网页）——由浏览器工作区自己清
    browser.closeAllTabs();
    setAgentSteps([]);
    setAgentDoc(null);
    setCurTask(null);
    setTaskDetailOpen(false);
    setDocNote('');
    setHasUnread(false);
    setAgentAwaitInfo(false);
    setAgentAwaitAgent(null);
    setKnowledgeDocs([]);
    setKnowledgeOpen(false);
    setKnowledgeUploading(false);
    setKnowledgeNote('');
  };

  // ---- 第 18 步：中栏浏览器工作区（tab + URL 栏 + 页；同时最多 MAX_LIVE_PAGES 张活页）----
  /**
   * 浏览器相关的**全部状态与动作**都在 apps/desktop/src/browser/ 里，这里只把它挂上：
   *   - tab 状态、开页/关页、上限 10、同站复用、满了顶最旧 → browser/useBrowserWorkspace.ts
   *   - URL 栏 / webview 宿主 / 桌面侧协议闸 → browser/BrowserPanel.tsx、browser/url.ts
   *   - 「打开百度」→ URL、「在这张页面上做事」/「停」→ browser/sites.ts、browser/intent.ts
   *
   * onNote 是它唯一往聊天里说话的通道：**只有「顶掉 / 排队 / 关页」才说一句**，
   * 开页成功一个字都不写（看顶栏多出来的那个 tab 就是结果）。
   * getCurrentAgent 让主进程发来的「打开某网址」落给此刻正在聊的那个智能体。
   */
  const browser = useBrowserWorkspace({
    onNote: setChatNote,
    getCurrentAgent: () => curAgentRef.current,
  });

  useEffect(() => {
    const bridge = window.workbench;

    if (!bridge) {
      setBridgeInfo('未检测到 preload 桥');
      return;
    }

    bridge
      .ping()
      .then((reply) => setBridgeInfo(`${bridge.platform} · ${reply}`))
      .catch(() => setBridgeInfo('preload 桥调用失败'));
  }, []);

  // 订阅主进程转发过来的 UI 指令（open / show / hide / focus / state）
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;

    // 第 4 步：状态机镜像 = 初始拉取一次 + 订阅广播（主进程是权威，这里只跟随）
    bridge
      .getTaskState()
      .then(setTask)
      .catch(() => setTask((s) => ({ ...s, detail: '读取主进程状态失败（preload 桥异常）' })));
    const offState = bridge.on('state', (payload) => {
      if (!payload) return;
      try {
        setTask(JSON.parse(payload) as TaskState);
      } catch {
        /* 坏负载忽略，等下一次广播 */
      }
    });

    // 第 18 步：主进程的浏览器指令交给**浏览器工作区**处理（它才知道 tab 的事）。
    // 'open' 开/复用一张页；'focus'（敏感字段等待时会发）确保那张页存在并把焦点给它。
    // 'show' / 'hide' 不再有对应界面（网页始终在中栏工作区里），保留订阅只是不炸。
    const offOpen = bridge.on('open', (url) => {
      if (url) browser.openFromMain(url);
    });
    const offShow = bridge.on('show', () => undefined);
    const offHide = bridge.on('hide', () => undefined);
    // 第 17 步：主进程发来的 focus 带 guest id —— 焦点要给**那一张**页（多路并行时不能瞎给）
    const offFocus = bridge.on('focus', (payload) => {
      const wcId = Number(payload);
      if (Number.isInteger(wcId)) browser.focusByWebContents(wcId);
      else browser.focusActive();
    });

    return () => {
      offOpen();
      offShow();
      offHide();
      offFocus();
      offState();
    };
  }, []);

  // 订阅主进程驾驶员事件：ask/done/note 进聊天区
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;
    let off = false;
    const offAgent = bridge.on('agent', (payload) => {
      if (!payload) return;
      let p: AgentEventPayload & { wcId?: number };
      try {
        p = JSON.parse(payload) as AgentEventPayload & { wcId?: number };
      } catch {
        return;
      }
      if (off) return;
      /**
       * 第 17 步：事件里带着 guest id —— 先认它属于**哪张页**、那张页是**哪个智能体**开的，
       * 再把话落回那个智能体的聊天里。两路分属两个智能体时，绝不把 A 的步摘要写进 B。
       */
      const tabId = typeof p.wcId === 'number' ? browser.tabIdOfWebContents(p.wcId) : null;
      const ownerAgent = (tabId !== null ? browser.ownerOf(tabId) : undefined) ?? curAgentRef.current;
      const say = (text: string) => {
        if (ownerAgent !== null && ownerAgent !== undefined) pushChatLineFor(ownerAgent, text);
      };
      const here = ownerAgent === curAgentRef.current;
      if (p.kind === 'step') {
        setAgentSteps((prev) => prev.concat(`${p.summary}${p.ok ? '' : ' ❌'}`).slice(-6));
      } else if (p.kind === 'ask') {
        setAgentSteps([]);
        say(`⚠️ ${p.question}`);
        const needInfo = p.reason === 'need_info';
        setAgentAwaitInfo(needInfo);
        // 第 15 步：记下「是哪个智能体在等这句话」，答复才不会串到别的智能体
        setAgentAwaitAgent(needInfo ? (ownerAgent ?? null) : null);
        // 第 17 步：再记下「是哪张页在等」，答复只喂给那一路
        setAgentAwaitWcId(needInfo && typeof p.wcId === 'number' ? p.wcId : null);
        if (needInfo && here) setChatNote('小助在等你答这句话——直接在下面输入框回答即可，发出后会自动继续（不用点「继续」）。');
        void browser.refreshDriving();
      } else if (p.kind === 'sensitive') {
        say(`🔒 ${p.message}`);
        void browser.refreshDriving();
      } else if (p.kind === 'done') {
        setAgentAwaitInfo(false);
        setAgentAwaitAgent(null);
        setAgentAwaitWcId(null);
        say(`✅ 任务完成：${p.summary}${p.docReady ? ` · ${p.unreadHint ?? '结果文档已生成'}` : '（文档未就绪：后端未配置模型或库未起，见后端日志）'}`);
        setAgentDoc({ title: p.documentTitle, outline: p.documentOutline });
        // 第 8 步：红点由服务端确认（finish 已置 unread=true），这里点亮并刷新卡片
        setHasUnread(true);
        void refreshTask();
        void browser.refreshDriving();
      } else if (p.kind === 'note') {
        say(`${p.level === 'error' ? '⚠️' : 'ℹ️'} ${p.text}`);
        if (/继续|恢复驾驶/.test(p.text)) {
          setAgentAwaitInfo(false);
          setAgentAwaitAgent(null);
          setAgentAwaitWcId(null);
        }
        if (p.level === 'error') void browser.refreshDriving();
      }
      /**
       * 第 17 步：循环收尾时主进程是「**先把事件发出来、再从运行表里摘掉这一路**」，
       * 所以收到事件这一刻 agentLanes() 往往还看得到它 —— 标签上那个「● 正在驾驶」
       * 就会一直亮着（明明已经没有一路在跑了）。
       * 隔一拍再刷一次，圆点才会跟着灭。step 事件太频繁，不参与这次补刷。
       */
      if (p.kind !== 'step') {
        window.setTimeout(() => {
          void browser.refreshDriving();
        }, 1200);
      }
    });
    return () => {
      off = true;
      offAgent();
    };
    // pushChatLine/setMessages 都是稳定 setState，无需入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  /**
   * 第 6 步：发送 = 走 /chat/stream（带 JWT，fetch 读 SSE；EventSource 加不了 Authorization 所以不用它）。
   * 第 4 步规矩保留：running 时先让主进程暂停（权威横幅由 'state' 广播改回「你正在控制」），聊天照发。
   */
  const sendChat = async () => {
    if (!session) return;
    const value = input.trim();
    if (!value || streaming) return;
    /**
     * 第 15 步：**这轮消息属于哪个智能体，在发起时就钉死**。
     * 后面所有写入（用户句、流式半截、助手全文）都用这个 id 落桶——
     * 中途切到别的智能体，也绝不会把 A 的话写进 B 的聊天里。
     */
    const myAgent = curAgentRef.current;
    if (myAgent === null) return;
    setChatNote('');
    // 第 9 步本地闸：聊天里出现「密码/验证码：xxx」这类赋值就拦下——不发送、不落库、
    // 让敏感值只走浏览器输入框（服务端聊天与代填执行层各有自己的闸，这是第一道）。
    // 形态判定：敏感关键词后面跟着「像值的串」（≥6 位字母数字符号），或整句就是 4~8 位纯数字；
    // 只是提到关键词（“验证码一般几位”）不会被拦——宁可拦赋值、不问句误伤。
    if (/(密码|口令|password|passcode|验证码|校验码|captcha|otp|cvv|银行卡|卡号|身份证)[\s:：=是为]{0,3}[A-Za-z0-9*#@$%&+=.-]{6,}/i.test(value)
      || /^\s*\d{4,8}\s*$/.test(value)) {
      setChatNote('这看起来像密码/验证码/卡号：请不要发到聊天里。直接点在中栏工作区那张页的输入框上自己打（我把焦点给这张页面），我不会代填、也不会留存。');
      // 第 15 步：顺手把输入框清空——否则这串敏感值会一直留在框里，
      // 下一次输入变成「123456打开百度」这种拼串，既难查也等于没拦住。
      setInput('');
      try {
        browser.focusActive();
      } catch {
        /* 聚焦失败不碍事 */
      }
      return;
    }
    /**
     * 第 18 步：**只有明确的「停」才停手**。
     * 闲聊（你好 / 谢谢 / 你是谁）绝不打断正在跑的驾驶；「停 / 停下来 / 别动了 / 暂停」才停——
     * 当前这张页在跑就只停那一路，否则全停（判定见 browser/intent.ts 的 detectStopIntent）。
     */
    if (detectStopIntent(value)) {
      browser.stopDriving();
      setChatNote('好，停手了——这一路不再动作。要它接着干，直接说下一步就行。');
    }
    // 第 13 步：明确的开网页指令 → 不再要确认，中栏浏览器工作区直接开一张真实网页。
    // 判定纯本地（不联网、不问模型），所以后端/模型没起来时页面照样打开。
    const openUrl = detectOpenUrl(value);
    /**
     * 第 16 步缺项修复：**已经有打开的网页**时，「普通浏览指令」（在这个页面搜一下 AI / 读一下当前页 /
     * 往下滚…）必须交给**驾驶员**去动**当前切到前面的那张**页 —— 不能再只回一句口头「稍等」。
     *
     * 判定纯本地（不联网、不问模型）：一张页都没开就不发车（不开第二张、不新窗口），
     * 闲聊（你好 / 谢谢 / 你是谁）也不发车。
     */
    const activeTab = browser.active;
    const browseGoal = openUrl === null && activeTab ? detectBrowseIntent(value) : null;
    /**
     * 第 16 步：确认是**例外**不是默认。
     * 「继续 / 可以」这类回答只有在**本会话确实有一个待确认的浏览器任务**时才算同意：
     * 判定只看**这个智能体**自己那份聊天里最后一条助手回复是不是在要确认。
     * 一旦算同意 → 直接开页 + 立刻起任务，不再让用户点按钮、也不再问一遍。
     */
    const pendingConfirm =
      openUrl === null &&
      (CONTINUE_STRONG_RE.test(value) || CONTINUE_WEAK_RE.test(value)) &&
      (() => {
        const list = chatsRef.current[myAgent]?.messages ?? [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].role === 'assistant') return CONFIRM_ASK_RE.test(list[i].text);
        }
        return false;
      })();
    /** 待确认任务的原始目标 = 那条确认之前最近的一句用户原话（沿用第 7/8 步的取法） */
    const pendingGoal = pendingConfirm ? lastUserGoalBeforeConfirm(myAgent) : '';
    const goNow = pendingConfirm && Boolean(pendingGoal);
    /** 这句话本身就算「已确认」：明确开页指令、对确认提问回「继续/可以」、或已在当前页面上干活 */
    const confirmedByThisMessage = openUrl !== null || goNow || browseGoal !== null;
    lastUserWasOpenRef.current[myAgent] = confirmedByThisMessage;

    /**
     * 第 17 步（用户拍板）：**纯闲聊不打断两路驾驶**。
     *
     * 旧行为是「发一句话就把驾驶员暂停」，但本步要求任务能在你聊别的事时继续跑、
     * 不用你盯着点「继续」——所以这里不再全局 pauseTask。
     * 第 18 步起，唯一让驾驶停下来的入口是明确的「停」口令（见上面的 detectStopIntent）；
     * 同一张页再来一条新指令 → 主进程 agentStart 让那一路的旧循环作废（最新指令优先），
     * 别的页上正在跑的那一路完全不动。
     */
    // 用户这句话先落桶（按发起时的智能体）
    patchChat(myAgent, (c) => ({ ...c, messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }) }));

    /**
     * 在**某一张**页上发车（第 17 步：必须点名哪张页；主进程不再自己瞎挑一张）。
     * 别路不动 —— 这就是「第二句不会把第一张降级成不能动的占位」。
     */
    const startOnTab = async (tabId: number, goal: string, note: string) => {
      const wcId = await browser.awaitWebContentsId(tabId);
      if (typeof wcId !== 'number') {
        setChatNote('这张页还没准备好（拿不到内嵌页句柄），没有发车。');
        return;
      }
      setAgentSteps([]);
      setAgentDoc(null);
      setChatNote(note);
      // token 递给主进程只用于请求头；不打印
      void window.workbench?.agentStart(goal, API_BASE(), session.token, wcId);
      window.setTimeout(() => {
        void browser.refreshDriving();
      }, 400);
    };

    if (openUrl) {
      // 明确开页指令 → 打开（同站则复用）那张页。
      // 第 18 步：「打开百度」这类**纯开页**只走工作区——页开出来就完事了，不发车，
      // 否则每开一张页聊天里就多一条「任务完成 · 某某已打开」（本步要治的刷屏），
      // 还白烧一次「读页 → 问模型」。带活的（「打开百度搜天气」）照旧发车。
      const tabId = await browser.openUrl(myAgent, openUrl);
      if (tabId !== null && !isPureOpenCommand(value)) {
        await startOnTab(tabId, value, '已把这条指令交给驾驶员，在刚打开的那张页上执行（不新开窗口）。');
      }
    } else if (goNow) {
      // 「继续」= 直接执行：打开目标站点后立刻把目标交给驾驶员循环
      const tabId = await browser.openUrl(myAgent, detectOpenUrl(pendingGoal) ?? HOME_URL);
      if (tabId !== null) await startOnTab(tabId, pendingGoal, '按你的确认开始执行。');
    } else if (browseGoal && activeTab) {
      // 普通浏览指令 → 复用**当前这张**页发车（同页新指令 = 最新指令优先，旧动作当场停）
      await startOnTab(activeTab.id, browseGoal, '已把这条指令交给驾驶员，在**当前这张**网页上执行（不新开页）。');
    }
    setInput('');
    setHasUnread(false);
    setStreaming(true);
    setStreamingAgentId(myAgent);
    setStreamText('');
    try {
      const res = await fetch(`${API_BASE()}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        // browserOpened 只是给服务端系统提示词的一个开关：告诉小助「网页已经开好了」，
        // 别再让用户点确认。不是网页内容、不进历史、不落库。
        // agentId 让服务端在没带会话号时也只认这个智能体自己的会话（绝不串到别人的）。
        body: JSON.stringify({
          conversationId: chatsRef.current[myAgent]?.convId ?? undefined,
          agentId: myAgent,
          message: value,
          // 明确开页指令 → 报新开的地址；在当前这张页面上干活 → 报这张页的地址。
          // 两者都是「网页已经开好了」，让基座别再让用户点确认（与驾驶员路径同一套）。
          ...(openUrl || (browseGoal && activeTab?.url) ? { browserOpened: openUrl ?? activeTab?.url } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        // 服务端在开流前给的 JSON 人话（503 未配置模型 / 400 / 401…）原样贴出来
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; code?: string };
          if (j.code === 'llm_not_configured') msg = '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server';
          else if (j.error) msg = j.error;
        } catch {
          /* 非 JSON 错误体，维持 HTTP 状态码 */
        }
        // 第 13 步：开网页指令即使这句没发给小助，页也已经开好了——先说清楚，
        // 免得用户以为「开网页」也失败了（后端/模型没起是另一回事，照实说）。
        setChatNote(`${openUrl ? '网页已经打开在中栏浏览器工作区里；' : ''}没发出去：${msg}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      let sawDone = false;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        const blocks = buf.split(/\r?\n\r?\n/);
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          const lines = block.split(/\r?\n/);
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
          const dl = lines.find((l) => l.startsWith('data:'));
          if (!dl) continue;
          let j: { delta?: string; error?: string; conversationId?: number };
          try {
            j = JSON.parse(dl.slice(5).trim());
          } catch {
            continue; // 坏帧忽略，等下一条
          }
          if (ev === 'meta' && typeof j.conversationId === 'number') {
            // 会话号写回**发起时那个智能体**的桶（不是「此刻正在看的」那个）
            const cid = j.conversationId;
            patchChat(myAgent, (c) => (c.convId === cid ? c : { ...c, convId: cid }));
          } else if (ev === 'error') setChatNote(`出错了：${j.error ?? '未知原因'}`);
          else if (ev === 'done') sawDone = true;
          else if (j.delta) {
            acc += j.delta;
            setStreamText(acc); // 打字机：逐段追加到助手气泡
          }
        }
      }
      if (acc) {
        patchChat(myAgent, (c) => ({ ...c, messages: c.messages.concat({ id: Date.now() + 1, role: 'assistant', text: acc }) }));
      } else if (!sawDone) {
        setChatNote((n) => n || '这轮没拿到回复（未完成，服务端不会把半截存进历史）。');
      }
    } catch (e) {
      setChatNote(`${openUrl ? '网页已经打开在中栏浏览器工作区里；' : ''}连不上后端：${(e as Error).message}`);
    } finally {
      setStreaming(false);
      setStreamingAgentId(null);
      setStreamText('');
      // 第 16 步：这轮服务端已经更新过会话状态（current_task / browser_confirmed）——
      // 拉回来刷新界面上的状态行，改口后这里显示的就是新任务了。
      void loadAgentState(myAgent);
    }
    // 第 9 步：刚才是回答驾驶员的「补资料」提问 → 把答案递给主进程并自动恢复循环
    // 第 15/17 步：只有「正在等的那个智能体 + 那一张页」的回答才转给它；别处的话不串过去。
    if (agentAwaitInfo && agentAwaitAgent === myAgent) {
      setAgentAwaitInfo(false);
      setAgentAwaitAgent(null);
      setChatNote('已把答复转给小助，继续驾驶中…');
      void window.workbench?.agentAnswer(value, agentAwaitWcId ?? undefined);
      setAgentAwaitWcId(null);
    }
  };

  const onSend = () => {
    void sendChat();
  };

  /**
   * 第 7 步 + 第 13/17 步：把目标交给主进程的 AI 循环。
   * 驾驶目标就是**某一张打开的页**；还没开过就先按目标里的站点开一张（拿不到站点才用默认主页），
   * 然后等 guest 真就绪再发车，否则主进程会「没有找到内嵌 webview 的 webContents」。
   * 第 17 步：别路（别的页）不动 —— 两路可以同时跑。
   */
  const startAgentTask = async (rawGoal?: string) => {
    const goal = (rawGoal ?? '').trim();
    if (!goal || !session) return;
    const cur = browser.active;
    const owner = curAgentRef.current;
    if (owner === null) return;
    const tabId = cur ? cur.id : await browser.openUrl(owner, detectOpenUrl(goal) ?? HOME_URL);
    if (tabId === null) return;
    const wcId = await browser.awaitWebContentsId(tabId);
    if (typeof wcId !== 'number') {
      setChatNote('这张页还没准备好（拿不到内嵌页句柄），没有发车。');
      return;
    }
    setAgentSteps([]);
    setAgentDoc(null);
    // token 递给主进程只用于请求头；不打印
    void window.workbench?.agentStart(goal, API_BASE(), session.token, wcId);
    window.setTimeout(() => {
      void browser.refreshDriving();
    }, 400);
  };

  // 第 5 步门控：未登录（或正在用存好的 JWT 换会话）时，工作台整体不渲染——不做“游客看假数据”
  if (checkingAuth) {
    return (
      <div className="authWrap">
        <div className="authCard">
          <h3>正在恢复登录状态…</h3>
        </div>
      </div>
    );
  }
  if (!session) {
    return <AuthScreen onSession={setSession} />;
  }

  /**
   * 左栏要显示的智能体列表。
   * 正常情况以服务端 /agents 为准；刚登录还没拉回来时先用登录响应里的 agents 顶上，
   * 免得首屏左栏是空的（那种「点了没反应」的错觉最难查）。
   */
  const sidebarAgents: AgentView[] =
    agents.length > 0
      ? agents
      : (session.agents ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          kind: 'assistant',
          deletable: false,
          personaStatus: 'ready' as const,
          persona: null,
          conversationId: null,
        }));
  const curAgent = sidebarAgents.find((a) => a.id === curAgentId) ?? null;
  /** 第 16 步：当前智能体的会话状态（服务端为准）——状态行与保活按钮都读它 */
  const curState = curAgentId === null ? undefined : agentStates[curAgentId];
  /**
   * 当前智能体这一轮用户原话**本身**就是确认（明确开页指令，或对确认提问回了「继续/可以」）。
   * 是的话就不再挂确认按钮——事情已经在做了，再要确认就是自相矛盾（第 13 步的规矩）。
   */
  const curConfirmed = curAgentId !== null && Boolean(lastUserWasOpenRef.current[curAgentId]);

  return (
    <div className="app">
      {/*
        左侧：**智能体列表**（自带「小助」+ 用户点「添加」建的）。
        第 15 步起这里不再是一个写死的联系人——一个智能体一行，点一行就换一份聊天。
        「＋ 添加」不弹独立设置窗、不开新 BrowserWindow：服务端建好智能体 + 空会话，直接切过去。
      */}
      <aside className="sidebar">
        <div className="agentList" role="list" aria-label="我的智能体">
          {sidebarAgents.map((a) => (
            <button
              type="button"
              role="listitem"
              key={a.id}
              className={a.id === curAgentId ? 'contact contact--on' : 'contact'}
              onClick={() => selectAgent(a)}
            >
              <div className="avatar">
                <span className="avatar__face" aria-hidden="true">
                  {agentGlyph(a)}
                </span>
                {a.kind === 'assistant' && hasUnread && (
                  <span className="red-dot" title={curTask?.unreadHint || '任务结果待查看'} />
                )}
              </div>
              <div className="contact__meta">
                <div className="contact__name">{a.name}</div>
                <div className="small">
                  {a.kind === 'assistant' ? '在线' : a.personaStatus === 'pending' ? '等你填引导表' : '已就位'}
                </div>
              </div>
            </button>
          ))}
          <button type="button" className="btn agentList__add" disabled={agentBusy} onClick={() => void addAgent()}>
            {agentBusy ? '添加中…' : '＋ 添加'}
          </button>
          {/* 自建智能体可以删（「小助」是自带的，服务端也会拒）；它自己的聊天与项目记忆一并清掉 */}
          {curAgent && curAgent.deletable && (
            <button type="button" className="btn agentList__del" onClick={() => void deleteAgent(curAgent.id)}>
              删掉「{curAgent.name}」
            </button>
          )}
          {agentNote && <div className="small agentList__note">{agentNote}</div>}
        </div>

        {/*
          第 16 步「启动并保活」最小闭环：
          只把这个智能体的会话标成监听态（仍在这一个窗口里，不新开窗口、不起新进程）。
          空闲时服务端一次模型都不调——有新消息才走 /chat/stream。
        */}
        {curAgent && (
          <div className="keepalive">
            <button type="button" className="btn keepalive__btn" disabled={keepaliveBusy} onClick={() => void toggleKeepalive()}>
              {keepaliveBusy ? '切换中…' : curState?.keepalive ? '停止保活' : '启动并保活'}
            </button>
            <div className="small">
              {curState?.keepalive
                ? `「${curAgent.name}」监听中：空闲不调模型，来消息才处理`
                : '未保活：只在你说一句话时才处理'}
            </div>
          </div>
        )}

        {/* 第 5 步：我的账号（XYZ 对外号 + 设置/修改密码；退出回登录页） */}
        <div className="account">
          <div className="small">我的号：{session.user.xyz_id}{session.user.phone_masked ? ` · ${session.user.phone_masked}` : ''}</div>
          <div className="small">{session.user.has_password ? '密码：已设置' : '密码：未设置（XYZ+密码登录会明确失败）'}</div>
          {session.user.has_password && (
            <input className="authInput" type="password" placeholder="原密码" value={pwOld} onChange={(e) => setPwOld(e.target.value)} />
          )}
          <input className="authInput" type="password" placeholder="新密码（≥8 位）" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
          <div className="buttons-row">
            <button className="btn" type="button" disabled={pwNew.length < 8} onClick={() => void onSubmitPassword()}>
              {session.user.has_password ? '修改密码' : '设置密码'}
            </button>
            <button className="btn" type="button" onClick={onLogout}>
              退出登录
            </button>
          </div>
          {pwMsg && <div className="small">{pwMsg}</div>}
          {/* 第 15 步：两层记忆分开展示——上面那份是「这个人」的，下面那份是当前智能体的 */}
          <div className="buttons-row">
            <button type="button" className="btn" onClick={() => setUserMemOpen((v) => !v)}>
              用户记忆（{userMem.length}）
            </button>
            <button type="button" className="btn" onClick={() => setProjMemOpen((v) => !v)}>
              项目记忆（{projMem.length}）
            </button>
          </div>
          {userMemOpen && (
            <div className="memList" role="list" aria-label="用户记忆库">
              <div className="small memList__title">账号级 · 所有智能体都读得到</div>
              {userMem.length === 0 && <div className="small">还没有记过东西。</div>}
              {userMem.map((m) => (
                <div className="memList__row" key={m.id}>
                  <span className="small">{m.content}</span>
                  <button type="button" className="memList__forget" onClick={() => void forgetEntry('user', m.id)}>
                    忘掉这条
                  </button>
                </div>
              ))}
            </div>
          )}
          {projMemOpen && (
            <div className="memList" role="list" aria-label="当前智能体的项目记忆">
              <div className="small memList__title">
                {curAgent ? `${curAgent.name} 专属 · 别的智能体看不到` : '智能体级'}
              </div>
              {projMem.length === 0 && <div className="small">这个智能体还没有项目记忆。</div>}
              {projMem.map((m) => (
                <div className="memList__row" key={m.id}>
                  <span className="small">{m.content}</span>
                  <button type="button" className="memList__forget" onClick={() => void forgetEntry('agent', m.id)}>
                    忘掉这条
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 第 11 步：同一主窗口左栏入口；标准文件选择器后 POST 到本机服务端，不创建 Electron 窗口。 */}
          <div className="buttons-row">
            <button type="button" className="btn" onClick={() => setKnowledgeOpen((v) => !v)}>
              知识库（{knowledgeDocs.length}）
            </button>
          </div>
          {knowledgeOpen && (
            <div className="knowledgePanel">
              <div className="small">上传 .txt / .md / .pdf；资料原文片段会加密入库。</div>
              <input
                ref={knowledgeFileRef}
                className="knowledgePanel__file"
                type="file"
                accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                onChange={onChooseKnowledgeFile}
              />
              <div className="buttons-row">
                <button
                  type="button"
                  className="btn"
                  disabled={knowledgeUploading}
                  onClick={() => knowledgeFileRef.current?.click()}
                >
                  {knowledgeUploading ? '上传中…' : '上传资料'}
                </button>
              </div>
              {knowledgeNote && <div className="small knowledgePanel__note">{knowledgeNote}</div>}
              <div className="knowledgePanel__list" role="list" aria-label="已入库资料">
                {knowledgeDocs.length === 0 && <div className="small">还没有上传资料。</div>}
                {knowledgeDocs.map((doc) => (
                  <div className="knowledgePanel__row" role="listitem" key={doc.id} title={doc.filename}>
                    <span>{doc.filename}</span>
                    <span className="small">{doc.kind.toUpperCase()} · {doc.chunkCount} 段</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 第 18 步：左栏这两个是纯演示 / 自检痕迹，用样式藏掉（.demoOnly，DOM 保留） */}
        <div className="buttons-row demoOnly">
          <button className="btn" type="button" onClick={() => setHasUnread((v) => !v)}>
            切换红点（演示）
          </button>
        </div>

        <div className="sidebar__footer demoOnly">桥：{bridgeInfo}</div>
      </aside>

      {/* 中间：**钉住的浏览器工作区**（tab + URL 栏 + 当前页）+ 聊天区 */}
      <main className="middle">
        {/*
          第 18 步：工作区挂在**窗口级**，是 .chat 的兄弟节点（所以滚聊天滚不没）。
          浏览器相关的东西全在 ./browser 里，这里只负责挂载。
        */}
        {browser.tabs.length > 0 && <BrowserPanel ws={browser} />}
        <div className="chat">
          {/*
            第 16 步：会话状态行（服务端 conversations 表为准）。
            进程重启后靠它把「当前任务」恢复出来，而不是假装任务从未开始；
            保活态也在这里标出来，让人一眼看出「挂着监听但没在烧模型」。
          */}
          {curState && (curState.current_task || curState.keepalive || curState.browser_confirmed) && (
            <div className="taskState">
              <span>{curState.keepalive ? '● 监听中（保活：空闲不调模型）' : '○ 未保活'}</span>
              {curState.current_task && <span> · 当前任务：{curState.current_task}</span>}
              {curState.browser_confirmed && <span> · 本会话已同意用浏览器</span>}
            </div>
          )}
          {/*
            第 17 步：任务结果从右栏搬到这里（右栏整栏不渲染了）。
            只留「查看结果 / 下载文档」两个动作——结论正文在聊天里以「✅ 任务完成」给出。
          */}
          {curTask && (
            <div className="taskResult">
              <div className="small">
                任务 #{curTask.id} · {curTask.status}
                {curTask.unread ? <span className="unreadTag"> ● 未读</span> : <span className="readTag"> ✓ 已读</span>}
                {curTask.goal ? ` · 目标：${curTask.goal}` : ''}
              </div>
              {taskDetailOpen && curTask.summary && <div className="small taskSummary">{curTask.summary}</div>}
              {taskDetailOpen && curTask.outline && curTask.outline.length > 0 && (
                <div className="small">
                  📄 {curTask.docTitle || '任务记录'} · {curTask.outline.slice(0, 4).join(' / ')}
                </div>
              )}
              <div className="buttons-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (taskDetailOpen) setTaskDetailOpen(false);
                    else void openTaskResult();
                  }}
                >
                  {taskDetailOpen ? '收起结果' : '查看结果'}
                </button>
                {/* 第 8 步：任务 done 后的「下载文档」——不经过右栏，也不必先点「查看结果」 */}
                {(task.phase === 'done' || curTask.status === 'done') && (
                  <button className="btn docDownload" type="button" onClick={() => void downloadTaskDoc()}>
                    下载文档（.md）
                  </button>
                )}
              </div>
              {docNote && <div className="small">{docNote}</div>}
            </div>
          )}
          {/*
            第 15 步：新智能体的**引导表**就摆在这个会话里（不是独立设置窗、不是后台配置页）。
            填完确认 → 服务端存人设 → personaStatus 变 ready，它才按这份描述干活。
          */}
          {curAgent && curAgent.personaStatus === 'pending' && (
            <AgentGuide
              key={curAgent.id}
              agent={curAgent}
              onSave={(p) => savePersona(curAgent.id, p)}
              onDelete={() => void deleteAgent(curAgent.id)}
            />
          )}
          {messages.length === 0 && !streaming && !(curAgent && curAgent.personaStatus === 'pending') && (
            <div className="small" style={{ padding: '8px 4px' }}>
              {curAgent ? `还没有和「${curAgent.name}」聊过。说句话试试——消息加密存进库里，重启后还在。` : '还没有聊天记录。'}
            </div>
          )}
          {messages.map((m, idx) => (
            /**
             * 第 18 步：聊天里**只有话和结论**——不再有「网页行」芯片。
             * 开页成功看中栏工作区的 tab；关页只从工作区消失（最多留一句人话在下面的提示条里）。
             * 这样连续开百度/必应/知乎、再关掉几张，聊天也不会被一串「已关闭」刷屏。
             */
            <div key={m.id}>
              <div className={`msg ${m.role}`}>{m.text}</div>
              {/* 第 8 步：确认按钮只挂在「最后一条」确认回复上——旧确认按钮不再渲染，
                  免得用户点到老按钮、拿旧目标开新任务（例如用「打开百度」去搜天气）。
                  目标一律取这条确认之前最近的那句用户原话（例如「打开百度搜天气」）：
                  既不读输入框，也不用更早的消息；取不到就明确提示，不拿空 goal 去开车。
                  第 13 步：本轮用户原话就是「开网页指令」时不再挂这个按钮——
                  网页已经打开了，再要确认就是自相矛盾。
                  第 15 步：这个「本轮」是按**当前智能体**判的，别的智能体开过网页不算。 */}
              {m.role === 'assistant' &&
                CONFIRM_ASK_RE.test(m.text) &&
                idx === messages.length - 1 &&
                !streaming &&
                !curConfirmed && (
                  <div style={{ padding: '2px 4px' }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={task.phase === 'running'}
                      onClick={() => {
                        const goal = (
                          [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user')?.text ?? ''
                        ).trim();
                        if (!goal) {
                          setChatNote('这条确认没有对应的用户原话，我没有开始。请把目标再发一遍（例如「打开百度搜天气」）。');
                          return;
                        }
                        void startAgentTask(goal);
                      }}
                    >
                      确认 · 用工作台浏览器开始
                    </button>
                  </div>
                )}
            </div>
          ))}
          {/* 第 15 步：只在「发起这轮流式的那个智能体」里显示打字气泡，切走就不显示 */}
          {streaming && streamingAgentId === curAgentId && (
            <div className="msg assistant">
              {streamText || <span className="small">正在想…</span>}
              <span className="caret" aria-hidden="true">
                ▍
              </span>
            </div>
          )}
          {chatNote && (
            <div className="chatNote">
              <span>{chatNote}</span>
              <button type="button" className="chatNote__x" aria-label="关闭提示" onClick={() => setChatNote('')}>
                ✕
              </button>
            </div>
          )}
        </div>

        <div className="inputBar">
          <input
            placeholder={
              streaming
                ? '正在打字…'
                : awaitHere
                  ? '回复小助的提问即可，发出后自动继续…'
                  : `和${curAgent ? `「${curAgent.name}」` : '小助'}聊聊（消息加密存服务端，刷新后还在）`
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            disabled={streaming}
          />
          <button type="button" onClick={onSend} disabled={streaming}>
            {streaming ? '打字中…' : '发送'}
          </button>
          {/* 第 15 步：结束这轮 → 把这段聊天**总结**进两层记忆（用户库 + 本项目记忆） */}
          <button
            type="button"
            className="inputBar__end"
            title="结束这轮聊天，把这段总结进两层记忆"
            onClick={() => void tidyCurrentAgent()}
          >
            结束
          </button>
        </div>
      </main>

      {/*
        第 13/17 步：右栏整个撤掉 —— 驾驶台、调试区、**任务卡**一律不画。
        第 17 步验收第 1 条就是「右栏驾驶台/任务卡看不见」，所以这里不是隐藏，是根本不渲染；
        任务结果改挂在聊天顶部那一行（结论本身早就在聊天里以「✅ 任务完成」给出了），
        第 8 步的「下载文档」能力不丢，右栏也不再占地方、更不会被当浏览器用。
      */}
    </div>
  );
}
