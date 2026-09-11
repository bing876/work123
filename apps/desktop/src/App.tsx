import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserAction, DriveResult } from '@ai-workbench/shared';

/**
 * 第 2 步（内嵌版）「脸和门」：
 *   - 脸：主窗口做成一个能看懂的简易聊天界面（假数据 + 内存状态）
 *   - 门：右侧那一栏内嵌一个 <webview>，能直接显示真实网页（不再开独立窗口）
 *
 * 第 3 步「遥控器先通」：
 *   - 右栏底部加一块**很丑的调试区**，用几个按钮证明程序能驾驶这块内嵌页
 *   - 驾驶走 preload → 主进程 → 内嵌 webview 的 webContents（CDP），不接大模型
 *   - 调试区刻意不做美化，UI 统一留给前端会话
 */

type Role = 'user' | 'assistant';
type Message = { id: number; role: Role; text: string };
type Controller = 'ai' | 'user';

/** 写死的开场白，让界面一打开就有内容 */
const SEED_MESSAGES: Message[] = [
  { id: 1, role: 'assistant', text: '你好，我是小助～' },
  { id: 2, role: 'user', text: '先不用接 AI，我要看见工作台。' },
  { id: 3, role: 'assistant', text: '好的，我把工作台浏览器放到右边这一栏。' },
  { id: 4, role: 'assistant', text: '第 3 步：调试区那几个按钮可以直接驾驶右边这块内嵌页。' },
];

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
  /** 当前谁在控制：只影响右侧大字文案 + 浏览器区域能不能点 */
  const [controller, setController] = useState<Controller>('ai');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  /** 第 1 步的 IPC 自检，留着当回归哨兵 */
  const [bridgeInfo, setBridgeInfo] = useState('检测中…');

  /** 浏览器区域是否可见 */
  const [browserVisible, setBrowserVisible] = useState(false);
  /** 是否已经挂载过（挂载过就保留 <webview>，隐藏时用 display 收起，避免每次开关都重新加载网页） */
  const [browserMounted, setBrowserMounted] = useState(false);
  const [browserUrl, setBrowserUrl] = useState(DEFAULT_BROWSER_URL);
  const webviewRef = useRef<HTMLElement | null>(null);

  // ---- 第 3 步调试区状态（全部只在内存里） ----
  /** 驾驶是否已暂停（暂停后 click / type 不会自动执行） */
  const [drivingPaused, setDrivingPaused] = useState(false);
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

  // 订阅主进程转发过来的 UI 指令（open / show / hide / focus）
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;

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
    };
  }, []);

  const bannerText = useMemo(
    () => (controller === 'ai' ? 'AI 正在控制' : '你正在控制'),
    [controller],
  );

  /**
   * P0：内嵌页永远保持可接收用户输入。
   *
   * "AI 正在控制"只表示执行器可自动 click/type；不能把 webview 元素本身设为
   * pointer-events:none。那会让 Chromium 的命中测试直接跳过 guest，造成暂停/我来操作
   * 后用户仍点不进网页的假死。真正的自动驾驶开关在主进程 driver.ts 的 paused 状态，
   * 不是靠 CSS 吃掉鼠标。
   */
  const pointerEvents = 'auto';

  const onSend = () => {
    const value = input.trim();
    if (!value) return;
    // 仅追加到内存 state，不落盘、不发网络
    setMessages((prev) => prev.concat({ id: Date.now(), role: 'user', text: value }));
    setInput('');
    setHasUnread(false);
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

  const onPauseDriving = () => {
    setController('user');
    void window.workbench?.pauseDriving().then((value) => setDrivingPaused(value));
  };

  const onResumeDriving = () => {
    setController('ai');
    void window.workbench?.resumeDriving().then((value) => setDrivingPaused(value));
  };

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

        <div className="buttons-row">
          <button className="btn" type="button" onClick={() => setHasUnread((v) => !v)}>
            切换红点
          </button>
        </div>

        <div className="sidebar__footer">桥：{bridgeInfo}</div>
      </aside>

      {/* 中间：聊天区 */}
      <main className="middle">
        <div className="chat">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))}
        </div>

        <div className="inputBar">
          <input
            placeholder="和小助聊两句（仅内存，不会保存）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
          />
          <button type="button" onClick={onSend}>
            发送
          </button>
        </div>
      </main>

      {/* 右侧：控制文案 + 任务卡片 + 调试区 + 内嵌工作台浏览器 */}
      <aside className="right">
        <div className="banner">{bannerText}</div>

        <div className="controls">
          <button className="btn" type="button" onClick={onPauseDriving}>
            暂停
          </button>
          <button className="btn" type="button" onClick={onResumeDriving}>
            继续
          </button>
          <button className="btn" type="button" onClick={onPauseDriving}>
            我来操作
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
            驾驶状态：{drivingPaused ? '已暂停（click / type 不会自动执行）' : '驾驶中'}
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
