import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthProfile, AuthSession, BrowserAction, ChatHistoryResult, DriveResult, TaskPhase, TaskState } from '@ai-workbench/shared';

/**
 * 第 2 步（内嵌版）「脸和门」：
 *   - 脸：主窗口做成一个能看懂的简易聊天界面（假数据 + 内存状态）
 *   - 门：右侧那一栏内嵌一个 <webview>，能直接显示真实网页（不再开独立窗口）
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
 */

type Role = 'user' | 'assistant';
type Message = { id: number; role: Role; text: string };

/** 状态机 → 展示文案（主进程是唯一事实源，这里只是翻译） */
const PHASE_LABEL: Record<TaskPhase, string> = {
  idle: 'idle · 待命',
  running: 'running · AI 驾驶中',
  paused: 'paused · 你接管中',
  done: 'done · 任务完成',
  failed: 'failed · 任务失败',
};

/**
 * 第 6 步：不再放写死的开场白。
 * 历史一律以服务端 `/chat/history` 为准（库里的密文解密回传）；
 * 一条都没有时中间区显示一句空态提示，而不是拿假对话冒充“聊过”。
 */
const SEED_MESSAGES: Message[] = [];

/** 工作台浏览器的默认落地页 */
const DEFAULT_BROWSER_URL = 'https://example.com';

/** 调试用：驾驶目标站 */
const DEMO_URL = 'https://www.baidu.com';
/**
 * 调试用：搜索框 / 搜索按钮的选择器。
 *
 * 写成**逗号列表**是有意的降级策略：百度首页同时存在两套搜索 UI ——
 * 隐藏的经典搜索框（#kw / #su，祖先 display:none，量出来 0×0）排在前面，
 * 可见的新版 AI 搜索框（#chat-textarea / #chat-submit-button）排在后面。
 * 执行器会遍历所有匹配、取第一个**可见**的，所以两种版式都能命中。
 */
const DEMO_INPUT = '#kw, textarea#chat-textarea';
const DEMO_SUBMIT = '#su, button#chat-submit-button';

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

/** 把一次驾驶结果拍成给人看的纯文本 */
function formatResult(res: DriveResult): string {
  const lines: string[] = [`ok: ${res.ok}`, `action: ${res.action}`];
  if (res.detail) lines.push(`detail: ${res.detail}`);
  if (res.error) lines.push(`error: ${res.error}`);
  const s = res.pageSnapshot;
  if (s) {
    lines.push(`url:   ${s.url}`);
    lines.push(`title: ${s.title}`);
    lines.push(`按钮(${s.buttons.length}):   ${s.buttons.slice(0, 8).join(' / ') || '（无）'}`);
    lines.push(`链接(${s.links.length}):   ${s.links.slice(0, 8).join(' / ') || '（无）'}`);
    lines.push(`输入框(${s.inputs.length}): ${s.inputs.slice(0, 8).join(' / ') || '（无）'}`);
  }
  return lines.join('\n');
}

export default function App() {
  /** 头像右上角红点，可手动开关 */
  const [hasUnread, setHasUnread] = useState(true);
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
  /** 当前会话 id：登录后 /chat/history 给回，或 /chat/stream 的 meta 事件补上；只在内存，不硬编 */
  const convIdRef = useRef<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  /** 打字机中的半截助手回复（done 之前只活在这里；库里只有完成的全文） */
  const [streamText, setStreamText] = useState('');
  /** 聊天区一条可关闭的提示（未配置模型 / 出错 / 已先行暂停等），不冒充 AI 的话 */
  const [chatNote, setChatNote] = useState('');

  /** 会话一定向拉一次历史：刷新/重启还能看见之前的对话；登出清零 */
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
    setSession(null);
    setPwMsg('');
    // 第 6 步：聊天痕迹也清掉（历史本来就在服务端，重启登录后由 /chat/history 还原）
    setMessages([]);
    setChatNote('');
    setStreamText('');
    convIdRef.current = null;
  };

  /** 浏览器区域是否可见 */
  const [browserVisible, setBrowserVisible] = useState(false);
  /** 是否已经挂载过（挂载过就保留 <webview>，隐藏时用 display 收起，避免每次开关都重新加载网页） */
  const [browserMounted, setBrowserMounted] = useState(false);
  const [browserUrl, setBrowserUrl] = useState(DEFAULT_BROWSER_URL);
  const webviewRef = useRef<HTMLElement | null>(null);

  // ---- 第 3 步调试区状态（全部只在内存里；暂停语义已并入第 4 步状态机） ----
  /** 最近一次驾驶结果，直接摊在主窗口上 */
  const [driveOutput, setDriveOutput] = useState('还没执行过动作。点上面的按钮试试。');
  /** screenshot 动作的产物（内存里的 data URL，不入库） */
  const [shot, setShot] = useState<string | null>(null);

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

    const offOpen = bridge.on('open', (url) => {
      if (url) setBrowserUrl(url);
      setBrowserMounted(true);
      setBrowserVisible(true);
    });
    const offShow = bridge.on('show', () => {
      setBrowserMounted(true);
      setBrowserVisible(true);
    });
    const offHide = bridge.on('hide', () => setBrowserVisible(false));
    // 聚焦前先确保可见（沿用上一版 focusBrowser 的语义：不在就先打开）
    const offFocus = bridge.on('focus', () => {
      setBrowserMounted(true);
      setBrowserVisible(true);
      window.setTimeout(() => webviewRef.current?.focus?.(), 0);
    });

    return () => {
      offOpen();
      offShow();
      offHide();
      offFocus();
      offState();
    };
  }, []);

  // running 才是「AI 正在控制」；idle / paused / done / failed 一律把控制权写给你
  const aiInControl = task.phase === 'running';
  const bannerText = useMemo(
    () => (aiInControl ? 'AI 正在控制' : '你正在控制'),
    [aiInControl],
  );

  /**
   * P0：内嵌页永远保持可接收用户输入。
   *
   * "AI 正在控制"只表示执行器可自动 click/type；不能把 webview 元素本身设为
   * pointer-events:none。那会让 Chromium 的命中测试直接跳过 guest，造成暂停/我来操作
   * 后用户仍点不进网页的假死。真正的自动驾驶开关在主进程 driver.ts 的状态机
   * （paused 标志 + phase），不是靠 CSS 吃掉鼠标。
   */
  const pointerEvents = 'auto';

  /**
   * 第 6 步：发送 = 走 /chat/stream（带 JWT，fetch 读 SSE；EventSource 加不了 Authorization 所以不用它）。
   * 第 4 步规矩保留：running 时先让主进程暂停（权威横幅由 'state' 广播改回「你正在控制」），聊天照发。
   */
  const sendChat = async () => {
    if (!session) return;
    const value = input.trim();
    if (!value || streaming) return;
    setChatNote('');
    if (aiInControl) {
      void window.workbench?.pauseTask();
      setChatNote('任务在 running：已先暂停自动 click/type（状态机 → paused），聊天照常发。');
    }
    setMessages((prev) => prev.concat({ id: Date.now(), role: 'user', text: value }));
    setInput('');
    setHasUnread(false);
    setStreaming(true);
    setStreamText('');
    try {
      const res = await fetch(`${API_BASE()}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ conversationId: convIdRef.current ?? undefined, message: value }),
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
        setChatNote(`没发出去：${msg}`);
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
      setChatNote(`连不上后端：${(e as Error).message}`);
    } finally {
      setStreaming(false);
      setStreamText('');
    }
  };

  const onSend = () => {
    void sendChat();
  };

  // 打开 / 查看浏览器：先本地显示，再走 IPC 通知主进程（不等回包，避免闪一下）
  const onOpenBrowser = () => {
    setBrowserMounted(true);
    setBrowserVisible(true);
    void window.workbench?.openBrowser(browserUrl);
  };

  const onShowBrowser = () => {
    setBrowserMounted(true);
    setBrowserVisible(true);
    void window.workbench?.showBrowser();
  };

  const onHideBrowser = () => {
    void window.workbench?.hideBrowser();
  };

  const onFocusBrowser = () => {
    void window.workbench?.focusBrowser();
  };

  // ---- 第 3 步：驾驶相关 ----

  /**
   * 拿内嵌 webview 的 guest webContents id。
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

  /** 把一个动作交给主进程，在内嵌页上执行，并把结果显示在主窗口 */
  const runAction = async (action: BrowserAction) => {
    const bridge = window.workbench;
    if (!bridge) {
      setDriveOutput('未检测到 preload 桥，无法驾驶。');
      return;
    }

    // 驾驶前先确保内嵌页可见（看不见就谈不上“用户看得见页面在动”）
    setBrowserMounted(true);
    setBrowserVisible(true);
    setDriveOutput(`执行中：${action.action} …`);

    const id = await getWebviewId();

    try {
      const res = await bridge.drive(action, id);
      if (action.action === 'open_url' && res.ok) setBrowserUrl(action.url);
      if (action.action === 'screenshot') setShot(res.screenshot ?? null);
      setDriveOutput(formatResult(res));
    } catch (err) {
      setDriveOutput(`调用失败：${(err as Error).message}`);
    }
  };

  // ---- 第 4 步：状态机按钮。本地不记账，一切以下方 'state' 广播回来的 task 为准 ----

  /** 开始 / 重新执行 demo 任务：先保证内嵌页可见（复用第 2/3 步的显示逻辑，不做新外壳） */
  const onStartTask = async () => {
    setBrowserMounted(true);
    setBrowserVisible(true);
    // 等内嵌页 guest 真就绪再让主进程跑任务 —— 否则第一次点会出现
    // "没有找到内嵌 webview 的 webContents"（主进程 runLoop 是同步跑到第一个 await，
    // React 还没来得及重新挂载 <webview>，guest 也还没拿到 id）。
    await getWebviewId();
    void window.workbench?.startTask();
  };

  const onPauseDriving = () => {
    // 「暂停 / 我来操作」= 主进程状态机 running→paused：立刻停自动 click/type，页面交还用户手点
    void window.workbench?.pauseTask();
  };

  const onResumeDriving = () => {
    // 「继续」= 主进程先 read_page 读当前真实页面再决定下一步（driver.runLoop 第一步就是读页）
    void window.workbench?.resumeTask();
  };

  const onResetTask = () => {
    void window.workbench?.resetTask();
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

  return (
    <div className="app">
      {/* 左侧：联系人「小助」 */}
      <aside className="sidebar">
        <div className="contact">
          <div className="avatar">
            <span className="avatar__face" aria-hidden="true">
              助
            </span>
            {hasUnread && <span className="red-dot" title="有未读消息" />}
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
        </div>

        <div className="buttons-row">
          <button className="btn" type="button" onClick={() => setHasUnread((v) => !v)}>
            切换红点
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
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))}
          {streaming && (
            <div className="msg assistant">
              {streamText || <span className="small">小助正在想…</span>}
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
            placeholder={streaming ? '小助正在打字…' : '和小助聊聊（消息加密存服务端，刷新后还在）'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            disabled={streaming}
          />
          <button type="button" onClick={onSend} disabled={streaming}>
            {streaming ? '打字中…' : '发送'}
          </button>
        </div>
      </main>

      {/* 右侧：控制文案 + 任务卡片 + 调试区 + 内嵌工作台浏览器 */}
      <aside className="right">
        <div className="banner">{bannerText}</div>
        <div className="small" style={{ textAlign: 'center', marginTop: -8 }}>
          状态机 {PHASE_LABEL[task.phase]}（步 {task.step}）· {task.detail}
        </div>

        <div className="controls">
          <button className="btn" type="button" onClick={onStartTask}>
            开始任务
          </button>
          <button className="btn" type="button" onClick={onPauseDriving}>
            暂停
          </button>
          <button className="btn" type="button" onClick={onResumeDriving}>
            继续
          </button>
          <button className="btn" type="button" onClick={onPauseDriving}>
            我来操作
          </button>
          <button className="btn" type="button" onClick={onResetTask}>
            复位任务
          </button>
        </div>

        <div className="card">
          <h4>示例任务</h4>
          <div className="small">
            状态：<span className="status-running">running</span>
          </div>
          <div className="buttons-row">
            <button className="btn" type="button" onClick={onOpenBrowser}>
              打开工作台浏览器
            </button>
            <button className="btn" type="button" onClick={onFocusBrowser}>
              聚焦浏览器
            </button>
            <button className="btn" type="button" onClick={onShowBrowser}>
              显示
            </button>
            <button className="btn" type="button" onClick={onHideBrowser}>
              隐藏
            </button>
          </div>
        </div>

        {/* 第 3 步调试区：丑是故意的，只为证明驾驶通了 */}
        <div className="debug">
          <div className="debug__title">调试区 · 驾驶内嵌页（第 3 步 · 不接 AI）</div>
          <div className="buttons-row">
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'open_url', url: DEMO_URL })}
            >
              1 打开百度
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'type', target: DEMO_INPUT, text: 'AI 工作台' })}
            >
              2 在搜索框输入
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'click', target: DEMO_SUBMIT })}
            >
              3 点击搜索
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'scroll', direction: 'down' })}
            >
              4 向下滚动
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'read_page' })}
            >
              5 读取页面
            </button>
            <button className="btn" type="button" onClick={onPauseDriving}>
              6 暂停驾驶
            </button>
            <button className="btn" type="button" onClick={onResumeDriving}>
              7 继续驾驶
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void runAction({ action: 'screenshot' })}
            >
              8 截图
            </button>
          </div>
          <div className="small debug__state">
            状态机：{PHASE_LABEL[task.phase]}（主进程权威）· 单发自动 click / type{' '}
            {task.blocked ? '已被拒——页面已交还给你手点' : '放行中'}
          </div>
          <pre className="debug__out">{driveOutput}</pre>
          {shot && <img className="debug__shot" src={shot} alt="内嵌页截图" />}
        </div>

        {/* 工作台浏览器区域：真实网页，独立会话分区 */}
        <div className="browserArea">
          {browserMounted ? (
            <webview
              ref={webviewRef as never}
              className="browserArea__view"
              src={browserUrl}
              partition="persist:workbench-browser"
              // 允许 guest 把 target=_blank 的点击请求交给主进程；主进程会 deny 新窗口并
              // 让当前 guest 自己导航（见 main.ts），因此不会创建 BrowserWindow。
              allowpopups
              // display 必须是 flex：<webview> 内部靠 flex 撑开 guest 视图，
              // 写成 block 会让 guest 卡在 150px 高（实测踩过）
              style={{ display: browserVisible ? 'flex' : 'none', pointerEvents }}
            />
          ) : (
            <div className="browserArea__empty">点击「打开工作台浏览器」后，这里会显示网页</div>
          )}
        </div>
      </aside>
    </div>
  );
}
