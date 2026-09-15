import { forwardRef } from 'react';

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

interface BrowserCardProps {
  url: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * 聊天里的浏览器卡片。
 *
 * 关键点：
 *   - 里面是**真的 <webview>**，不是截图、不是 iframe 占位；
 *   - 卡片头部只有「展开 / 收起」一个按钮，不新开窗口、不做多标签；
 *   - 收起时 webview 仍然挂载（只是高度按 16:10 收着），不重新加载网页；
 *   - 页面永远 pointer-events:auto：用户在里面点击/打字都算操作网页，不算发聊天。
 */
export const BrowserCard = forwardRef<HTMLElement, BrowserCardProps>(function BrowserCard(
  { url, expanded, onToggle },
  ref,
) {
  return (
    <div className={expanded ? 'browserCard browserCard--expanded' : 'browserCard'}>
      <div className="browserCard__bar">
        <span className="browserCard__url" title={url}>
          {url}
        </span>
        <button type="button" className="browserCard__btn" onClick={onToggle}>
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      <div className="browserCard__stage">
        <webview
          ref={ref as never}
          className="browserCard__view"
          src={url}
          partition="persist:workbench-browser"
          // target=_blank 由主进程拦下并让同一个 guest 导航，不会创建 BrowserWindow
          allowpopups
        />
      </div>
    </div>
  );
});
