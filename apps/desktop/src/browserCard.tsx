import { useEffect, useState } from 'react';

/**
 * 第 13 步「聊天内浏览器卡片」：
 *   - 用户发**明确的开网页指令**（打开百度 / 打开抖音 / 打开 https://… / 打开浏览器）时，
 *     中栏聊天里直接插一张卡片，卡片里是**真实 <webview>**（partition=persist:workbench-browser）：
 *     能点、能在页面输入框里打字。没有第二窗口、没有截图冒充。
 *   - 纯闲聊 / 问知识库 / 问「你是谁」：这里一律返回 null，不弹卡片、不加载网页。
 *
 * 识别刻意保守：**先要有开网页的动词，再要能解析出具体目标**（已登记站点 / 裸域名 / 显式 URL）。
 * 只提到关键词（「浏览器一般有几个进程」）不会命中；问句（怎么/如何/吗）也不命中。
 */

/** 「打开浏览器」「打开网页」这种没指定站点的指令，落在默认主页 */
export const HOME_URL = 'https://www.baidu.com';

/** 登记站点：名字 → 首页。匹配先全等、再前缀（「打开百度搜天气」也能落在百度） */
const SITES: Array<[string, string]> = [
  ['baidu', 'https://www.baidu.com'],
  ['百度', 'https://www.baidu.com'],
  ['douyin', 'https://www.douyin.com'],
  ['抖音', 'https://www.douyin.com'],
  // 第 16 步：补上「油管」这类口语站点名——验收里就有一条「改口打开油管」，
  // 名字不在表里的话 detectOpenUrl 会返回 null，卡片开不出来，看着像「改口没生效」。
  ['youtube', 'https://www.youtube.com'],
  ['油管', 'https://www.youtube.com'],
  ['youku', 'https://www.youku.com'],
  ['优酷', 'https://www.youku.com'],
  ['抖店', 'https://fxg.jinritemai.com'],
  ['jinritemai', 'https://fxg.jinritemai.com'],
  ['toutiao', 'https://www.toutiao.com'],
  ['头条', 'https://www.toutiao.com'],
  ['kuaishou', 'https://www.kuaishou.com'],
  ['快手', 'https://www.kuaishou.com'],
  ['xiaohongshu', 'https://www.xiaohongshu.com'],
  ['小红书', 'https://www.xiaohongshu.com'],
  ['weibo', 'https://weibo.com'],
  ['微博', 'https://weibo.com'],
  ['zhihu', 'https://www.zhihu.com'],
  ['知乎', 'https://www.zhihu.com'],
  ['bilibili', 'https://www.bilibili.com'],
  ['b站', 'https://www.bilibili.com'],
  ['哔哩哔哩', 'https://www.bilibili.com'],
  ['taobao', 'https://www.taobao.com'],
  ['淘宝', 'https://www.taobao.com'],
  ['tmall', 'https://www.tmall.com'],
  ['天猫', 'https://www.tmall.com'],
  ['jingdong', 'https://www.jd.com'],
  ['jd', 'https://www.jd.com'],
  ['京东', 'https://www.jd.com'],
  ['pinduoduo', 'https://mobile.yangkeduo.com'],
  ['pdd', 'https://mobile.yangkeduo.com'],
  ['拼多多', 'https://mobile.yangkeduo.com'],
  ['meituan', 'https://www.meituan.com'],
  ['美团', 'https://www.meituan.com'],
  ['eleme', 'https://www.ele.me'],
  ['饿了么', 'https://www.ele.me'],
  ['ctrip', 'https://www.ctrip.com'],
  ['携程', 'https://www.ctrip.com'],
  ['12306', 'https://www.12306.cn'],
  ['qq', 'https://www.qq.com'],
  ['腾讯', 'https://www.qq.com'],
  ['wangyi', 'https://www.163.com'],
  ['163', 'https://www.163.com'],
  ['网易', 'https://www.163.com'],
  ['sina', 'https://www.sina.com.cn'],
  ['新浪', 'https://www.sina.com.cn'],
  ['github', 'https://github.com'],
  ['google', 'https://www.google.com'],
  ['谷歌', 'https://www.google.com'],
  ['必应', 'https://www.bing.com'],
  ['bing', 'https://www.bing.com'],
  ['douban', 'https://www.douban.com'],
  ['豆瓣', 'https://www.douban.com'],
  ['juejin', 'https://juejin.cn'],
  ['掘金', 'https://juejin.cn'],
  ['csdn', 'https://www.csdn.net'],
  ['stackoverflow', 'https://stackoverflow.com'],
  ['weixin', 'https://wx.qq.com'],
  ['微信', 'https://wx.qq.com'],
  ['example.com', 'https://example.com'],
];

/** 没指定站点时的说法 */
const GENERIC = /^(浏览器|网页|网址|浏览器窗口|网页版|一个网页|下网页|个网页)$/;

/** 开网页动词。长的排前面，避免「去一下」被单个「去」截断 */
const VERB = /(打开|開啟|开启|启动|啟動|訪問|访问|浏览|瀏覽|去一下|去个|去個|上个|上一下|进一下|看一下|看下|去|上|进|open|go\s*to|load)/i;

/** 站点名后面常见的零碎后缀，去掉再匹配 */
const TAIL = /(首页|首頁|官网|官網|网站|網站|网页|網頁|看看|一下|瞅瞅|瞧瞧|看看|吧|呢|啊)$/;

const BARE_DOMAIN = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** 问句不开网页（「怎么打开百度」是提问不是指令） */
function looksLikeQuestion(t: string): boolean {
  return /^(怎么|如何|为什么|為什麽|怎样|怎樣|啥|什么|試試|是不是|能不能|可以)/.test(t) || /吗|嗎|？|\?/.test(t);
}

/**
 * 从一句用户原话里解析出要打开的网页地址；不是开网页指令就返回 null。
 * 只做**字符串**判断，不联网、不猜、不拿模型兜底——猜错就会乱开网页。
 */
export function detectOpenUrl(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t || t.length > 200 || looksLikeQuestion(t)) return null;

  // 1) 显式 URL：带开网页动词，或整句基本就是这个地址
  const m = t.match(/https?:\/\/[^\s，,。；;！!？?）)】"'「」]+/i);
  if (m) {
    const verb = VERB.test(t);
    // 整句就是个地址（允许首尾几个零碎字符）时，不必强求动词
    if (verb || m[0].length >= t.length - 3) return m[0];
  }

  // 2) 动词 + 目标
  const vm = VERB.exec(t);
  if (!vm) return null;

  // 先剥动词后的零碎量词（「打开一下淘宝」→「淘宝」），再反复剥后缀
  let site = t
    .slice(vm.index + vm[0].length)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(一下|一|个|下|個)+/, '');
  // 反复剥后缀（「打开百度首页看看」→「百度」）
  for (let i = 0; i < 3; i += 1) {
    const next = site.replace(TAIL, '');
    if (next === site) break;
    site = next;
  }
  if (!site) return HOME_URL; // 「打开浏览器」这类：落到默认主页
  if (GENERIC.test(site)) return HOME_URL;

  const lower = site.toLowerCase();
  // 全等优先
  const exact = SITES.find(([name]) => name === lower || name === site);
  if (exact) return exact[1];
  // 裸域名（含 www.baidu.com / example.com）
  if (BARE_DOMAIN.test(lower)) return `https://${lower}`;
  // 前缀：「打开百度搜天气」也算要开百度
  const prefixed = SITES.find(([name]) => name.length >= 2 && lower.startsWith(name.toLowerCase()));
  if (prefixed) return prefixed[1];
  return null;
}

/**
 * 第 16 步缺项修复：**已有网页卡片**时，「普通浏览指令」判定。
 *
 * 背景：以前只有「明确开页指令」和「对确认提问回继续」才发车驾驶员循环，
 * 于是「在这个页面搜一下 AI」这种句子只会得到一句口头「稍等」，网页一动不动。
 *
 * 这里只做**字符串**判断（不联网、不问模型），命中表示：
 *   用户要驾驶员去动**当前这张已经开着的页面**，而不是要开新站点、也不是闲聊。
 *
 * 刻意保守：必须有明确的「对页面动手」动词才命中；纯闲聊（你好 / 谢谢 / 你是谁）一律不命中。
 * 没有网页卡片时调用方也不会用它发车（不开第二张卡）。
 */
const BROWSE_ACT =
  /(搜一下|搜一搜|搜搜|搜索|搜个|搜\s|查一下|查一查|查查|查询|查找|读一下|读一读|读读|读页|读当前页|读这页|看一下这|看下这|看看这|看一下当前|往下滚|向下滚|往上滚|向上滚|滚一下|滚到底|滚动|翻页|下一页|上一页|刷新|重载|返回上一页|后退|点一下|点下|点击|点开|选中|勾选|填一下|帮我搜|帮我查|帮我点|帮我读|帮我翻|在这个页面|在当前页面|在当前这张|在这张页面|搜索框|输入框)/;

/** 明显是在提问、而不是下指令（比 detectOpenUrl 的判据更严：句中含疑问词也算） */
function looksLikeAsking(t: string): boolean {
  return (
    /^(怎么|如何|为什么|為什麽|怎样|怎樣|啥|什么|是不是|能不能|可以|要不要|该不该)/.test(t) ||
    /(是什么|什么意思|怎么办|怎么样|为什么|如何|吗？|吗\?|吗$|？|\?)/.test(t)
  );
}

/**
 * 从一句用户原话里解析出「要驾驶员在当前页面做的动作」。
 * 不是普通浏览指令就返回 null（调用方此时按纯聊天处理，不发车）。
 */
export function detectBrowseIntent(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t || t.length > 120) return null;
  if (looksLikeQuestion(t) || looksLikeAsking(t)) return null;
  if (!BROWSE_ACT.test(t)) return null;
  return t;
}

// ---------------------------------------------------------------------------
// 第 17 步：中栏「浏览器区」（顶栏 tab + URL 栏 + 页）
//
// 硬约束（本步钉死）：
//   - 仍是 Electron 的 <webview>，**不套 Edge / Chrome / CEF，不用 Playwright**；
//   - 同一时刻最多 MAX_LIVE_PAGES 张**活着的** <webview>（都是 partition=persist:workbench-browser）；
//   - 切 tab = 把对应那张 webview 放到最前面（z-index），**不为每个 tab 开 BrowserWindow**；
//   - 收起不是把页面藏没：舞台仍留一块高度（webview 尺寸为 0 会让驾驶点不中任何元素）。
// ---------------------------------------------------------------------------

/**
 * 同时真正加载、智能体能点的活页上限（第 17 步修订：2 → 10）。
 *
 * 一张活页 = 一套真实 Chromium 渲染进程，所以这是个**资源硬顶**，不是推荐值。
 * 第 3 张起不再顶掉别的页，一直到第 MAX_LIVE_PAGES 张；第 MAX_LIVE_PAGES + 1 张才顶掉
 * 「最旧且没在跑」的那一张（两张以上都在跑就排队）。
 *
 * ⚠️ 主进程 `apps/desktop/electron/main.ts` 里有一个同值的 `MAX_LANES` 兜底
 * （渲染层算错了也不会真跑出第 11 路），**改这里必须同时改那里**。
 */
export const MAX_LIVE_PAGES = 10;

/** 一张活页在前端的样子 */
export interface BrowserTabView {
  id: number;
  /** 初次加载的地址：**建好之后不再变**（React 反复改 src 会让 webview 重新加载） */
  bootUrl: string;
  /** 当前地址（跟着页面自己走，只用于 URL 栏显示） */
  url: string;
  /** 标签文字：优先页面标题，拿不到就用域名 */
  title: string;
}

/** 取主机名（用于标签兜底显示、以及判断「是不是同一个站」） */
export function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || url;
  }
}

/**
 * 是不是同一个站（同一主机）。
 * 用途：用户对同一个站点再说一次「打开百度搜天气」时**复用**那张页并改道，
 * 而不是又开一张——这也让第 16 步「最新指令优先」在同站场景下自然成立。
 */
export function sameSite(a: string, b: string): boolean {
  const h = (u: string): string => {
    try {
      return new URL(u).host.toLowerCase();
    } catch {
      return '';
    }
  };
  const ha = h(a);
  const hb = h(b);
  return Boolean(ha) && ha === hb;
}

/** 只允许 http(s)：其它协议（bytedance: / snssdk / market: …）不进导航，也不弹系统框 */
export function toHttpUrl(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  return /^https?:\/\//i.test(withScheme) ? withScheme : null;
}

interface BrowserPanelProps {
  tabs: BrowserTabView[];
  activeId: number | null;
  expanded: boolean;
  /** 正在被驾驶员操作的那几张（tabId）——标签上点一个小圆点，一眼看出哪两张在跑 */
  drivingIds: number[];
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNewTab: () => void;
  onToggle: () => void;
  onNavigate: (id: number, url: string) => void;
  registerRef: (id: number, el: HTMLElement | null) => void;
  /** 页面自己改了地址/标题（点链接、SPA 跳转）时回报，用来更新标签与 URL 栏 */
  onPageInfo: (id: number, info: { url?: string; title?: string }) => void;
}

/**
 * 中栏浏览器区。它挂在窗口级（不在某一条聊天消息里）——
 * 这样切智能体去聊别的时，正在跑的两路驾驶不会因为 webview 被卸载而断掉。
 */
export function BrowserPanel({
  tabs,
  activeId,
  expanded,
  drivingIds,
  onActivate,
  onClose,
  onNewTab,
  onToggle,
  onNavigate,
  registerRef,
  onPageInfo,
}: BrowserPanelProps) {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  /** URL 栏的草稿：用户正在编辑时不跟页面走，免得打字打到一半被覆盖 */
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return;
    setDraft(active?.url ?? '');
  }, [active?.url, active?.id, editing]);

  /**
   * 给 webview 挂「页面自己动了」的监听（React 不会告诉我们这些）：
   * 点站内链接、SPA 路由跳转、标题变化都要反映到标签和 URL 栏上。
   * 元素卸载时把监听摘掉（用元素上的私有字段记住卸载函数）。
   */
  const bindRef = (id: number, el: HTMLElement | null): void => {
    registerRef(id, el);
    if (!el) return;
    const anyEl = el as HTMLElement & { __wbOff?: () => void };
    anyEl.__wbOff?.();
    const onTitle = (e: Event): void => {
      const title = String((e as Event & { title?: string }).title ?? '');
      if (title) onPageInfo(id, { title });
    };
    const onNav = (e: Event): void => {
      const url = String((e as Event & { url?: string }).url ?? '');
      if (url) onPageInfo(id, { url });
    };
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    anyEl.__wbOff = () => {
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
    };
  };

  return (
    <div className={expanded ? 'browserPanel browserPanel--expanded' : 'browserPanel'}>
      {/* 顶栏：一张页一个 tab（最多 MAX_LIVE_PAGES 个）+ 「＋」+ 展开/收起 */}
      <div className="browserPanel__tabs" role="tablist" aria-label="打开的网页">
        {tabs.map((t) => (
          <div key={t.id} className={t.id === active?.id ? 'browserTab browserTab--on' : 'browserTab'}>
            <button
              type="button"
              role="tab"
              aria-selected={t.id === active?.id}
              className="browserTab__label"
              title={t.url}
              onClick={() => onActivate(t.id)}
            >
              {drivingIds.includes(t.id) && <span className="browserTab__run" title="驾驶员正在这张页上操作">●</span>}
              {t.title || hostLabel(t.url) || t.bootUrl}
            </button>
            <button type="button" className="browserTab__x" aria-label="关闭这张页" onClick={() => onClose(t.id)}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="browserTab__add" title={`新开一张（最多 ${MAX_LIVE_PAGES} 张同时活着）`} onClick={onNewTab}>
          ＋
        </button>
        <button type="button" className="browserPanel__toggle" onClick={onToggle}>
          {expanded ? '收起' : '展开'}
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
            if (next) onNavigate(active.id, next);
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="browserPanel__count">{tabs.length}/{MAX_LIVE_PAGES} 张活页</span>
      </div>

      {/*
        舞台：**所有** tab 的 webview 都挂在这里（绝对定位铺满，只靠 z-index 分层）。
        为什么要都挂着：第 17 步要求「两张页都能动」——被切到后面的那张必须仍然活着、
        仍然有真实尺寸，否则驾驶在它上面点不中任何元素（rect 会变成 0）。
      */}
      <div className="browserPanel__stage">
        {tabs.length === 0 && <div className="browserPanel__empty small">还没有打开网页</div>}
        {tabs.map((t) => (
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
