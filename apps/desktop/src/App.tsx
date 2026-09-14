import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AgentEventPayload, AuthProfile, AuthSession, ChatHistoryResult, KnowledgeDocument, KnowledgeListResult, KnowledgeUploadResult, MemoryExtractResult, MemoryItem, MemoryListResult, TaskState } from '@ai-workbench/shared';
import { BrowserCard, HOME_URL, detectOpenUrl } from './browserCard';
import { ProfileCard } from './profileCard';
import { addUsage, forgetAccount, rememberAccount, rememberedAccount } from './localProfile';

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
 *   - 纯闲聊 / 问知识库 / 问「你是谁」：不弹卡片、不加载网页（判定见 browserCard.tsx 的 detectOpenUrl）；
 *   - 右栏驾驶台（开始任务/暂停/继续/我来操作/复位/示例任务/黄框调试区/浏览器开关）全部撤掉，
 *     状态机保留在主进程内部，不在右栏画状态；右栏只在有任务结果时出现一张结果卡；
 *   - 驾驶目标改为**卡片里这张页**（getWebviewId 拿的就是卡片的 guest），流程没变；
 *   - 敏感闸没动：聊天输入框发 123456 仍被拦下、不落库、不代填；验证码/密码请在网页里自己打。
 *
 * 第 14 步「登录页个人卡片（一点进入）」：
 *   - 登录页多了**第二种形态**：这台电脑登过某个号（有「记住的账号」标记）时，再开应用
 *     （含重启电脑）不直接进工作台，先出一张个人卡片；点「进入工作台」才放行，不用再填验证码；
 *   - 第一次登录 / 点过「退出登录」：照旧是手机验证码 mock + XYZ 号（微信仍占位）；
 *     首次登录成功仍然直接进工作台（卡片只在**下次打开**时出现）；
 *   - 卡片上可改头像（本地选图）/ 名称 / 简介，全部按 XYZ 号记在**本机**（见 localProfile.ts），
 *     服务端一行不动、仓库里不放任何图片；XYZ 号只展示，不当名称改；
 *   - 「使用时长」= 这台电脑上该账号的累计（15 秒一跳 + 退出时结算）；「学习 AI 的分数」
 *     只是时长换算的整数；「小助 × 1」写死展示——不做多员工、不做招聘/切换智能体、不做习惯学习；
 *   - 「切换账号」清 token + 记住标记回验证码页，登完出**新号**的卡片；
 *     工作台里的「退出登录」同样清掉记住标记，所以下次打开要重新验证码登录，不是直接进旧卡片。
 */

type Role = 'user' | 'assistant' | 'browser';
type Message = { id: number; role: Role; text: string; cardUrl?: string };

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
 */
const SEED_MESSAGES: Message[] = [];

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
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  /** 第 1 步的 IPC 自检，留着当回归哨兵 */
  const [bridgeInfo, setBridgeInfo] = useState('检测中…');

  // ---- 第 5 步：会话。JWT 从 localStorage 读回后只放内存 state；绝不 console 打全文 ----
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(() => Boolean(localStorage.getItem(TOKEN_KEY)));

  // ---- 第 14 步：本机「记住的账号」闸 + 本次启动是否已点过「进入工作台」----
  /** 这台电脑记住的账号（退出登录 / 切换账号会清掉）；null = 没登过，走验证码页 */
  const [remembered, setRemembered] = useState<string | null>(() => rememberedAccount());
  /** 本次启动是否已经点过「进入工作台」；false 且记住的号就是当前号 → 先出个人卡片 */
  const [entered, setEntered] = useState(false);
  /**
   * 切换账号后登录成功也要先出新号的卡片（提示词：登另一个号后卡片换成新号）。
   * 用 ref 而不是 state：只在登录回调里读一次，不受渲染时机影响。
   */
  const cardAfterLoginRef = useRef(false);
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  /**
   * 带已存 token 调 /auth/me：能换回 profile 就静默登录，换不回来就清 token 回登录页。
   * 第 14 步：**静默续上会话 = 这台电脑登过这个号** —— 顺手把「记住的账号」补上
   * （从第 13 步升上来的机器只有 token、没有这个标记，补了才会先出卡片而不是验证码页），
   * 并且**不**置 entered，于是这次启动先渲染个人卡片，点一下才进工作台。
   */
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    let off = false; // 卸载标志：慢回来的响应不再 setState
    authFetchJson<AuthProfile>('/auth/me', { headers: { authorization: `Bearer ${saved}` } })
      .then((p) => {
        if (off) return;
        rememberAccount(p.user.xyz_id);
        setRemembered(p.user.xyz_id);
        setSession({ ...p, token: saved });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        if (!off) setSession(null);
      })
      .finally(() => { if (!off) setCheckingAuth(false); });
    return () => { off = true; };
  }, []);

  /**
   * 第 14 步：本机使用时长累计（简单累计，不做行为分析）。
   * 登录态在的时候每 15 秒把这一段时间记到当前号头上；退出/换号/关窗口时结算最后一段。
   */
  useEffect(() => {
    const xyz = session?.user.xyz_id;
    if (!xyz) return;
    let last = Date.now();
    const settle = () => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      addUsage(xyz, delta);
    };
    const timer = window.setInterval(settle, 15_000);
    window.addEventListener('beforeunload', settle);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', settle);
      settle();
    };
  }, [session?.user.xyz_id]);

  // ---- 第 6 步：流式聊天状态（真聊天，不再是内存假数据）----
  /** 当前会话 id：登录后 /chat/history 给回，或 /chat/stream 的 meta 事件补上；只在内存，不硬编 */
  const convIdRef = useRef<number | null>(null);
  /**
   * 第 13 步：这一轮的**用户原话**是不是「开网页指令」。
   * 是的话，即使模型仍回了「确认后我开始操作」那句老话，也不再挂确认按钮——
   * 网页已经在卡片里打开了，再要用户点确认就是自相矛盾。
   */
  const lastUserWasOpenRef = useRef(false);
  const [streaming, setStreaming] = useState(false);
  /** 打字机中的半截助手回复（done 之前只活在这里；库里只有完成的全文） */
  const [streamText, setStreamText] = useState('');
  /** 聊天区一条可关闭的提示（未配置模型 / 出错 / 已先行暂停等），不冒充 AI 的话 */
  const [chatNote, setChatNote] = useState('');

  /** 第 9 步：驾驶员在聊天里等用户回答普通资料（need_info）——回答后自动继续，不用点「继续」 */
  const [agentAwaitInfo, setAgentAwaitInfo] = useState(false);
  /** 第 10 步：用户档案记忆（active 列表 + 待确认卡）——一切以服务端为准 */
  const [memActive, setMemActive] = useState<MemoryItem[]>([]);
  const [memPending, setMemPending] = useState<MemoryItem[]>([]);
  const [memOpen, setMemOpen] = useState(false);
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

  // ---- 第 10 步：记忆 —— pending 上卡、active 进列表；确认前绝不注入 ----
  const memHeaders = () => ({ authorization: `Bearer ${sessionRef.current?.token ?? ''}` });
  const loadMemories = async () => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryListResult>('/memories', { headers: memHeaders() });
      setMemActive(r.active);
      setMemPending(r.pending);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };
  /** 「结束」：手动触发一次提取（同会话 10 分钟内重复点会被服务端去重窗口挡下） */
  const endConversationAndExtract = async () => {
    if (!sessionRef.current) return;
    if (convIdRef.current === null) {
      setChatNote('还没聊过天，没有可整理的。');
      return;
    }
    try {
      const r = await authFetchJson<MemoryExtractResult>('/memories/extract', {
        method: 'POST',
        body: JSON.stringify({ conversationId: convIdRef.current }),
        headers: memHeaders(),
      });
      if (r.skipped === 'llm_not_configured') setChatNote('没配 DEEPSEEK_API_KEY，这次没整理记忆。');
      else if (r.skipped === 'dedup_10min') setChatNote('刚整理过一次了（10 分钟内不重复）。');
      else {
        const silent = Math.max(0, r.extracted - r.pending.length);
        setChatNote(silent > 0 ? `已静默记下 ${silent} 条偏好；${r.pending.length > 0 ? '还有要你先确认的：' : '没有需要确认的。'}` : '整理完了，没有新增。');
      }
      void loadMemories();
    } catch (e) {
      setChatNote(`整理记忆没成：${(e as Error).message}`);
    }
  };
  const decideMemories = async (kind: 'confirm' | 'reject') => {
    if (!sessionRef.current) return;
    try {
      await authFetchJson(`/memories/${kind}`, { method: 'POST', body: JSON.stringify({ all: true }), headers: memHeaders() });
      setChatNote(kind === 'confirm' ? '好，记下了，从现在起按这个来。' : '收到，这几条作废。');
      void loadMemories();
    } catch (e) {
      setChatNote(`操作没成：${(e as Error).message}`);
    }
  };
  const forgetMemory = async (id: number) => {
    if (!sessionRef.current) return;
    try {
      await authFetchJson('/memories/forget', { method: 'POST', body: JSON.stringify({ id }), headers: memHeaders() });
      void loadMemories();
    } catch (e) {
      setChatNote(`忘掉失败：${(e as Error).message}`);
    }
  };
  const MEM_TYPE_CN: Record<string, string> = { preference: '偏好', decision: '决定', fact: '事实' };

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

  /** 会话一定向拉一次历史 + 任务快照：刷新/重启还能看见之前的对话与红点；登出清零 */
  useEffect(() => {
    setMessages([]);
    convIdRef.current = null;
    if (!session) return;
    let off = false;
    authFetchJson<ChatHistoryResult>('/chat/history', {
      headers: { authorization: `Bearer ${session.token}` },
    })
      .then((h) => {
        if (off) return;
        convIdRef.current = h.conversationId;
        setMessages(h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text })));
        void refreshTask();
        void loadMemories(); // 刷新后：pending 卡与「我的记忆」都还在
        void loadKnowledge(); // 第 11 步：只拉本人资料的文件名/段数，不把正文拉回前端
      })
      .catch((e) => {
        if (!off) setChatNote(`拉取历史失败：${(e as Error).message}`);
      });
    return () => {
      off = true;
    };
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
    // 第 14 步：连「这台电脑记住的账号」一起清掉 —— 下次打开要重新验证码登录，
    // 而不是直接弹出旧卡片进工作台。
    forgetAccount();
    setRemembered(null);
    setEntered(false);
    setSession(null);
    setPwMsg('');
    // 第 6 步：聊天痕迹也清掉（历史本来就在服务端，重启登录后由 /chat/history 还原）
    setMessages([]);
    setChatNote('');
    setStreamText('');
    convIdRef.current = null;
    // 第 7 步：驾驶员循环和 token 一并停掉/清掉（主进程里也不留）
    void window.workbench?.agentStop();
    // 第 13 步：聊天里的网页卡片一并清掉（换号不该看见上一个号的网页）
    setBrowserCardId(null);
    setCardExpanded(false);
    setAgentSteps([]);
    setAgentDoc(null);
    setCurTask(null);
    setTaskDetailOpen(false);
    setDocNote('');
    setHasUnread(false);
    setAgentAwaitInfo(false);
    setMemActive([]);
    setMemPending([]);
    setMemOpen(false);
    setKnowledgeDocs([]);
    setKnowledgeOpen(false);
    setKnowledgeUploading(false);
    setKnowledgeNote('');
  };

  /**
   * 第 14 步：登录成功（AuthScreen 回调）。
   * - 记下「这台电脑登过这个号」；
   * - 首次登录：直接进工作台（提示词：第一次登成功进工作台，卡片只在下次打开时出现）；
   * - 切换账号后登录：先出新号的卡片，一点再进。
   */
  const onAuthed = (s: AuthSession) => {
    rememberAccount(s.user.xyz_id);
    setRemembered(s.user.xyz_id);
    setSession(s);
    setEntered(!cardAfterLoginRef.current);
    cardAfterLoginRef.current = false;
  };

  /** 第 14 步：卡片上的「切换账号」——清 token + 记住标记回验证码页，登完出新号卡片 */
  const onSwitchAccount = () => {
    cardAfterLoginRef.current = true;
    onLogout();
  };

  // ---- 第 13 步：聊天里的浏览器卡片（整个窗口只有一张、只有一个 <webview>）----
  /** 当前挂着网页的那条卡片消息 id；null = 还没开过网页 */
  const [browserCardId, setBrowserCardId] = useState<number | null>(null);
  /** 订阅 effect 是挂载时建的闭包，用 ref 读最新值，免得拿到过期的 null */
  const browserCardIdRef = useRef<number | null>(null);
  browserCardIdRef.current = browserCardId;
  /** 卡片是否展开（展开后中栏以浏览器为主） */
  const [cardExpanded, setCardExpanded] = useState(false);
  /** 卡片里那块 <webview>：驾驶员的动作就打在它身上（不再有右栏那块网页） */
  const webviewRef = useRef<HTMLElement | null>(null);

  /**
   * 在中栏聊天里插一张浏览器卡片。
   * 旧卡片自动降级成一行占位文字——**同一时刻只允许一张卡片挂 <webview>**，
   * 否则主进程「找内嵌页」会挑错 guest，也会变成事实上的多标签。
   */
  const openBrowserCard = (url: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setMessages((prev) => prev.concat({ id, role: 'browser', text: url, cardUrl: url }));
    setBrowserCardId(id);
  };

  /** 把焦点交给卡片里的网页（还没开过就先开一张默认主页） */
  const focusCard = () => {
    if (browserCardIdRef.current === null) openBrowserCard(HOME_URL);
    window.setTimeout(() => (webviewRef.current as (HTMLElement & { focus?: () => void }) | null)?.focus?.(), 60);
  };

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

    // 第 13 步：主进程的浏览器指令一律落到**聊天卡片**上（不再有右栏那块网页）。
    // 'open' 直接换一张卡片；'focus'（敏感字段等待时会发）确保卡片存在并把焦点给它。
    // 'show' / 'hide' 不再有对应界面（卡片始终在聊天里），保留订阅只是不炸。
    const offOpen = bridge.on('open', (url) => {
      if (url) openBrowserCard(url);
    });
    const offShow = bridge.on('show', () => undefined);
    const offHide = bridge.on('hide', () => undefined);
    const offFocus = bridge.on('focus', () => focusCard());

    return () => {
      offOpen();
      offShow();
      offHide();
      offFocus();
      offState();
    };
  }, []);

  // running 才是「AI 正在控制」（第 13 步：不再在右栏画状态，只用于 running 时发消息先停手）
  const aiInControl = task.phase === 'running';

  // 订阅主进程驾驶员事件：ask/done/note 进聊天区
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;
    let off = false;
    const offAgent = bridge.on('agent', (payload) => {
      if (!payload) return;
      let p: AgentEventPayload;
      try {
        p = JSON.parse(payload) as AgentEventPayload;
      } catch {
        return;
      }
      if (off) return;
      if (p.kind === 'step') {
        setAgentSteps((prev) => prev.concat(`${p.summary}${p.ok ? '' : ' ❌'}`).slice(-6));
      } else if (p.kind === 'ask') {
        setAgentSteps([]);
        pushChatLine(`⚠️ ${p.question}`);
        const needInfo = p.reason === 'need_info';
        setAgentAwaitInfo(needInfo);
        if (needInfo) setChatNote('小助在等你答这句话——直接在下面输入框回答即可，发出后会自动继续（不用点「继续」）。');
      } else if (p.kind === 'sensitive') {
        pushChatLine(`🔒 ${p.message}`);
      } else if (p.kind === 'done') {
        setAgentAwaitInfo(false);
        pushChatLine(`✅ 任务完成：${p.summary}${p.docReady ? ` · ${p.unreadHint ?? '结果文档已生成'}` : '（文档未就绪：后端未配置模型或库未起，见后端日志）'}`);
        setAgentDoc({ title: p.documentTitle, outline: p.documentOutline });
        // 第 8 步：红点由服务端确认（finish 已置 unread=true），这里点亮并刷新卡片
        setHasUnread(true);
        void refreshTask();
        void loadMemories(); // 第 10 步：任务 done 的抽取在服务端做，可能刚产出待确认条目
      } else if (p.kind === 'note') {
        pushChatLine(`${p.level === 'error' ? '⚠️' : 'ℹ️'} ${p.text}`);
        if (/继续|恢复驾驶/.test(p.text)) setAgentAwaitInfo(false);
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
    setChatNote('');
    // 第 9 步本地闸：聊天里出现「密码/验证码：xxx」这类赋值就拦下——不发送、不落库、
    // 让敏感值只走浏览器输入框（服务端聊天与代填执行层各有自己的闸，这是第一道）。
    // 形态判定：敏感关键词后面跟着「像值的串」（≥6 位字母数字符号），或整句就是 4~8 位纯数字；
    // 只是提到关键词（“验证码一般几位”）不会被拦——宁可拦赋值、不问句误伤。
    if (/(密码|口令|password|passcode|验证码|校验码|captcha|otp|cvv|银行卡|卡号|身份证)[\s:：=是为]{0,3}[A-Za-z0-9*#@$%&+=.-]{6,}/i.test(value)
      || /^\s*\d{4,8}\s*$/.test(value)) {
      setChatNote('这看起来像密码/验证码/卡号：请不要发到聊天里。直接点在网页卡片里的输入框上自己打（我把焦点给这张页面），我不会代填、也不会留存。');
      try {
        focusCard();
      } catch {
        /* 聚焦失败不碍事 */
      }
      return;
    }
    // 第 13 步：明确的开网页指令 → 不再要确认，聊天里直接插一张真实网页卡片。
    // 判定纯本地（不联网、不问模型），所以后端/模型没起来时卡片照样出现。
    const openUrl = detectOpenUrl(value);
    lastUserWasOpenRef.current = openUrl !== null;
    if (aiInControl) {
      void window.workbench?.pauseTask();
      setChatNote('任务在 running：已先暂停自动 click/type（状态机 → paused），聊天照常发。');
    }
    if (openUrl) {
      const cardId = Date.now() + 2 + Math.floor(Math.random() * 1000);
      setMessages((prev) =>
        prev.concat(
          { id: Date.now(), role: 'user', text: value },
          { id: cardId, role: 'browser', text: openUrl, cardUrl: openUrl },
        ),
      );
      setBrowserCardId(cardId);
      setCardExpanded(false);
    } else {
      setMessages((prev) => prev.concat({ id: Date.now(), role: 'user', text: value }));
    }
    setInput('');
    setHasUnread(false);
    setStreaming(true);
    setStreamText('');
    try {
      const res = await fetch(`${API_BASE()}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        // browserOpened 只是给服务端系统提示词的一个开关：告诉小助「网页已经开好了」，
        // 别再让用户点确认。不是网页内容、不进历史、不落库。
        body: JSON.stringify({
          conversationId: convIdRef.current ?? undefined,
          message: value,
          ...(openUrl ? { browserOpened: openUrl } : {}),
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
        // 第 13 步：开网页指令即使这句没发给小助，卡片也已经开好了——先说清楚，
        // 免得用户以为「开网页」也失败了（后端/模型没起是另一回事，照实说）。
        setChatNote(`${openUrl ? '网页已经打开在聊天卡片里；' : ''}没发出去：${msg}`);
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
          if (ev === 'meta' && typeof j.conversationId === 'number') convIdRef.current = j.conversationId;
          else if (ev === 'error') setChatNote(`出错了：${j.error ?? '未知原因'}`);
          else if (ev === 'done') sawDone = true;
          else if (j.delta) {
            acc += j.delta;
            setStreamText(acc); // 打字机：逐段追加到助手气泡
          }
        }
      }
      if (acc) {
        setMessages((prev) => prev.concat({ id: Date.now() + 1, role: 'assistant', text: acc }));
      } else if (!sawDone) {
        setChatNote((n) => n || '这轮没拿到回复（未完成，服务端不会把半截存进历史）。');
      }
    } catch (e) {
      setChatNote(`${openUrl ? '网页已经打开在聊天卡片里；' : ''}连不上后端：${(e as Error).message}`);
    } finally {
      setStreaming(false);
      setStreamText('');
    }
    // 第 9 步：刚才是回答驾驶员的「补资料」提问 → 把答案递给主进程并自动恢复循环
    if (agentAwaitInfo) {
      setAgentAwaitInfo(false);
      setChatNote('已把答复转给小助，继续驾驶中…');
      void window.workbench?.agentAnswer(value);
    }
  };

  const onSend = () => {
    void sendChat();
  };

  /**
   * 拿**聊天卡片里那块 webview** 的 guest webContents id。
   * webview 还没 dom-ready 时 getWebContentsId() 会抛错，所以重试几轮。
   */
  const getWebviewId = async (): Promise<number | undefined> => {
    for (let i = 0; i < 25; i += 1) {
      const el = webviewRef.current as unknown as { getWebContentsId?: () => number } | null;
      try {
        const id = el?.getWebContentsId?.();
        if (typeof id === 'number' && id >= 0) return id;
      } catch {
        /* guest 尚未就绪，继续等 */
      }
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return undefined;
  };

  /**
   * 第 7 步 + 第 13 步：把目标交给主进程的 AI 循环。
   * 驾驶目标就是卡片里那张页——还没开过网页就先按目标里的站点开一张（拿不到站点才用默认主页），
   * 然后等 guest 真就绪再发车，否则主进程会「没有找到内嵌 webview 的 webContents」。
   */
  const startAgentTask = async (rawGoal?: string) => {
    const goal = (rawGoal ?? '').trim();
    if (!goal || !session) return;
    if (browserCardId === null) openBrowserCard(detectOpenUrl(goal) ?? HOME_URL);
    await getWebviewId();
    setAgentSteps([]);
    setAgentDoc(null);
    // token 递给主进程只用于请求头；不打印
    void window.workbench?.agentStart(goal, API_BASE(), session.token);
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
    return <AuthScreen onSession={onAuthed} />;
  }
  /**
   * 第 14 步：登录页的第二种形态。
   * 这台电脑登过这个号（有记住标记）且本次启动还没点过「进入工作台」→ 先出个人卡片，
   * 点一下才进工作台，不用再填验证码。key 绑 XYZ：换号时整张卡片重挂载，资料不会串。
   */
  if (!entered && remembered === session.user.xyz_id) {
    return (
      <ProfileCard
        key={session.user.xyz_id}
        session={session}
        onEnter={() => setEntered(true)}
        onSwitchAccount={onSwitchAccount}
      />
    );
  }

  return (
    <div className="app">
      {/* 左侧：联系人「小助」 */}
      <aside className="sidebar">
        <div className="contact">
          <div className="avatar">
            <span className="avatar__face" aria-hidden="true">
              助
            </span>
            {hasUnread && <span className="red-dot" title={curTask?.unreadHint || '任务结果待查看'} />}
          </div>
          <div className="contact__meta">
            <div className="contact__name">小助</div>
            <div className="small">在线</div>
          </div>
        </div>

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
          <div className="buttons-row">
            <button type="button" className="btn" onClick={() => setMemOpen((v) => !v)}>
              我的记忆（{memActive.length}）
            </button>
          </div>
          {memOpen && (
            <div className="memList" role="list">
              {memActive.length === 0 && <div className="small">还没有记过东西。</div>}
              {memActive.map((m) => (
                <div className="memList__row" key={m.id}>
                  <span className="small">
                    {MEM_TYPE_CN[m.type] ?? m.type}：{m.content}
                  </span>
                  <button type="button" className="memList__forget" onClick={() => void forgetMemory(m.id)}>
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

        <div className="buttons-row">
          <button className="btn" type="button" onClick={() => setHasUnread((v) => !v)}>
            切换红点（演示）
          </button>
        </div>

        <div className="sidebar__footer">桥：{bridgeInfo}</div>
      </aside>

      {/* 中间：聊天区（第 6 步：真流式；历史在服务端加密存储，这里只是展示） */}
      <main className="middle">
        <div className="chat">
          {messages.length === 0 && !streaming && (
            <div className="small" style={{ padding: '8px 4px' }}>
              还没有聊天记录。跟小助说句话试试——消息会加密存进库里，重启后还在。
            </div>
          )}
          {messages.map((m, idx) => {
            // 第 13 步：只有**最新那张**卡片挂真 webview；更早的卡片退化成一行说明。
            // 这样全窗口始终只有一个 <webview>——否则既是事实上的多标签，
            // 也会让主进程「找内嵌页」挑错 guest。
            const isLiveCard = m.role === 'browser' && m.id === browserCardId && Boolean(m.cardUrl);
            return (
              <div
                key={m.id}
                className={isLiveCard ? (cardExpanded ? 'chat__card chat__card--expanded' : 'chat__card') : undefined}
              >
                {m.role === 'browser' ? (
                  isLiveCard ? (
                    <BrowserCard
                      ref={webviewRef}
                      url={m.cardUrl as string}
                      expanded={cardExpanded}
                      onToggle={() => setCardExpanded((v) => !v)}
                    />
                  ) : (
                    <div className="browserCardMoved">网页卡片：{m.text}（已移到最新那张）</div>
                  )
                ) : (
                  <>
                    <div className={`msg ${m.role}`}>{m.text}</div>
                    {/* 第 8 步：确认按钮只挂在「最后一条」确认回复上——旧确认按钮不再渲染，
                        免得用户点到老按钮、拿旧目标开新任务（例如用「打开百度」去搜天气）。
                        目标一律取这条确认之前最近的那句用户原话（例如「打开百度搜天气」）：
                        既不读输入框，也不用更早的消息；取不到就明确提示，不拿空 goal 去开车。
                        第 13 步：本轮用户原话就是「开网页指令」时不再挂这个按钮——
                        网页已经在卡片里打开了，再要确认就是自相矛盾。 */}
                    {m.role === 'assistant' &&
                      m.text.includes('确认后我开始操作') &&
                      idx === messages.length - 1 &&
                      !streaming &&
                      !lastUserWasOpenRef.current && (
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
                  </>
                )}
              </div>
            );
          })}
          {streaming && (
            <div className="msg assistant">
              {streamText || <span className="small">小助正在想…</span>}
              <span className="caret" aria-hidden="true">
                ▍
              </span>
            </div>
          )}
          {memPending.length > 0 && (
            <div className="card memCard">
              <h4>需要你确认</h4>
              {memPending.map((m) => (
                <div className="small" key={m.id}>
                  {MEM_TYPE_CN[m.type] ?? m.type}：{m.content}
                </div>
              ))}
              <div className="buttons-row">
                <button type="button" className="btn" onClick={() => void decideMemories('confirm')}>
                  确认
                </button>
                <button type="button" className="btn" onClick={() => void decideMemories('reject')}>
                  不用，忘掉这条
                </button>
              </div>
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
            placeholder={streaming ? '小助正在打字…' : agentAwaitInfo ? '回复小助的提问即可，发出后自动继续…' : '和小助聊聊（消息加密存服务端，刷新后还在）'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            disabled={streaming}
          />
          <button type="button" onClick={onSend} disabled={streaming}>
            {streaming ? '打字中…' : '发送'}
          </button>
          {/* 第 10 步：结束本轮聊天并整理记忆（沿用 endConversationAndExtract 里的守卫） */}
          <button type="button" className="inputBar__end" title="结束这轮聊天并整理记忆" onClick={() => void endConversationAndExtract()}>
            结束
          </button>
        </div>
      </main>

      {/*
        第 13 步：右栏收干净。
        驾驶台（开始任务 / 暂停 / 继续 / 我来操作 / 复位 / 示例任务）、黄框调试区、
        工作台浏览器开关全部撤掉——状态机照旧跑在主进程内部，只是不在右栏画状态。
        网页改挂在**中栏聊天卡片**里。右栏只在出了任务结果时临时出现一张结果卡，
        没有任务时整栏不渲染（右栏允许空/隐藏，绝不拿它当浏览器用、也不加宽它）。
      */}
      {curTask && (
        <aside className="right">
          {/* 第 8 步：任务收尾卡——短结论、已读/未读、下载文档都在这（不做浏览器外壳） */}
          <div className="card">
            <h4>
              任务 #{curTask.id} · {curTask.status}{' '}
              {curTask.unread ? <span className="unreadTag">● 未读</span> : <span className="readTag">✓ 已读</span>}
            </h4>
            <div className="small">目标：{curTask.goal}</div>
            {curTask.status === 'done' && !taskDetailOpen && (
              <div className="buttons-row">
                <button className="btn" type="button" onClick={() => void openTaskResult()}>
                  查看结果{curTask.unread ? '（红点在这）' : ''}
                </button>
              </div>
            )}
            {taskDetailOpen && (
              <>
                {curTask.summary && <div className="small taskSummary">{curTask.summary}</div>}
                {curTask.outline && curTask.outline.length > 0 && (
                  <div className="small">📄 {curTask.docTitle || '任务记录'} · {curTask.outline.slice(0, 4).join(' / ')}</div>
                )}
              </>
            )}
            {/* 第 8 步：任务 done 后「下载文档」直接摆在右栏，不必先点「查看结果」。
                判定用「主进程状态机 done」或「服务端任务 done」——两者任一为 done 就给按钮。 */}
            {(task.phase === 'done' || curTask.status === 'done') && (
              <div className="buttons-row">
                <button className="btn btn--go docDownload" type="button" onClick={() => void downloadTaskDoc()}>
                  下载文档（.md）
                </button>
              </div>
            )}
            {docNote && <div className="small">{docNote}</div>}
          </div>
        </aside>
      )}
    </div>
  );
}
