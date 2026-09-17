import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserInstanceInfo } from '@ai-workbench/shared';
import { HOME_URL } from './sites';
import { SOFT_TAB_HINT, hostLabel, sameSite, toHttpUrl } from './url';
import type { BrowserPageInfo, BrowserTabView } from './types';

/**
 * 第 20 步 · 浏览器模块：**按智能体分桶的工作区状态机**（tab 状态 + 开页/关页 + 驾驶接口）。
 *
 * 硬约束（本步钉死，别推翻）：
 *   - 仍是 Electron 的 <webview>，**不套 Edge / Chrome / CEF，不用 Playwright**；
 *   - 每张页的分区是 `partitionFor(projectId)` —— **一个项目一套 cookie / 登录态**，
 *     同项目的多个智能体共用这一套（Phase 3 改的粒度），不同项目之间完全隔离；
 *     绝不再用全局的 `persist:workbench-browser`，也绝不再按 agentId 分（那是第 20 步的旧口径）；
 *   - **活页上限由配置项 `maxBrowserInstances` 决定**（第 22 步起，默认 4，设置里可调）：
 *     到顶只**拒绝新开**并说一句人话，**绝不偷偷关页、也绝不顶掉最旧那张**
 *     （第 20 步取消的是写死的 `MAX_LIVE_PAGES = 10`，不是「有上限」这件事本身）；
 *   - 切 tab = 把对应那张 webview 放到最前面（z-index），**不为每个 tab 开 BrowserWindow**；
 *   - 收起不是把页面藏没：舞台仍留一块高度（webview 尺寸为 0 会让驾驶点不中任何元素）。
 *
 * ⚠️ **Phase 3 的红线（别改过头）**：分区合并**只发生在登录态这一层**。
 *    下面所有桶（`pages` / `active`）、`openUrl(agentId, …)`、`closeTabsOfAgent(agentId)`、
 *    驾驶接口、`stopDriving` 全部**仍然按 agentId**：同项目的两个智能体
 *    共用一套 cookie，但**各有各的标签页、各有各的任务**，不合并显示、不共享执行状态。
 *
 * 状态是**窗口级 + 按智能体分桶**的：
 *   - 一个智能体 = 一套独立的标签页（自己的 tab、自己的当前页）；登录态与同项目的兄弟共享；
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
  /**
   * 第 22 步 · D：**多实例上限**（默认 4，设置里可调）的取值函数。
   * 传函数而不是数值：配置随时可能被改，用函数才能永远读到最新值，
   * 也避免「改了配置 → 整个 hook 重建 → 页的引用全换一遍」。
   */
  getMaxInstances?: () => number;
  /**
   * Phase 3：**某个智能体属于哪个项目**。
   *
   * 只用来算这张页的**分区**（登录态那一层，同项目共享）；不用来分桶 ——
   * 桶键永远是 agentId（标签页/任务按智能体隔离，这条没变）。
   * 传函数而不是映射对象：智能体是活数据（新建/切换项目会变），用函数才读得到最新值。
   * 返回 null = 认不出 → 落兜底分区（`-none`），**不跟任何真项目混**。
   */
  getProjectOfAgent?: (agentId: number) => number | null;
}

/**
 * 第 22 步：多实例上限的兜底值。
 *
 * ⚠️ 这是 `packages/shared` 里 `DEFAULT_SETTINGS.maxBrowserInstances` 的**第二份**。
 * 正常路径下上限永远由主进程的配置经 `getMaxInstances` 给到，这里只在
 * 「配置还没同步过来 / 桥异常」时兜底 —— 宁可兜一个保守值，也不要静默变成无上限。
 */
const FALLBACK_MAX_INSTANCES = 4;

export interface BrowserWorkspace {
  /** 此刻正在聊的那个智能体（舞台靠它决定「谁的页该露出来」） */
  currentAgentId: number | null;
  /** **当前智能体自己**的活页（顶栏显示的就是这些 —— 同项目兄弟智能体的页不在这儿） */
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
   * Phase 3：把「这张页的 guest webContents id 属于哪个智能体」告诉主进程。
   *
   * 主进程从分区名里只能读到**项目**，读不到智能体；而下载记录要能标出
   * 「这是哪个智能体触发的」，所以由这边在页就绪时登记一次。
   */
  noteOwner: (tabId: number) => void;

  /**
   * Phase 4：记一次「这个实例刚被用过」（用户切到它 / 它导航了 / 它被驾驶员推进一步）。
   *
   * 只有时间戳，不产生任何副作用，也不触发渲染 —— 它就是「最久未使用」排序的原料。
   * 驾驶员推进时由 App.tsx 代调（那边才收得到主进程的 step 事件）。
   */
  touchTab: (tabId: number) => void;
  /**
   * Phase 4：把当前**所有**浏览器实例（含最后使用时间）摘一份给资源守护者。
   *
   * ⚠️ 只报「已经拿到 guest id」的页 —— 还没 dom-ready 的页在主进程那边
   *    也对应不到进程，报上去只会让排序里多一条对不上的记录。
   */
  instanceList: () => BrowserInstanceInfo[];

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
  /** 第 22 步：多实例上限的取值函数（同样是每次调用时读最新配置） */
  const getMaxInstancesRef = useRef(options.getMaxInstances);
  getMaxInstancesRef.current = options.getMaxInstances;
  /**
   * Phase 3：agentId → projectId 的解析（**只喂分区**）。
   * 同样每次调用时现读 —— 新建智能体 / 切项目后要立刻能认出来。
   */
  const getProjectOfAgentRef = useRef(options.getProjectOfAgent);
  getProjectOfAgentRef.current = options.getProjectOfAgent;
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

  /**
   * Phase 4：每个浏览器实例的时间线 —— 「最久未使用」排序的依据。
   *
   * 刻意只放 **ref** 不放 state：`lastActiveAt` 每次用时都要变，若走 state 会让
   * 整块浏览器 UI 跟着重渲染（监控不该成为新的性能负担）。它只在**上报给主进程**时被读，
   * 而"需要真实时刻"的那几处（授权 / 隔离 / 提示）本来就是事件驱动，不用它触发渲染。
   */
  const createdRef = useRef<Record<number, number>>({});
  const lastActiveRef = useRef<Record<number, number>>({});

  /**
   * Phase 4：记一次「这个实例刚被用过」。
   *
   * 触发点 = 用户切到这张 tab / 这张页导航或标题变化 / 这张页被驾驶员推进一步。
   * 不做「页面内鼠标点击」级别的追踪：那需要往 guest 页里注入监听（侵入别人的页面），
   * 而上面四个触发点已经足够回答"哪几个实例最该被关掉"这个问题。
   */
  const touchTab = (tabId: number): void => {
    if (!findTab(tabId)) return;
    lastActiveRef.current[tabId] = Date.now();
  };

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

  /**
   * Phase 3：把这张页的 guest id ↔ 智能体告诉主进程（下载记录要标「哪个智能体触发的」）。
   * 拿不到 guest id（还没 dom-ready）时什么都不做——等下一次（did-navigate / 切换）再报。
   */
  const noteOwner = (tabId: number): void => {
    const t = findTab(tabId);
    const wcId = webContentsIdOf(tabId);
    if (!t || typeof wcId !== 'number') return;
    void window.workbench?.browserOwner?.(wcId, t.agentId);
  };

  /**
   * Phase 4：当前所有浏览器实例（资源守护者排序用）。
   * `driving` 这里只是初值 —— 主进程会用自己 lanes 的权威值覆盖它（见 resource-guard.ts）。
   */
  const instanceList = (): BrowserInstanceInfo[] => {
    const out: BrowserInstanceInfo[] = [];
    for (const t of flatTabs()) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId !== 'number') continue;
      const created = createdRef.current[t.id] ?? Date.now();
      out.push({
        wcId,
        agentId: t.agentId,
        projectId: t.projectId,
        title: label(t),
        url: t.url || t.bootUrl,
        createdAt: created,
        lastActiveAt: lastActiveRef.current[t.id] ?? created,
        driving: drivingIdsRef.current.includes(t.id),
      });
    }
    return out;
  };

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
    // Phase 4：切到这张页 = 它刚被用过（「最久未使用」的排序依据）
    touchTab(tabId);
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
    touchTab(tabId); // Phase 4：导航也是「用过」
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
    // Phase 4：实例没了，它的时间线也一起清掉（否则 tabId 复用时会认错）
    delete createdRef.current[tabId];
    delete lastActiveRef.current[tabId];
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
   *   1. **只在这个智能体自己的页里**找同站 → 有就复用那张改道，不新开（复用不占额度）；
   *   2. 没有就新开一张 —— 不排队、不顶掉最旧；**第 22 步起受配置项
   *      `maxBrowserInstances`（默认 4）约束**：到顶就拒绝新开并说一句人话，返回 null；
   *   3. 页数刚跨过 SOFT_TAB_HINT 时说一句「开太多会卡」，**但绝不关页**。
   *
   * ⚠️ 成功开页**不往聊天里写任何东西**——工作区顶栏多出一个 tab 就是结果。
   *    （只有「到上限被拒」「开太多会卡」这两种情况才说话。）
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
    /**
     * 第 22 步 · D：**多实例上限**（默认 4，设置里可调）。
     *
     * 上限是**全局**的（跨智能体一起算）—— 每张页 = 一个独立渲染进程 + 一块 session 存储，
     * 吃的是整机内存，不是某个智能体的配额。
     *
     * ⚠️ 到顶只**拒绝新开**并把话说清楚，**绝不偷偷关掉已有页**
     *    （第 20 步钉死的规矩：宁可提示「开太多会卡」，也不替用户关页）。
     */
    const cap = Math.max(1, Math.floor(getMaxInstancesRef.current?.() ?? FALLBACK_MAX_INSTANCES));
    const live = flatTabs().length;
    if (live >= cap) {
      note(
        `已经开了 ${live} 张页，到上限 ${cap} 张了（这个数可以在设置里调大）。要开新的，先关掉一张。`,
      );
      return null;
    }
    setBucket(
      agentId,
      bucket.concat({
        id,
        // 标签页归属 = 智能体（这条没变）
        agentId,
        // 登录态归属 = 项目（Phase 3 新建的这条）；开页那一刻定下就不再变
        projectId: getProjectOfAgentRef.current?.(agentId) ?? null,
        bootUrl: url,
        url,
        title: hostLabel(url),
      }),
    );
    // Phase 4：记下建页时刻（时间线的起点）—— 放在"过了上限检查"之后，
    // 免得被拒的开页请求在 ref 里留一条对不上的时间线。
    createdRef.current[id] = Date.now();
    lastActiveRef.current[id] = createdRef.current[id];
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
    touchTab(tabId); // Phase 4：页面自己动了（点链接 / SPA 跳转 / 标题变化）= 它刚被用过
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
    noteOwner,
    touchTab,
    instanceList,
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
