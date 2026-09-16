/**
 * 第 18 步 · 浏览器模块：地址与上限的**纯函数**（不碰 React、不碰 Electron）。
 *
 * 「协议拦截」的桌面侧那一半就在这个文件里：
 *   - 渲染层只认 http / https；其余协议（bytedance: / snssdk / market: / itms-apps: …）
 *     一律**不进导航**；
 *   - 主进程 electron/main.ts 里还有一道权威闸（setWindowOpenHandler / will-navigate /
 *     will-redirect / will-frame-navigate），两边都拦是为了「双保险」；
 *   - 目的：点抖音那类「打开 App」按钮时不弹 Windows 的「获取打开此链接的应用」系统框。
 */

/**
 * 同时真正加载、智能体能点的活页上限。
 *
 * 一张活页 = 一套真实 Chromium 渲染进程，所以这是**资源硬顶**，不是推荐值。
 * 第 MAX_LIVE_PAGES + 1 张才会顶掉「最旧且没在跑」的那一张（都在跑则排队）。
 *
 * ⚠️ 主进程 `apps/desktop/electron/main.ts` 里有一个同值的 `MAX_LANES` 兜底
 * （渲染层算错了也不会真跑出第 11 路），**改这里必须同时改那里**。
 */
export const MAX_LIVE_PAGES = 10;

/** 只允许 http(s)：其它协议不进导航，也不弹系统框 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url ?? '');
}

/** 把用户输入补成 http(s) 地址；补不出来（自定义协议等）返回 null */
export function toHttpUrl(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  return isHttpUrl(withScheme) ? withScheme : null;
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
