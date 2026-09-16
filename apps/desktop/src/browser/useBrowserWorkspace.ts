import { useEffect, useRef, useState } from 'react';
import { HOME_URL } from './sites';
import { MAX_LIVE_PAGES, hostLabel, sameSite, toHttpUrl } from './url';
import type { BrowserPageInfo, BrowserTabView } from './types';

/**
 * 第 18 步 · 浏览器模块：**工作区状态机**（tab 状态 + 开页/关页 + 上限 + 驾驶接口）。
 *
 * 硬约束（本步钉死，别推翻）：
 *   - 仍是 Electron 的 <webview>，**不套 Edge / Chrome / CEF，不用 Playwright**；
 *   - 同时最多 MAX_LIVE_PAGES 张**活着的** <webview>（都是 partition=persist:workbench-browser）；
 *   - 切 tab = 把对应那张 webview 放到最前面（z-index），**不为每个 tab 开 BrowserWindow**；
 *   - 收起不是把页面藏没：舞台仍留一块高度（webview 尺寸为 0 会让驾驶点不中任何元素）。
 *
 * 状态是**窗口级**的（不是某条聊天消息里的卡片）：
 * 这样切到别的智能体去聊别的时，正在跑的那几路驾驶不会因为 webview 被卸载而断掉。
 *
 * 本步的「治混乱」改动：
 *   - **开页成功不往聊天里写东西**（看 tab 就行，不再每页一条「已打开」）；
 *   - 关 tab 只从工作区消失，聊天里最多留**一句**人话（单条提示，不累加、不列关闭清单）。
 */

interface BrowserWorkspaceOptions {
  /** 往聊天区说**一句**人话（单条提示，不累加）。开页成功不报——看 tab 就行。 */
  onNote?: (text: string) => void;
  /** 此刻正在聊的那个智能体：主进程发来的「打开某网址」要记在它名下 */
  getCurrentAgent: () => number | null;
}

export interface BrowserWorkspace {
  /** 打开着的活页（按开页先后） */
  tabs: BrowserTabView[];
  /** 当前切到前面的那张 */
  activeId: number | null;
  active: BrowserTabView | null;
  expanded: boolean;
  /** 正在被驾驶员操作的那几张（tabId）：标签上点一个小圆点 */
  drivingIds: number[];
  setExpanded: (next: boolean) => void;
  toggleExpanded: () => void;

  /** <webview> 宿主：元素挂上/摘下时登记（驾驶要靠它拿 guest webContents id） */
  registerWebview: (tabId: number, el: HTMLElement | null) => void;
  /** 页面自己改了地址/标题（点链接、SPA 跳转）时回报，用来更新标签与 URL 栏 */
  notePageInfo: (tabId: number, info: BrowserPageInfo) => void;

  /** 开页（同站复用 / 没满就开 / 满了顶最旧空闲那张 / 全忙则排队）；返回 tabId，排队时为 null */
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
  /** 把焦点交给当前那张页（还没开过就先开一张默认主页） */
  focusActive: () => void;

  /** 驾驶接口：这张 tab 的 guest webContents id（还没 dom-ready 时为 undefined） */
  webContentsIdOf: (tabId: number) => number | undefined;
  /** 驾驶接口：等这张页就绪并拿到 guest id（webview 没 dom-ready 时 getWebContentsId 会抛错） */
  awaitWebContentsId: (tabId: number) => Promise<number | undefined>;
  /** 驾驶接口：主进程报的 guest id → 是哪张 tab */
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

  const [tabs, setTabs] = useState<BrowserTabView[]>([]);
  const tabsRef = useRef<BrowserTabView[]>([]);
  tabsRef.current = tabs;

  const [activeId, setActiveId] = useState<number | null>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  /** 满了 MAX_LIVE_PAGES 张、而且全都在被驾驶时，下一个开页请求先排队（空出来再开） */
  const [queue, setQueue] = useState<Array<{ agentId: number; url: string }>>([]);
  /** 浏览器区是否展开。收起也留一块高度——webview 尺寸为 0 会让驾驶点不中任何元素 */
  const [expanded, setExpanded] = useState(true);
  const [drivingIds, setDrivingIds] = useState<number[]>([]);
  const drivingIdsRef = useRef<number[]>([]);
  drivingIdsRef.current = drivingIds;

  /** tabId → <webview> 元素 */
  const webviewRefs = useRef<Record<number, HTMLElement | null>>({});
  /** tabId → 发起它的智能体（把驾驶事件落回正确的聊天，不串） */
  const tabAgentRef = useRef<Record<number, number>>({});

  const note = (text: string): void => onNoteRef.current?.(text);

  /** 标签上显示什么：标题优先，兜底域名 */
  const label = (t: BrowserTabView): string => t.title || hostLabel(t.url) || t.bootUrl;

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

  /** 反过来：主进程报的 guest id → 是哪张 tab */
  const tabIdOfWebContents = (wcId: number): number | null => {
    for (const t of tabsRef.current) if (webContentsIdOf(t.id) === wcId) return t.id;
    return null;
  };

  const ownerOf = (tabId: number): number | undefined => tabAgentRef.current[tabId];

  /** 主进程当前在驾驶哪几张页 → 映射成 tabId（标签圆点 + 满了该顶谁） */
  const refreshDriving = async (): Promise<void> => {
    const list = await window.workbench?.agentLanes?.();
    if (!list) return;
    const ids: number[] = [];
    for (const t of tabsRef.current) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId === 'number' && list.includes(wcId)) ids.push(t.id);
    }
    setDrivingIds(ids);
  };

  // ---- 切页 / 导航 / 关页 ----

  const activate = (tabId: number): void => {
    setActiveId(tabId);
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
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, url, title: hostLabel(url) } : t)));
  };

  /**
   * 真正把一张页摘掉（不刷聊天）。用户点 ✕ 走 closeTab，内部腾地方走这里。
   * 这张页上如果正有一路在跑，先**只**放下那一路——别路照跑（「第二句不废第一张」）。
   */
  const removeTab = (tabId: number): void => {
    const wcId = webContentsIdOf(tabId);
    if (typeof wcId === 'number') void window.workbench?.agentDrop?.(wcId);
    delete webviewRefs.current[tabId];
    delete tabAgentRef.current[tabId];
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveId((cur) => (cur === tabId ? null : cur));
    window.setTimeout(() => {
      void refreshDriving();
    }, 150);
  };

  /** 用户点 ✕：只从工作区消失，聊天里最多留**一句**人话（不列关闭清单） */
  const closeTab = (tabId: number): void => {
    const t = tabsRef.current.find((x) => x.id === tabId);
    if (!t) return;
    const rest = tabsRef.current.length - 1;
    removeTab(tabId);
    note(rest > 0 ? `已关掉「${label(t)}」这张页，工作区还剩 ${rest} 张。` : '已关掉最后一张页，浏览器工作区空了。');
  };

  /** 删智能体 / 登出：把它开的那些页一起摘掉（不单独刷聊天，调用方自己给一句话） */
  const closeTabsOfAgent = (agentId: number): void => {
    for (const t of tabsRef.current) if (tabAgentRef.current[t.id] === agentId) removeTab(t.id);
  };

  const closeAllTabs = (): void => {
    for (const t of tabsRef.current) removeTab(t.id);
    setQueue([]);
    setDrivingIds([]);
  };

  /**
   * 打开一张页（上限与复用的规矩都在这里）：
   *   1. 同站已有 → **复用**那张页改道，不新开；
   *   2. 还没满 MAX_LIVE_PAGES 张 → 直接开（第 3 张起不再顶掉任何页）；
   *   3. 已满 → 顶掉最旧那张**没在跑**的活页；全都在跑 → 排队等空位。
   * 无论哪条路，都**不会**出现第 MAX_LIVE_PAGES + 1 张同时活着的 webview。
   *
   * ⚠️ 成功开页**不往聊天里写任何东西**——工作区顶栏多出一个 tab 就是结果。
   */
  const openUrl = async (agentId: number, rawUrl: string): Promise<number | null> => {
    const url = toHttpUrl(rawUrl) ?? HOME_URL;
    const cur = tabsRef.current;
    const same = cur.find((t) => sameSite(t.url, url) || sameSite(t.bootUrl, url));
    if (same) {
      activate(same.id);
      if (same.url !== url) navigate(same.id, url);
      return same.id;
    }
    if (cur.length >= MAX_LIVE_PAGES) {
      const busy = (await window.workbench?.agentLanes?.()) ?? [];
      const victim = cur.find((t) => {
        const id = webContentsIdOf(t.id);
        return typeof id !== 'number' || !busy.includes(id);
      });
      if (!victim) {
        setQueue((q) => q.concat({ agentId, url }));
        note(`已经有 ${MAX_LIVE_PAGES} 张页在被驾驶（硬顶 ${MAX_LIVE_PAGES} 张活页）：这一张先排队，等一路停下来再打开。`);
        void refreshDriving(); // 同步一次「到底哪几张在跑」，等它们停下来再自动顶掉
        return null;
      }
      const victimLabel = label(victim);
      removeTab(victim.id);
      note(`最多同时 ${MAX_LIVE_PAGES} 张活页：先把最旧的「${victimLabel}」关掉，再开这一张。`);
    }
    const id = Date.now() + Math.floor(Math.random() * 1000);
    tabAgentRef.current[id] = agentId;
    setTabs((prev) => prev.concat({ id, bootUrl: url, url, title: hostLabel(url) }));
    setActiveId(id);
    setExpanded(true);
    return id;
  };

  const openHome = (agentId: number): Promise<number | null> => openUrl(agentId, HOME_URL);

  /**
   * 用户点「＋」：开一张默认主页。
   * 注意（既定设计，别乱改）：目标就是默认主页，所以同站复用会让它落在
   * 「本来就在百度」的那张页上（把当前页导航回主页），而不是又开一张。
   */
  const openNewTab = (): void => {
    const agentId = getAgentRef.current();
    if (agentId === null) return;
    void openUrl(agentId, HOME_URL);
  };

  /** 把焦点交给当前那张页（还没开过就先开一张默认主页） */
  const focusActive = (): void => {
    const cur = activeIdRef.current;
    if (cur === null) {
      const agentId = getAgentRef.current();
      if (agentId === null) return;
      void openUrl(agentId, HOME_URL);
    } else {
      activate(cur);
    }
  };

  const focusByWebContents = (wcId: number): void => {
    const tabId = tabIdOfWebContents(wcId);
    if (tabId !== null) activate(tabId);
    else focusActive();
  };

  /** 主进程发来的 'open'（敏感字段等待时会发）：落给此刻正在聊的那个智能体 */
  const openFromMain = (url: string): void => {
    const agentId = getAgentRef.current();
    if (agentId === null || !url) return;
    void openUrl(agentId, url);
  };

  /**
   * 「停」：点名那张页就只停那一路；没点名则停当前这张，它没在跑就全停。
   * 这是本步唯一会让驾驶停下来的入口（闲聊不再打断驾驶）。
   */
  const stopDriving = (tabId?: number): void => {
    const target = typeof tabId === 'number' ? tabId : activeIdRef.current;
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
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, ...(info.url ? { url: info.url } : {}), ...(info.title ? { title: info.title } : {}) }
          : t,
      ),
    );
  };

  const setExpandedNext = (next: boolean): void => setExpanded(next);
  const toggleExpanded = (): void => setExpanded((v) => !v);

  /** 活页变化（新开/关闭）后同步一次「哪几张正在被驾驶」 */
  useEffect(() => {
    void refreshDriving();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  /** 排队中的开页请求：一有空位就打开（用户关掉一张、或某一路跑完） */
  useEffect(() => {
    if (queue.length === 0) return;
    // 满 MAX_LIVE_PAGES 张、而且全都在被驾驶 → 继续等（等 drivingIds 变化再试一次）
    if (tabs.length >= MAX_LIVE_PAGES && drivingIds.length >= MAX_LIVE_PAGES) return;
    const [next] = queue;
    setQueue((q) => q.slice(1));
    void openUrl(next.agentId, next.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, queue, drivingIds]);

  return {
    tabs,
    activeId,
    active: tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null,
    expanded,
    drivingIds,
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
