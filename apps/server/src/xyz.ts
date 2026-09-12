/**
 * XYZ 对外账号的分配：XYZ + 数字，默认 5 位（XYZ10000–XYZ99999）。
 * - 用户不能自选，只能由这里生成；
 * - 随机撞了（users.xyz_id UNIQUE）就重随；每长度试 300 次；
 * - 5 位用尽 → 6 位 → 7 位；再满就报错（真有 900 万注册用户再说）。
 */
import crypto from 'node:crypto';

export interface ExistsProbe {
  (sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

const LENGTHS = [5, 6, 7] as const;
const TRIES_PER_LENGTH = 300;

export async function allocateXyz(exists: ExistsProbe): Promise<string> {
  for (const digits of LENGTHS) {
    const lo = 10 ** (digits - 1);
    const hi = 10 ** digits; // randomInt 上界开区间 → [lo, hi-1]
    for (let i = 0; i < TRIES_PER_LENGTH; i += 1) {
      const candidate = `XYZ${crypto.randomInt(lo, hi)}`;
      const r = await exists('SELECT 1 FROM users WHERE xyz_id = $1', [candidate]);
      if ((r.rowCount ?? 0) === 0) return candidate;
    }
  }
  throw new Error('XYZ 号段分配失败：5~7 位都已用尽，请扩容位数后重试');
}

/** 用户输入归一化：大小写随意、允许只输数字；必须最终长成 XYZ+5~7位数字 */
export function normalizeXyz(raw: string): string | null {
  const t = (raw || '').trim().toUpperCase();
  const full = /^\d+$/.test(t) ? `XYZ${t}` : t;
  return /^XYZ\d{5,7}$/.test(full) ? full : null;
}
