import { useEffect, useState } from 'react';
import { SOFT_TAB_HINT, isHttpUrl, partitionFor, toHttpUrl } from './url';
import type { BrowserWorkspace } from './useBrowserWorkspace';
import { hostLabel } from './url';
import './styles.css';

/**
 * 第 22 步 · Phase 3：中栏那块**模拟浏览器**（resting card → hover Open pill → 全屏 viewer）。
 *
 * 交互模型（C1：resting 卡用 **live webview 缩小**，不用截图）：
 *   - 每张活页 = 一张 resting 卡片：卡片里就是**真的那张网页**（缩小显示，不是抓屏）；
 *   - 鼠标悬到卡片上 → 浮出一个 **Open** 药丸；
 *   - 点 Open → 同一张页**全屏**铺满舞台（viewer），URL 栏跟过去，点「← 卡片」回来。
 *
 * 硬约束（第 20/21 步钉死的，本步一个字都不改）：
 *   - **webview 一律不卸载**：切智能体 / 切视图只换 CSS 类，DOM 父子关系从头到尾不变
 *     （所以绝不用 portal 搬家 —— 搬家等于重挂，页会重载、驾驶会断）；
 *   - **绝不用 `display:none`**：别的智能体、被盖住的那些页一律
 *     `opacity: 0 + pointer-events: none`，尺寸与挂载状态完全不变
 *     （尺寸为 0 时，在它上面跑的那一路驾驶点不中任何元素）；
 *   - 每张页的 `partition` 按**它自己的智能体**算（一个智能体一套 cookie / 登录态）；
 *   - 到上限由工作区拒绝新开（见 useBrowserWorkspace），这里只负责显示。
 */

/** 元素上挂的私有字段：卸载时用来摘掉监听 */
type WebviewEl = HTMLElement & { __wbOff?: () => void };

export function BrowserPanel({ ws, agentLabel }: { ws: BrowserWorkspace; agentLabel?: string }) {
  const active = ws.active;
  /** URL 栏的草稿：用户正在编辑时不跟页面走，免得打字打到一半被覆盖 */
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  /** 全屏查看的是哪一张（null = 卡片视图） */
  const [viewerId, setViewerId] = useState<number | null>(null);

  useEffect(() => {
    if (editing) return;
    setDraft(active?.url ?? '');
  }, [active?.url, active?.id, editing]);

  /**
   * 切智能体 / 那张页被关掉 → 自动退出全屏。
   * 否则会把**别的智能体**的页留在 viewer 里，看起来就像「串了」。
   */
  useEffect(() => {
    if (viewerId === null) return;
    const t = ws.allTabs.find((x) => x.id === viewerId);
    if (!t || (ws.currentAgentId !== null && t.agentId !== ws.currentAgentId)) setViewerId(null);
  }, [ws.allTabs, ws.currentAgentId, viewerId]);

  const viewerMode = viewerId !== null && ws.allTabs.some((t) => t.id === viewerId);

  /**
   * 给 webview 挂监听（React 不会告诉我们这些）：
   *   1. 点站内链接、SPA 路由跳转、标题变化 → 反映到卡片标题和 URL 栏上；
   *   2. **协议闸（桌面侧）**：非 http(s) 的整页跳转当场取消，留在当前页。
   *      主进程里还有一道权威闸；渲染层这一道是双保险，也让「点不动」在本地就止住。
   * 元素卸载时把监听摘掉（用元素上的私有字段记住卸载函数）。
   */
  const bindRef = (id: number, el: HTMLElement | null): void => {
    ws.registerWebview(id, el);
    if (!el) return;
    const anyEl = el as WebviewEl;
    anyEl.__wbOff?.();
    const onTitle = (e: Event): void => {
      const title = String((e as Event & { title?: string }).title ?? '');
      if (title) ws.notePageInfo(id, { title });
    };
    const onNav = (e: Event): void => {
      const url = String((e as Event & { url?: string }).url ?? '');
      if (url) ws.notePageInfo(id, { url });
    };
    const onWillNavigate = (e: Event): void => {
      const url = String((e as Event & { url?: string }).url ?? '');
      if (url && !isHttpUrl(url)) {
        (e as Event & { preventDefault?: () => void }).preventDefault?.();
        console.warn('[browser] 已拦下非 http(s) 跳转，留在当前页：', url);
      }
    };
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('will-navigate', onWillNavigate);
    anyEl.__wbOff = () => {
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('will-navigate', onWillNavigate);
    };
  };

  /** 打开全屏：顺手把这张页设为「当前那张」，URL 栏就跟着它走 */
  const openViewer = (tabId: number): void => {
    ws.activate(tabId);
    setViewerId(tabId);
  };

  return (
    <div className={ws.expanded ? 'browserPanel browserPanel--expanded' : 'browserPanel'}>
      {/* 工具条：谁的浏览器 + 页数 + 「＋」+ 展开/收起（第 22 步起不再有 tab 条，卡片本身就是切换器） */}
      <div className="browserPanel__tabs" role="toolbar" aria-label="浏览器工具条">
        <span className="browserPanel__who" title="浏览器按智能体隔离：这是谁的页">
          {agentLabel ? `${agentLabel} 的浏览器` : '浏览器'}
        </span>
        {ws.softHint && (
          <span className="browserPanel__warn" title={`超过 ${SOFT_TAB_HINT} 张会开始有点卡，但不会自动关页`}>
            开太多会卡
          </span>
        )}
        <span className="browserPanel__count">{ws.tabCount} 张活页</span>
        <button
          type="button"
          className="browserTab__add"
          title="给这个智能体新开一张（到上限会拒绝，不会关掉已有的页）"
          onClick={() => ws.openNewTab()}
        >
          ＋
        </button>
        <button type="button" className="browserPanel__toggle" onClick={() => ws.toggleExpanded()}>
          {ws.expanded ? '收起' : '展开'}
        </button>
      </div>

      {/* URL 栏：跟着当前那张页走；全屏时多一个「← 卡片」 */}
      <div className="browserPanel__urlbar">
        {viewerMode && (
          <button
            type="button"
            className="browserPanel__back"
            title="回到卡片视图（页不会重载）"
            onClick={() => setViewerId(null)}
          >
            ← 卡片
          </button>
        )}
        <span className="browserPanel__scheme" aria-hidden="true">
          {/^https:/i.test(active?.url ?? '') ? '🔒' : '🌐'}
        </span>
        <input
          className="browserPanel__url"
          value={draft}
          spellCheck={false}
          placeholder="输入网址后回车（只允许 http / https）"
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !active) return;
            const next = toHttpUrl(draft);
            if (next) ws.navigate(active.id, next);
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }}
        />
        {viewerMode && <span className="browserPanel__count">全屏查看中</span>}
      </div>

      {/*
        舞台：**所有**智能体、**所有** tab 的 webview 都挂在这里，只是 CSS 类不同：
          - 卡片视图：当前智能体的页各占一个格子（resting card）；
          - 全屏视图：被打开的那张铺满整个舞台，其余一律 opacity:0 藏起来（照样活着）。
        任何情况下都**不动 display、不卸载、不搬家**。
      */}
      <div
        className={
          viewerMode
            ? 'browserPanel__stage browserPanel__stage--viewer'
            : 'browserPanel__stage browserPanel__stage--cards'
        }
      >
        {ws.tabs.length === 0 && !viewerMode && (
          <div className="browserPanel__empty small">这个智能体还没有打开网页 —— 说一句「打开百度」就会出现在这里。</div>
        )}
        {ws.allTabs.map((t) => {
          const mine = ws.currentAgentId !== null && t.agentId === ws.currentAgentId;
          const isOpened = viewerId === t.id;
          const cls = ['browserCard'];
          if (!mine) cls.push('browserCard--parked');
          else if (viewerMode) cls.push(isOpened ? 'browserCard--opened' : 'browserCard--behind');
          const title = t.title || hostLabel(t.url) || t.bootUrl;
          const driving = ws.drivingIds.includes(t.id);
          return (
            <div key={t.id} className={cls.join(' ')}>
              {/* 卡片头（全屏时变成 viewer 的标题条） */}
              {mine && (
                <div className="browserCard__bar">
                  {driving && (
                    <span className="browserCard__run" title="驾驶员正在这张页上操作">
                      ●
                    </span>
                  )}
                  <span className="browserCard__title" title={t.url}>
                    {title}
                  </span>
                  <button
                    type="button"
                    className="browserCard__x"
                    aria-label="关闭这张页"
                    title="关掉这张页"
                    onClick={() => ws.closeTab(t.id)}
                  >
                    ✕
                  </button>
                </div>
              )}
              <div className="browserCard__body">
                <webview
                  ref={(el) => bindRef(t.id, el as unknown as HTMLElement | null)}
                  className="browserCard__view"
                  src={t.bootUrl}
                  // 第 20 步：分区按**这张页自己的智能体**算 —— 一个智能体一套 cookie / 登录态
                  partition={partitionFor(t.agentId)}
                  // target=_blank 由主进程拦下并让同一个 guest 导航，不会创建 BrowserWindow
                  allowpopups
                />
                {/*
                  第 22 步 · resting 卡片的「承接层」：**整张卡片可点 = 打开全屏**，hover 浮出 Open 药丸。

                  ⚠️ 为什么必须有这一层（实测，不是保险起见）：
                  指针落在 `<webview>` 上时，鼠标事件被 guest 那个进程吞掉，
                  **宿主页面根本收不到，`.browserCard:hover` 永远不成立** ——
                  药丸浮不出来、卡片也点不动（探针多点采样：网页区 hover 张数=0，标题条上=1）。
                  所以卡片视图下用一层透明承接层盖住网页区。

                  代价与边界（都是明确的、可接受的）：
                    - 卡片视图里**不能直接操作网页**（点一下就是"打开全屏"）；
                      这是「resting 卡片 = 预览、viewer = 可操作」的本意；
                    - **完全不影响驾驶**：驾驶走主进程 CDP，输入直接发给 guest，
                      根本不经过这一层；
                    - 全屏（viewer）时**不渲染**这一层，网页可以正常点。
                */}
                {mine && !viewerMode && (
                  <button
                    type="button"
                    className="browserCard__catcher"
                    title="点击全屏查看这张页"
                    onClick={() => openViewer(t.id)}
                  >
                    <span className="browserCard__open">Open ↗</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
