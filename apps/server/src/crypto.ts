/**
 * 密码哈希 / 字段加密 / 验证码哈希 / JWT —— 全部走 node 内置 crypto + jsonwebtoken：
 *
 * - 密码：scrypt（N=2^14, r=8, p, 64B），存 `scrypt$N$r$p$salt$hash`；校验 timingSafeEqual。
 *   **绝不落库明文、绝不打日志**（本项目连错误日志都不带 password 字段）。
 * - 手机号：查询/唯一索引用 `phone_hash = HMAC-SHA256(pepper, phone)`（一手机一用户靠它），
 *   展示用密文列 `phone_enc`（AES-256-GCM）。pepper 只来自环境变量。
 * - 短信验证码：库里**只存哈希** `sha256(salt + code)`，salt 每行随机；比对走 timingSafeEqual。
 * - 敏感字段（messages.content / memories 的值）：AES-256-GCM，密钥只来自 DATA_KEY
 *   （64 位 hex 直用，否则 SHA-256 派生 32B）；无默认密钥兜底。
 * - JWT：HS256，7 天；密钥只来自 JWT_SECRET。
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const SCRYPT = { N: 2 ** 14, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const expected = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(password, Buffer.from(parts[4], 'base64'), expected.length, {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
    });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

/** 验证码哈希：sha256(salt$code)；6 位码空间小，必须带每行随机 salt */
export function makeCodeSalt(): string {
  return crypto.randomBytes(12).toString('base64');
}
export function hashCode(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}$${code}`, 'utf8').digest('hex');
}
export function verifyCode(code: string, salt: string, expectedHash: string): boolean {
  try {
    const got = Buffer.from(hashCode(code, salt), 'utf8');
    const want = Buffer.from(expectedHash, 'utf8');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
/** 6 位数字验证码（前导零保留） */
export function randomSixDigits(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function phoneHash(phone: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(phone, 'utf8').digest('hex');
}

export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '****';
}

function aesKeyFrom(dataKey: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(dataKey)) return Buffer.from(dataKey, 'hex');
  return crypto.createHash('sha256').update(dataKey, 'utf8').digest();
}

export interface JsonCipher {
  encryptJson(value: unknown): string;
  decryptJson<T>(payload: string): T;
  encryptText(value: string): string;
  decryptText(payload: string): string;
}

/** 密文格式：`gcm$iv_b64$tag_b64$payload_b64`（GCM 自带完整性，改一个字符就解不开） */
export function makeCipher(dataKey: string): JsonCipher {
  const key = aesKeyFrom(dataKey);
  const seal = (buf: Buffer): string => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return ['gcm', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('$');
  };
  const open = (payload: string): Buffer => {
    const [tag, ivB64, tagB64, ctB64] = payload.split('$');
    if (tag !== 'gcm' || !ivB64 || !tagB64 || !ctB64) throw new Error('密文格式不认识：期望 gcm$iv$tag$ct');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]);
  };
  return {
    encryptJson(value: unknown): string {
      return seal(Buffer.from(JSON.stringify(value), 'utf8'));
    },
    decryptJson<T>(payload: string): T {
      return JSON.parse(open(payload).toString('utf8')) as T;
    },
    encryptText(value: string): string {
      return seal(Buffer.from(value, 'utf8'));
    },
    decryptText(payload: string): string {
      return open(payload).toString('utf8');
    },
  };
}

export interface TokenClaims {
  sub: number;
  xyz: string;
}

export function signToken(claims: TokenClaims, secret: string): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: '7d' });
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
      return { sub: Number((decoded as { sub: unknown }).sub), xyz: String((decoded as { xyz?: unknown }).xyz ?? '') };
    }
    return null;
  } catch {
    return null;
  }
}

/** 从 Authorization 头取 Bearer token（就一个正则，不装插件） */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
