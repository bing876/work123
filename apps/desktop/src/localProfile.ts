/**
 * 第 14 步：本机账号资料 + 「这台电脑记住的账号」。
 *
 * 边界（写死，别越界）：
 * - **只存本机 localStorage**，一行服务端代码都不动、不加表不加迁移；
 *   这里也绝不写密码 / 验证码 / JWT —— 那些只在登录流程里存在。
 * - 头像用本地选图，读成**小尺寸 dataURL**（canvas 压到最长边 160px 的 JPEG）再存本机，
 *   所以仓库里不会出现任何图片文件，也不会把用户照片塞进数据库。
 * - 「使用时长」= 这台电脑上该账号的累计前台毫秒数（见 App.tsx 里的 15 秒一跳）；
 *   「学习分数」只是时长换算出来的一个整数，**不是打分模型、不记录任何行为**。
 */

/** 资料表：{ [xyz]: LocalProfile } —— 一个号一条，互不串味 */
const STORE_KEY = 'workbench.localProfiles.v1';
/** 「这台电脑记住的账号」：只存 XYZ 号本身 */
const REMEMBER_KEY = 'workbench.rememberedXyz.v1';

export interface LocalProfile {
  /** 对外号，就是键本身 */
  xyz: string;
  /** 名称（可改；XYZ 号只展示，不从这里改） */
  displayName: string;
  /** 简介（可改） */
  bio: string;
  /** 本机选的头像（小尺寸 dataURL）；空串 = 用首字占位 */
  avatar: string;
  /** 第一次在这台电脑上登录的时间戳（ms） */
  firstSeenAt: number;
  /** 在这台电脑上累计使用的毫秒数 */
  usedMs: number;
}

export const DEFAULT_NAME = '未命名用户';
export const DEFAULT_BIO = '还没有写简介';

/** 头像压缩后的最长边（px）——够看清，又不至于把 localStorage 撑爆 */
const AVATAR_MAX = 160;

function readAll(): Record<string, LocalProfile> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, LocalProfile>;
  } catch {
    // 本地存储坏了不该拦住登录：当没有资料处理，后续写入会覆盖成好的
    return {};
  }
}

function writeAll(all: Record<string, LocalProfile>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // 配额满 / 隐私模式：静默降级，卡片退回默认值，不影响登录和工作台
  }
}

/** 读某个号的资料；没有就现造一条默认的（不落盘，等真改了再写） */
export function loadLocalProfile(xyz: string): LocalProfile {
  const hit = readAll()[xyz];
  if (hit && typeof hit === 'object') {
    return {
      xyz,
      displayName: typeof hit.displayName === 'string' && hit.displayName ? hit.displayName : DEFAULT_NAME,
      bio: typeof hit.bio === 'string' ? hit.bio : '',
      avatar: typeof hit.avatar === 'string' ? hit.avatar : '',
      firstSeenAt: Number(hit.firstSeenAt) || Date.now(),
      usedMs: Math.max(0, Number(hit.usedMs) || 0),
    };
  }
  return { xyz, displayName: DEFAULT_NAME, bio: '', avatar: '', firstSeenAt: Date.now(), usedMs: 0 };
}

/**
 * 局部更新：**先读再合并**，避免用一份旧快照把并发的时长累加覆盖掉
 * （卡片改名字和 App 的时长累计是两条独立的写入路径）。
 */
export function updateLocalProfile(xyz: string, patch: Partial<Omit<LocalProfile, 'xyz'>>): LocalProfile {
  const all = readAll();
  const next: LocalProfile = { ...loadLocalProfile(xyz), ...patch, xyz };
  all[xyz] = next;
  writeAll(all);
  return next;
}

/** 时长累加：返回累加后的总毫秒（App 的定时器每跳调一次） */
export function addUsage(xyz: string, deltaMs: number): number {
  const delta = Math.floor(deltaMs);
  if (!xyz || !Number.isFinite(delta) || delta <= 0) return loadLocalProfile(xyz).usedMs;
  const cur = loadLocalProfile(xyz);
  const usedMs = cur.usedMs + delta;
  updateLocalProfile(xyz, { usedMs });
  return usedMs;
}

// ---- 「这台电脑记住的账号」 --------------------------------------------------

export function rememberAccount(xyz: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, xyz);
  } catch {
    /* 存不上就退化成「每次都走验证码」，不拦路 */
  }
}

export function rememberedAccount(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY) || null;
  } catch {
    return null;
  }
}

/** 退出登录 / 切换账号时调用：清掉标记，下次打开回到验证码登录 */
export function forgetAccount(): void {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* ignore */
  }
}

// ---- 展示换算 ---------------------------------------------------------------

/** 学习分数：每 5 分钟记 1 分，纯整数；默认 0，不是打分模型 */
export function usageScore(usedMs: number): number {
  return Math.floor(Math.max(0, usedMs) / 60_000 / 5);
}

/** 使用时长的人话形态：不到 1 分钟显示秒，方便一眼看出「真的在涨」 */
export function formatDuration(usedMs: number): string {
  const s = Math.max(0, Math.floor(usedMs / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

/** 没设头像时的占位字：名称首字（中文取第一个字，英文取首字母） */
export function initialOf(name: string): string {
  const t = name.trim();
  if (!t) return '助';
  return Array.from(t)[0] ?? '助';
}

/**
 * 本地选图 → 小尺寸 dataURL。
 * 不写文件、不上传、不进仓库：只在内存里缩好，交给调用方存进 localStorage。
 */
export async function avatarDataUrl(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type || 'image/png' });
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, AVATAR_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('本机读不了这张图（canvas 2d 不可用）');
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    bmp.close?.();
  }
}
