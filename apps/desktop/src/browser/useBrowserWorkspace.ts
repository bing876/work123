import { useEffect, useMemo, useRef, useState } from 'react';
import { HOME_URL } from './sites';
import { SOFT_TAB_HINT, hostLabel, sameSite, toHttpUrl } from './url';
import type { BrowserPageInfo, BrowserTabView } from './types';

/**
 * 第 20 步 · 浏览器模块：**按智能体分桶的工作区状态机**（tab 状态 + 开页/关页 + 驾驶接口）。
 *
 * 硬约束（本步钉死，别推翻）：
 *   - 仍是 Electron 的 <webview>，**不套 Edge / Chrome / CEF，不用 Playwright**；
 *   - 每张页的分区是 `partitionFor(agentId)` —— **一个智能体一套 cookie / 登录态**，
 *     绝不再用全局的 `persist:workbench-browser`；
 *   - **没有活页上限**（第 20 步取消了 MAX_LIVE_PAGES=10）：开多少张都行，只提示「开太多会卡」，
 *     **绝不偷偷关页、也绝不顶掉最旧那张**；
 *   - 切 tab = 把对应那张 webview 放到最前面（z-index），**不为每个 tab 开 BrowserWindow**；
 *   - 收起不是把页面藏没：舞台仍留一块高度（webview 尺寸为 0 会让驾驶点不中任何元素）。
 *
 * 状态是**窗口级 + 按智能体分桶**的：
 *   - 一个智能体 = 一套独立浏览器（自己的 tab、自己的当前页、自己的 cookie）；
 *   - 切智能体只换「哪一桶可见」，**所有页的 webview 一直挂着不卸载** ——
 *     这样切到别的智能体去聊别的时，原来那几路驾驶不会断，切回来页面和滚动都还在。
 *
 * 第 18 步起的「治混乱」规矩照旧：
 *   - **开页成功不往聊天里写东西**（看 tab 就行，不再每页一条「已打开」）；
 *   - 关 tab 只从工作区消失，聊天里最多留**一句**人话（单条提示，不累加、不列关闭清单）。
 */

interface BrowserWorkspaceOptions {
  /** 往聊天区说**一句**人话（单条提示，不累加）。开页成功不报——看 tab 就行。 */
  onNote?: (text: string) => void;
  /** 此刻正在聊的那个智能体（**响应式**：一变就换可见的那一桶） */
  currentAgentId: number | null;
  /** 同上，给异步流程取「此刻」的值（回调里读，避免闭包拿到过期的） */
  getCurrentAgent: () => number | null;
}

export interface BrowserWorkspace {
  /** 此刻正在聊的那个智能体（舞台靠它决定「谁的页该露出来」） */
  currentAgentId: number | null;
  /** **当前智能体自己**的活页（顶栏显示的就是这些） */
  tabs: BrowserTabView[];
  /** **所有智能体**的活页（舞台要把它们全挂着——切走的那些页也必须活着） */
  allTabs: BrowserTabView[];
  /** 当前智能体切到前面的那张 */
  activeId: number | null;
  active: BrowserTabView | null;
  expanded: boolean;
  /** 正在被驾驶员操作的那几张（tabId，跨智能体）：标签上点一个小圆点 */
  drivingIds: number[];
  /** 当前智能体的页数（没有上限，只用来显示与提示） */
  tabCount: number;
  /** 页数偏多（≥ SOFT_TAB_HINT）：UI 上提示「开太多会卡」，**不关页** */
  softHint: boolean;
  setExpanded: (next: boolean) => void;
  toggleExpanded: () => void;

  /** <webview> 宿主：元素挂上/摘下时登记（驾驶要靠它拿 guest webContents id） */
  registerWebview: (tabId: number, el: HTMLElement | null) => void;
  /** 页面自己改了地址/标题（点链接、SPA 跳转）时回报，用来更新标签与 URL 栏 */
  notePageInfo: (tabId: number, info: BrowserPageInfo) => void;

  /**
   * 给**某个智能体**开页（同站复用只在它自己那些页里找）。
   * 第 20 步：没有上限、没有排队、没有顶掉最旧 —— 一定能开出新页，返回它的 tabId。
   */
  openUrl: (agentId: number, rawUrl: string) => Promise<number | null>;
  openHome: (agentId: number) => Promise<number | null>;
  /** 用户点「＋」：给此刻正在聊的智能体开一张默认主页（不自动发车，等他给指令） */
  openNewTab: () => void;
  /** 用户点 ✕ 关掉一张（聊天里最多留一句人话） */
  closeTab: (tabId: number) => void;
  /** 某个智能体开的那些页一起关掉（删智能体 / 登出时用；不单独刷聊天） */
  closeTabsOfAgent: (agentId: number) => void;
  closeAllTabs: () => void;
  activate: (tabId: number) => void;
  navigate: (tabId: number, url: string) => void;
  /** 把焦点交给当前智能体那张页（它还没开过就先开一张默认主页） */
  focusActive: () => void;

  /** 驾驶接口：这张 tab 的 guest webContents id（还没 dom-ready 时为 undefined） */
  webContentsIdOf: (tabId: number) => number | undefined;
  /** 驾驶接口：等这张页就绪并拿到 guest id（webview 没 dom-ready 时 getWebContentsId 会抛错） */
  awaitWebContentsId: (tabId: number) => Promise<number | undefined>;
  /** 驾驶接口：主进程报的 guest id → 是哪张 tab（跨智能体找，事件才落得回正确的聊天） */
  tabIdOfWebContents: (wcId: number) => number | null;
  /** 这张 tab 是哪个智能体开的（驾驶事件按它落回正确的聊天） */
  ownerOf: (tabId: number) => number | undefined;
  /** 主进程说「把焦点给这张页」 */
  focusByWebContents: (wcId: number) => void;
  /** 主进程说「打开这个网址」（落给此刻正在聊的那个智能体） */
  openFromMain: (url: string) => void;
  /** 同步「到底哪几张在跑」 */
  refreshDriving: () => Promise<void>;
  /** 「停」：点名就只停那一路；没点名且当前页没在跑 → 全停 */
  stopDriving: (tabId?: number) => void;
}

export function useBrowserWorkspace(options: BrowserWorkspaceOptions): BrowserWorkspace {
  // 回调放进 ref：hook 里一堆异步流程要用最新值，但不该因为它们变化重建所有函数
  const onNoteRef = useRef(options.onNote);
  onNoteRef.current = options.onNote;
  const getAgentRef = useRef(options.getCurrentAgent);
  getAgentRef.current = options.getCurrentAgent;
  /** 当前可见的智能体：切它只换「哪一桶可见」，页本身一张都不卸载 */
  const visibleAgentId = options.currentAgentId;
  const visibleAgentRef = useRef<number | null>(visibleAgentId);
  visibleAgentRef.current = visibleAgentId;

  /**
   * 桶是**按智能体**分的：`{ [agentId]: 这个智能体自己的活页[] }`。
   * ref 是权威副本（同步读写，避免同一 tick 里连续开页时读到过期的 state）。
   */
  const pagesRef = useRef<Record<number, BrowserTabView[]>>({});
  const [pages, setPages] = useState<Record<number, BrowserTabView[]>>({});
  const commitPages = (next: Record<number, BrowserTabView[]>): void => {
    pagesRef.current = next;
    setPages(next);
  };

  /** 每个智能体自己「切到前面的是哪张」 */
  const activeRef = useRef<Record<number, number | null>>({});
  const [activeByAgent, setActiveByAgent] = useState<Record<number, number | null>>({});
  const commitActive = (next: Record<number, number | null>): void => {
    activeRef.current = next;
    setActiveByAgent(next);
  };

  /** 浏览器区是否展开。收起也留一块高度——webview 尺寸为 0 会让驾驶点不中任何元素 */
  const [expanded, setExpanded] = useState(true);
  const [drivingIds, setDrivingIds] = useState<number[]>([]);
  const drivingIdsRef = useRef<number[]>([]);
  drivingIdsRef.current = drivingIds;

  /** tabId → <webview> 元素 */
  const webviewRefs = useRef<Record<number, HTMLElement | null>>({});

  const note = (text: string): void => onNoteRef.current?.(text);

  /** 标签上显示什么：标题优先，兜底域名 */
  const label = (t: BrowserTabView): string => t.title || hostLabel(t.url) || t.bootUrl;

  /** 渲染用：所有智能体的页摊平（舞台要全挂着）；找页一律走 pagesRef，别用这个 */
  const allTabs = useMemo(() => Object.values(pages).flat(), [pages]);

  const tabs = visibleAgentId !== null ? pages[visibleAgentId] ?? [] : [];
  const activeId = visibleAgentId !== null ? activeByAgent[visibleAgentId] ?? null : null;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  /** 摊平所有桶（**以 ref 为准**，同一 tick 里刚开的页也能立刻找到） */
  const flatTabs = (): BrowserTabView[] => Object.values(pagesRef.current).flat();

  const findTab = (tabId: number): BrowserTabView | undefined => {
    for (const list of Object.values(pagesRef.current)) {
      const t = list.find((x) => x.id === tabId);
      if (t) return t;
    }
    return undefined;
  };
  const bucketOf = (agentId: number): BrowserTabView[] => pagesRef.current[agentId] ?? [];

  const setBucket = (agentId: number, next: BrowserTabView[]): void => {
    commitPages({ ...pagesRef.current, [agentId]: next });
  };

  const setActiveFor = (agentId: number, tabId: number | null): void => {
    commitActive({ ...activeRef.current, [agentId]: tabId });
  };

  // ---- 驾驶接口：tab ↔ guest webContents id ----

  const webContentsIdOf = (tabId: number): number | undefined => {
    const el = webviewRefs.current[tabId] as unknown as { getWebContentsId?: () => number } | null;
    try {
      return el?.getWebContentsId?.();
    } catch {
      return undefined;
    }
  };

  /**
   * 等某张 tab 里的 <webview> 就绪并拿 guest webContents id。
   * webview 还没 dom-ready 时 getWebContentsId() 会抛错，所以重试几轮。
   * 第 17 步起**必须点名是哪张页**——主进程不会再自己瞎挑一张。
   */
  const awaitWebContentsId = async (tabId: number): Promise<number | undefined> => {
    for (let i = 0; i < 25; i += 1) {
      const id = webContentsIdOf(tabId);
      if (typeof id === 'number' && id >= 0) return id;
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return undefined;
  };

  /** 反过来：主进程报的 guest id → 是哪张 tab（跨智能体找） */
  const tabIdOfWebContents = (wcId: number): number | null => {
    for (const t of flatTabs()) if (webContentsIdOf(t.id) === wcId) return t.id;
    return null;
  };

  const ownerOf = (tabId: number): number | undefined => findTab(tabId)?.agentId;

  /** 主进程当前在驾驶哪几张页 → 映射成 tabId（标签圆点） */
  const refreshDriving = async (): Promise<void> => {
    const list = await window.workbench?.agentLanes?.();
    if (!list) return;
    const ids: number[] = [];
    for (const t of flatTabs()) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId === 'number' && list.includes(wcId)) ids.push(t.id);
    }
    setDrivingIds(ids);
  };

  // ---- 切页 / 导航 / 关页 ----

  const activate = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    setActiveFor(t.agentId, tabId);
    setExpanded(true);
    window.setTimeout(() => {
      const el = webviewRefs.current[tabId] as unknown as { focus?: () => void } | null;
      el?.focus?.();
    }, 60);
  };

  /** 导航某张页（URL 栏回车 / 同站改道）：走 <webview>.loadURL，不经过主进程 */
  const navigate = (tabId: number, url: string): void => {
    const el = webviewRefs.current[tabId] as unknown as { loadURL?: (u: string) => void } | null;
    try {
      el?.loadURL?.(url);
    } catch {
      /* 页面还没就绪，等它自己加载 */
    }
    const t = findTab(tabId);
    if (!t) return;
    setBucket(
      t.agentId,
      bucketOf(t.agentId).map((x) => (x.id === tabId ? { ...x, url, title: hostLabel(url) } : x)),
    );
  };

  /**
   * 真正把一张页摘掉（不刷聊天）。用户点 ✕ 走 closeTab，删智能体走 closeTabsOfAgent。
   * 这张页上如果正有一路在跑，先**只**放下那一路——别路照跑（「第二句不废第一张」）。
   */
  const removeTab = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    const wcId = webContentsIdOf(tabId);
    if (typeof wcId === 'number') void window.workbench?.agentDrop?.(wcId);
    delete webviewRefs.current[tabId];
    setBucket(
      t.agentId,
      bucketOf(t.agentId).filter((x) => x.id !== tabId),
    );
    if ((activeRef.current[t.agentId] ?? null) === tabId) setActiveFor(t.agentId, null);
    window.setTimeout(() => {
      void refreshDriving();
    }, 150);
  };

  /** 用户点 ✕：只从工作区消失，聊天里最多留**一句**人话（不列关闭清单） */
  const closeTab = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    const rest = bucketOf(t.agentId).length - 1;
    removeTab(tabId);
    note(rest > 0 ? `已关掉「${label(t)}」这张页，这个智能体还剩 ${rest} 张。` : '已关掉它最后一张页，这个智能体的浏览器空了。');
  };

  /** 删智能体 / 登出：把它开的那些页一起摘掉（不单独刷聊天，调用方自己给一句话） */
  const closeTabsOfAgent = (agentId: number): void => {
    for (const t of bucketOf(agentId)) removeTab(t.id);
  };

  const closeAllTabs = (): void => {
    for (const t of flatTabs()) removeTab(t.id);
    commitPages({});
    commitActive({});
    setDrivingIds([]);
  };

  /**
   * 给某个智能体开一张页：
   *   1. **只在这个智能体自己的页里**找同站 → 有就复用那张改道，不新开；
   *   2. 没有就新开一张 —— **没有上限、不排队、不顶掉最旧**（第 20 步取消硬顶）；
   *   3. 页数刚跨过 SOFT_TAB_HINT 时说一句「开太多会卡」，**但绝不关页**。
   *
   * ⚠️ 成功开页**不往聊天里写任何东西**——工作区顶栏多出一个 tab 就是结果。
   */
  const openUrl = async (agentId: number, rawUrl: string): Promise<number | null> => {
    const url = toHttpUrl(rawUrl) ?? HOME_URL;
    const bucket = bucketOf(agentId);
    const same = bucket.find((t) => sameSite(t.url, url) || sameSite(t.bootUrl, url));
    if (same) {
      activate(same.id);
      if (same.url !== url) navigate(same.id, url);
      return same.id;
    }
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setBucket(agentId, bucket.concat({ id, agentId, bootUrl: url, url, title: hostLabel(url) }));
    setActiveFor(agentId, id);
    setExpanded(true);
    if (bucket.length + 1 === SOFT_TAB_HINT) {
      note(
        `这个智能体的页开到 ${SOFT_TAB_HINT} 张了，再往上会有点卡——不拦你，也不用我关，想清爽自己点 ✕ 就行。`,
      );
    }
    return id;
  };

  const openHome = (agentId: number): Promise<number | null> => openUrl(agentId, HOME_URL);

  /**
   * 用户点「＋」：给**此刻正在聊的那个智能体**开一张默认主页。
   * 注意（既定设计，别乱改）：目标就是默认主页，所以同站复用会让它落在
   * 「本来就在百度」的那张页上（把当前页导航回主页），而不是又开一张。
   */
  const openNewTab = (): void => {
    const agentId = getAgentRef.current();
    if (agentId === null) return;
    void openUrl(agentId, HOME_URL);
  };

  /** 把焦点交给当前智能体那张页（它还没开过就先开一张默认主页） */
  const focusActive = (): void => {
    const agentId = getAgentRef.current();
    if (agentId === null) return;
    const cur = activeRef.current[agentId] ?? null;
    if (cur === null) void openUrl(agentId, HOME_URL);
    else activate(cur);
  };

  /**
   * 主进程说「把焦点给这张页」。
   * 第 20 步：只给**当前智能体自己**的页；别家智能体的页在后台照跑，
   * 但**不把用户的视线抢过去**（否则多智能体并行时画面会被别的智能体拽走）。
   */
  const focusByWebContents = (wcId: number): void => {
    const tabId = tabIdOfWebContents(wcId);
    if (tabId === null) {
      focusActive();
      return;
    }
    const t = findTab(tabId);
    if (t && t.agentId === visibleAgentRef.current) activate(tabId);
  };

  /** 主进程发来的 'open'（敏感字段等待时会发）：落给此刻正在聊的那个智能体 */
  const openFromMain = (url: string): void => {
    const agentId = getAgentRef.current();
    if (agentId === null || !url) return;
    void openUrl(agentId, url);
  };

  /**
   * 「停」：点名那张页就只停那一路；没点名则停当前这张，它没在跑就全停。
   * 这是唯一会让驾驶停下来的入口（闲聊不再打断驾驶）。
   */
  const stopDriving = (tabId?: number): void => {
    const agentId = visibleAgentRef.current;
    const target = typeof tabId === 'number' ? tabId : agentId !== null ? activeRef.current[agentId] ?? null : null;
    const wcId = typeof target === 'number' ? webContentsIdOf(target) : undefined;
    const thisOneRunning = typeof target === 'number' && drivingIdsRef.current.includes(target);
    if (thisOneRunning && typeof wcId === 'number') void window.workbench?.agentDrop?.(wcId);
    else void window.workbench?.agentStop?.();
    window.setTimeout(() => {
      void refreshDriving();
    }, 200);
  };

  const registerWebview = (tabId: number, el: HTMLElement | null): void => {
    if (el) webviewRefs.current[tabId] = el;
    else delete webviewRefs.current[tabId];
  };

  const notePageInfo = (tabId: number, info: BrowserPageInfo): void => {
    const t = findTab(tabId);
    if (!t) return;
    setBucket(
      t.agentId,
      bucketOf(t.agentId).map((x) =>
        x.id === tabId
          ? { ...x, ...(info.url ? { url: info.url } : {}), ...(info.title ? { title: info.title } : {}) }
          : x,
      ),
    );
  };

  const setExpandedNext = (next: boolean): void => setExpanded(next);
  const toggleExpanded = (): void => setExpanded((v) => !v);

  /** 活页变化（新开/关闭/切智能体）后同步一次「哪几张正在被驾驶」 */
  useEffect(() => {
    void refreshDriving();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  return {
    currentAgentId: visibleAgentId,
    tabs,
    allTabs,
    activeId,
    active,
    expanded,
    drivingIds,
    tabCount: tabs.length,
    softHint: tabs.length >= SOFT_TAB_HINT,
    setExpanded: setExpandedNext,
    toggleExpanded,
    registerWebview,
    notePageInfo,
    openUrl,
    openHome,
    openNewTab,
    closeTab,
    closeTabsOfAgent,
    closeAllTabs,
    activate,
    navigate,
    focusActive,
    webContentsIdOf,
    awaitWebContentsId,
    tabIdOfWebContents,
    ownerOf,
    focusByWebContents,
    openFromMain,
    refreshDriving,
    stopDriving,
  };
}
