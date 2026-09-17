/**
 * 第 20 步 · 浏览器模块：地址、分区、页数提示的**纯函数**（不碰 React、不碰 Electron）。
 *
 * 「协议拦截」的桌面侧那一半就在这个文件里：
 *   - 渲染层只认 http / https；其余协议（bytedance: / snssdk / market: / itms-apps: …）
 *     一律**不进导航**；
 *   - 主进程 electron/main.ts 里还有一道权威闸（setWindowOpenHandler / will-navigate /
 *     will-redirect / will-frame-navigate），两边都拦是为了「双保险」；
 *   - 目的：点抖音那类「打开 App」按钮时不弹 Windows 的「获取打开此链接的应用」系统框。
 *
 * 第 20 步在这个文件里改了两件事：
 *   1. **取消活页硬顶**（原来的 `MAX_LIVE_PAGES = 10` 已删）：开多少张都行，也不再
 *      「第 11 张顶掉最旧」。页数偏多只在 UI 上提示一句「开太多会卡」——**绝不偷偷关页**，
 *      卡顿是本步明确接受的已知代价。
 *   2. 分区按智能体隔离（第 20 步当时的口径）。
 *
 * **Phase 3 改的是「隔离粒度」这一层**：分区从「按智能体」改成**「按项目」** ——
 * 同项目的多个智能体共用一套登录态，不同项目之间照旧完全隔离。
 * 标签页归属 / 任务执行状态 / 暂停继续**不跟着改**，仍然按智能体隔离（见 useBrowserWorkspace）。
 */

/**
 * 页数超过这个数就在 UI 上提示一句「开太多会卡」。
 *
 * ⚠️ **这不是上限**：第 20 步起没有活页上限，超过多少张都照开，绝不顶掉/关掉任何一张。
 * 它只决定「什么时候开始提醒你」，别把它当成 MAX_LIVE_PAGES 用回来。
 */
export const SOFT_TAB_HINT = 10;

/** 分区名前缀。落盘目录名不带 `persist:`（Electron 会剥掉），主进程侧按同一套规则反解。 */
export const PROJECT_PARTITION_PREFIX = 'persist:workbench-browser-project-';

/** 认不出项目时用的兜底分区：**单独一桶，绝不跟任何一个真项目混**（宁可登出，不可串号）。 */
export const ORPHAN_PARTITION = `${PROJECT_PARTITION_PREFIX}none`;

/**
 * **Phase 3：一个项目 = 一套浏览器登录态**（cookie / localStorage / session）。
 *
 * 同一项目下的多个智能体共用这一个分区 —— 所以在项目里让 A 登录某网站，
 * 切到同项目的 B 打开同一个网站就是登录状态，不用再登一次。
 * **不同项目之间仍然完全隔离**（分区名不同 = session 不同 = 数据不同）。
 *
 * ⚠️ 这一层**只管登录态**。标签页归属、任务执行状态、暂停/继续，
 *    全部照旧**按 agentId 隔离**（见 useBrowserWorkspace 的桶键、BrowserTabView.agentId），
 *    绝不因为分区合并了就把标签页也合并 —— 那两件事在代码里是分开的。
 *
 * Electron 会把 `persist:` 分区落到 `<userData>/Partitions/<分区名>/`，
 * 不需要额外搬家。
 *
 * ⚠️ 名字一旦定下就**不要再改**：改了等于把每个项目下已登录的站点全部登出。
 * ⚠️ 主进程 electron/main.ts 里用同一套命名规则反解（见那边的 `PROJECT_PARTITION_RE`），
 *    主进程 import 不到渲染层代码，所以那边是同规则的第二份，**改这里要同时改那里**。
 */
export function partitionFor(projectId: number | null | undefined): string {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return ORPHAN_PARTITION;
  return `${PROJECT_PARTITION_PREFIX}${id}`;
}

/** 反解分区名里的项目 id；不是「某项目的浏览器分区」就返回 null（含兜底分区 `-none`） */
export function projectIdFromPartition(partition: string): number | null {
  const m = /^persist:workbench-browser-project-(\d+)$/.exec(partition ?? '');
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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
 *
 * 第 20 步：复用只在**同一个智能体自己的那些页**里找（见 useBrowserWorkspace），
 * 绝不去复用别的智能体的页。
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
