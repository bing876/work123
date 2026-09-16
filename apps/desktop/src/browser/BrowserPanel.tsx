import { useEffect, useState } from 'react';
import { MAX_LIVE_PAGES, isHttpUrl } from './url';
import { toHttpUrl } from './url';
import type { BrowserWorkspace } from './useBrowserWorkspace';
import { hostLabel } from './url';
import './styles.css';

/**
 * 第 18 步 · 浏览器模块：中栏那块**钉住的工作区**（顶栏 tab + URL 栏 + 舞台）。
 *
 * 它是 .middle（纵向 flex）的兄弟节点、不在 .chat 的滚动区里 ——
 * 所以「滚聊天不会把浏览器滚没」，切智能体也不会把它卸载掉
 * （正在跑的那几路驾驶因此不会断）。
 *
 * 舞台里**所有** tab 的 <webview> 都挂着（绝对定位铺满，只靠 z-index 分层）：
 * 被切到后面的那张必须仍然活着、仍然有真实尺寸，否则驾驶在它上面点不中任何元素。
 */

/** 元素上挂的私有字段：卸载时用来摘掉监听 */
type WebviewEl = HTMLElement & { __wbOff?: () => void };

export function BrowserPanel({ ws }: { ws: BrowserWorkspace }) {
  const active = ws.active;
  /** URL 栏的草稿：用户正在编辑时不跟页面走，免得打字打到一半被覆盖 */
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return;
    setDraft(active?.url ?? '');
  }, [active?.url, active?.id, editing]);

  /**
   * 给 webview 挂监听（React 不会告诉我们这些）：
   *   1. 点站内链接、SPA 路由跳转、标题变化 → 反映到标签和 URL 栏上；
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

  return (
    <div className={ws.expanded ? 'browserPanel browserPanel--expanded' : 'browserPanel'}>
      {/* 顶栏：一张页一个 tab（最多 MAX_LIVE_PAGES 个）+ 「＋」+ 展开/收起 */}
      <div className="browserPanel__tabs" role="tablist" aria-label="打开的网页">
        {ws.tabs.map((t) => (
          <div key={t.id} className={t.id === active?.id ? 'browserTab browserTab--on' : 'browserTab'}>
            <button
              type="button"
              role="tab"
              aria-selected={t.id === active?.id}
              className="browserTab__label"
              title={t.url}
              onClick={() => ws.activate(t.id)}
            >
              {ws.drivingIds.includes(t.id) && (
                <span className="browserTab__run" title="驾驶员正在这张页上操作">
                  ●
                </span>
              )}
              {t.title || hostLabel(t.url) || t.bootUrl}
            </button>
            <button type="button" className="browserTab__x" aria-label="关闭这张页" onClick={() => ws.closeTab(t.id)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browserTab__add"
          title={`新开一张（最多 ${MAX_LIVE_PAGES} 张同时活着）`}
          onClick={() => ws.openNewTab()}
        >
          ＋
        </button>
        <button type="button" className="browserPanel__toggle" onClick={() => ws.toggleExpanded()}>
          {ws.expanded ? '收起' : '展开'}
        </button>
      </div>

      {/* URL 栏：跟着当前 tab 走；改了回车即导航（只允许 http/https） */}
      <div className="browserPanel__urlbar">
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
        <span className="browserPanel__count">
          {ws.tabs.length}/{MAX_LIVE_PAGES} 张活页
        </span>
      </div>

      {/* 舞台：所有 tab 的 webview 都挂在这里，只靠 z-index 分层 */}
      <div className="browserPanel__stage">
        {ws.tabs.length === 0 && <div className="browserPanel__empty small">还没有打开网页</div>}
        {ws.tabs.map((t) => (
          <webview
            key={t.id}
            ref={(el) => bindRef(t.id, el as unknown as HTMLElement | null)}
            className={t.id === active?.id ? 'browserPanel__view browserPanel__view--on' : 'browserPanel__view'}
            src={t.bootUrl}
            partition="persist:workbench-browser"
            // target=_blank 由主进程拦下并让同一个 guest 导航，不会创建 BrowserWindow
            allowpopups
          />
        ))}
      </div>
    </div>
  );
}
