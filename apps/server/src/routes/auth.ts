/**
 * 第 5 步（重做版）的账号接口面。没有邮箱登录、没有 /chat/stream、没有大模型：
 *
 *   POST /auth/sms/send        {phone} → 6 位验证码，5 分钟有效，60 秒防连发；
 *                              开发模式（SMS_MOCK/非 production）把码**只写进服务器日志**，
 *                              响应体里绝不带码；生产没配通道 → 拒绝并说人话。
 *   POST /auth/login/sms       {phone, code} → 验证码登录；未注册手机号自动建号并分配 XYZ 号
 *                              （默认项目 + Agent「小助」同事务创建）。一手机一用户。
 *   POST /auth/login/xyz       {xyz, password} → XYZ号+密码登录；**没设过密码则明确失败**
 *                              （回 code=password_not_set，不是含糊的“密码错误”）。
 *   POST /auth/password/set    （要 JWT）→ 登录后才能设置/修改密码；密码≥8 位，只存 scrypt 哈希。
 *   GET  /auth/me              （要 JWT）→ {user{xyz_id…}, project, agents}
 *   GET  /auth/wechat/status   → {enabled:false}（本步只预留）
 *   POST /auth/wechat/login    → 501 wechat_not_enabled，**不发 JWT**（本步禁真微信）
 *
 * 明文/验证码一律不落库、不打日志；库里短信码只存 sha256(salt$code)，手机号存 HMAC 哈希 + AES 密文。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  AgentSummary,
  AuthProfile,
  AuthSession,
  AuthUser,
  ProjectSummary,
} from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import {
  bearerFrom,
  hashPassword,
  hashCode,
  makeCodeSalt,
  maskPhone,
  phoneHash,
  randomSixDigits,
  signToken,
  verifyCode,
  verifyPassword,
  verifyToken,
} from '../crypto';
import { isDbUnreachable, isUniqueViolation, withTx } from '../db';
import { allocateXyz, normalizeXyz } from '../xyz';

export interface AuthDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

const PHONE_RE = /^1[3-9]\d{9}$/; // 大陆 11 位手机号
const SEND_COOLDOWN_SECONDS = 60; // 同号码 60 秒内不能连发
const PHONE_HOURLY_CAP = 10; // 同号码 1 小时最多 10 条（简单限流）
const CODE_TTL_SQL = "now() + interval '5 minutes'";
const VERIFY_MAX_ATTEMPTS = 5;
const PASSWORD_MIN = 8;

/** 进程内按 IP 的粗限流：每 IP 每分钟最多 20 次发码请求（防脚本乱扫；有网关时可换掉） */
const ipHits = new Map<string, { windowStart: number; count: number }>();
function ipRateLimited(ip: string): boolean {
  const nowMinute = Math.floor(Date.now() / 60_000);
  const hit = ipHits.get(ip);
  if (!hit || hit.windowStart !== nowMinute) {
    ipHits.set(ip, { windowStart: nowMinute, count: 1 });
    return false;
  }
  hit.count += 1;
  if (ipHits.size > 5000) ipHits.clear(); // 粗清理，够用就行
  return hit.count > 20;
}

function dbError(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return reply.code(503).send({
      error: '数据库连不上：先跑 docker compose -f apps/server/docker-compose.yml up -d（或 npm run db:up）',
    });
  }
  const msg = (err as Error)?.message ?? String(err);
  console.error('[auth] 未分类错误：', msg); // 只打 message——里面绝不含密码/验证码
  return reply.code(500).send({ error: `服务端错误：${msg}` });
}

function claimsFrom(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

async function loadUser(pool: Pool, where: 'id' | 'xyz_id' | 'phone_hash', value: string | number) {
  const r = await pool.query<{
    id: string;
    xyz_id: string;
    phone_hash: string | null;
    phone_enc: string | null;
    password_hash: string | null;
  }>(`SELECT id, xyz_id, phone_hash, phone_enc, password_hash FROM users WHERE ${where} = $1`, [value]);
  return r.rowCount === 1 ? r.rows[0] : null;
}

async function buildSession(pool: Pool, env: ServerEnv, cipher: JsonCipher, userId: string): Promise<AuthSession> {
  const p = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
    [userId],
  );
  if (p.rowCount !== 1) throw new Error('账号数据不完整（默认项目缺失）');
  const a = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM agents WHERE project_id = $1 ORDER BY id ASC LIMIT 8',
    [p.rows[0].id],
  );
  const user = await loadUser(pool, 'id', userId);
  if (!user) throw new Error('账号已不存在');
  const session: AuthSession = {
    token: signToken({ sub: Number(user.id), xyz: user.xyz_id }, env.jwtSecret),
    user: {
      id: Number(user.id),
      xyz_id: user.xyz_id,
      has_password: Boolean(user.password_hash),
      phone_masked: user.phone_enc ? maskPhone(cipher.decryptText(user.phone_enc)) : null,
    },
    project: { id: Number(p.rows[0].id), name: p.rows[0].name } satisfies ProjectSummary,
    agents: a.rows.map((r) => ({ id: Number(r.id), name: r.name }) satisfies AgentSummary),
  };
  return session;
}

export function registerAuthRoutes(app: FastifyInstance, { pool, env, cipher }: AuthDeps): void {
  // ---------------------------------------------------------------- 短信
  app.post('/auth/sms/send', async (req: FastifyRequest, reply) => {
    const body = req.body as { phone?: unknown } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (ipRateLimited(req.ip)) {
      // 放在格式校验之前：拿坏号码刷接口同样吃限流
      return reply.code(429).send({ error: '这个 IP 发码太频繁，歇一分钟再来' });
    }
    if (!PHONE_RE.test(phone)) {
      return reply.code(400).send({ error: '需要大陆 11 位手机号（1[3-9] 开头）' });
    }
    if (!env.smsMock && env.isProduction && !env.smsHttpUrl) {
      // 生产没配短信通道：不装死，给人话
      return reply.code(503).send({
        error: '短信通道没配置：开发调试请设 SMS_MOCK=1（验证码进服务器日志），生产请在 .env 配 SMS_HTTP_URL',
      });
    }
    const hash = phoneHash(phone, env.phonePepper);
    try {
      const last = await pool.query<{ age_seconds: string | null }>(
        'SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 1',
        [hash],
      );
      const age = last.rowCount === 1 ? Number(last.rows[0].age_seconds ?? 1e9) : 1e9;
      if (age < SEND_COOLDOWN_SECONDS) {
        return reply.code(429).send({
          error: `发送太频繁，请 ${Math.ceil(SEND_COOLDOWN_SECONDS - age)} 秒后重试`,
        });
      }
      const recent = await pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM sms_codes WHERE phone_hash = $1 AND created_at > now() - interval '1 hour'",
        [hash],
      );
      if (Number(recent.rows[0]?.n ?? 0) >= PHONE_HOURLY_CAP) {
        return reply.code(429).send({ error: '该手机号 1 小时内验证码条数已达上限，请稍后再试' });
      }

      const code = randomSixDigits();
      const salt = makeCodeSalt();
      await pool.query(
        `INSERT INTO sms_codes (phone_hash, code_hash, salt, expires_at) VALUES ($1, $2, $3, ${CODE_TTL_SQL})`,
        [hash, hashCode(code, salt), salt],
      );

      if (env.smsMock) {
        // 开发模式：码只进服务器日志；响应体里没有 code 字段
        console.log(`[sms:mock] → ${maskPhone(phone)} 验证码 ${code}（5 分钟内有效；仅开发模式打印）`);
      } else {
        // 通用 HTTP 短信网关：POST {phone, code}。失败如实报错，不回退成“假装发了”
        try {
          const r = await fetch(env.smsHttpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phone, code }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (err) {
          return reply.code(502).send({ error: `短信通道发送失败：${(err as Error).message}；验证码已作废，请稍后重试` });
        }
      }
      return { sent: true, expires_in: 300 };
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 登录 A：手机号+验证码（未注册自动建号）
  app.post('/auth/login/sms', async (req: FastifyRequest, reply) => {
    const body = req.body as { phone?: unknown; code?: unknown } | null;
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!PHONE_RE.test(phone)) return reply.code(400).send({ error: '手机号格式不对（大陆 11 位）' });
    if (!/^\d{6}$/.test(code)) return reply.code(400).send({ error: '验证码是 6 位数字' });

    const hash = phoneHash(phone, env.phonePepper);
    try {
      // 1) 校验码：只认最新一条未用、未过期、尝试次数没超的
      const c = await pool.query<{ id: string; code_hash: string; salt: string }>(
        `SELECT id, code_hash, salt FROM sms_codes
          WHERE phone_hash = $1 AND used = false AND attempts < $2 AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [hash, VERIFY_MAX_ATTEMPTS],
      );
      if (c.rowCount !== 1 || !verifyCode(code, c.rows[0].salt, c.rows[0].code_hash)) {
        if (c.rowCount === 1) {
          await pool.query('UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1', [c.rows[0].id]);
        }
        return reply.code(401).send({ error: '验证码不对或已失效（错 5 次作废，可重新获取）' });
      }
      await pool.query('UPDATE sms_codes SET used = true WHERE id = $1', [c.rows[0].id]);

      // 2) 老用户直接进；新用户建号（分配 XYZ + 默认项目 + 小助），一个事务
      const existing = await loadUser(pool, 'phone_hash', hash);
      if (existing) return await buildSession(pool, env, cipher, existing.id);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const created = await withTx(pool, async (client) => {
            const xyz = await allocateXyz(async (sql, params) => client.query(sql, params));
            const u = await client.query<{ id: string }>(
              'INSERT INTO users (xyz_id, phone_hash, phone_enc) VALUES ($1, $2, $3) RETURNING id',
              [xyz, hash, cipher.encryptText(phone)],
            );
            const p = await client.query<{ id: string; name: string }>(
              "INSERT INTO projects (user_id, name, is_default) VALUES ($1, '默认项目', true) RETURNING id, name",
              [u.rows[0].id],
            );
            const a = await client.query<{ id: string; name: string }>(
              "INSERT INTO agents (project_id, name, kind) VALUES ($1, '小助', 'assistant') RETURNING id, name",
              [p.rows[0].id],
            );
            return { userId: u.rows[0].id, createdProject: p.rows[0], createdAgent: a.rows[0] };
          });
          return await buildSession(pool, env, cipher, created.userId);
        } catch (err) {
          if (isUniqueViolation(err)) {
            // 可能是并发同手机号（phone_hash 撞了）→ 重查一次直接登进去
            const again = await loadUser(pool, 'phone_hash', hash);
            if (again) return await buildSession(pool, env, cipher, again.id);
            continue; // 或 XYZ 撞号 → 重新分配再试
          }
          throw err;
        }
      }
      return reply.code(500).send({ error: '建号失败（XYZ 号碰撞过多），请重试' });
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 登录 B：XYZ号+密码（没设密码→明确失败）
  app.post('/auth/login/xyz', async (req: FastifyRequest, reply) => {
    const body = req.body as { xyz?: unknown; password?: unknown } | null;
    const xyz = normalizeXyz(typeof body?.xyz === 'string' ? body.xyz : '');
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!xyz) return reply.code(400).send({ error: 'XYZ 号格式不对：XYZ 后跟 5~7 位数字（也支持只输数字）' });
    if (!password) return reply.code(400).send({ error: '需要密码' });
    try {
      const user = await loadUser(pool, 'xyz_id', xyz);
      if (!user) return reply.code(401).send({ error: 'XYZ 号或密码不对' });
      if (!user.password_hash) {
        // 说明书要求：未设密码要**明确失败**，并说清下一步怎么走
        return reply.code(400).send({
          code: 'password_not_set',
          error: '该账号还没设置过密码：先用手机号验证码登录，再到左栏「设置密码」设一个（≥8 位）',
        });
      }
      if (!verifyPassword(password, user.password_hash)) {
        return reply.code(401).send({ error: 'XYZ 号或密码不对' }); // 与“用户不存在”同文案，不泄露存在性
      }
      return await buildSession(pool, env, cipher, user.id);
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 设置/修改密码（必须已登录）
  app.post('/auth/password/set', async (req: FastifyRequest, reply) => {
    const claims = claimsFrom(req, env);
    if (!claims) return reply.code(401).send({ error: '未登录或登录已过期：设置/修改密码需要先登录' });
    const body = req.body as { new_password?: unknown; old_password?: unknown } | null;
    const next = typeof body?.new_password === 'string' ? body.new_password : '';
    const prev = typeof body?.old_password === 'string' ? body.old_password : '';
    if (next.length < PASSWORD_MIN || next.length > 72) {
      return reply.code(400).send({ error: `新密码长度需在 ${PASSWORD_MIN}~72 位之间` });
    }
    try {
      const user = await loadUser(pool, 'id', claims.sub);
      if (!user) return reply.code(401).send({ error: '账号已不存在' });
      if (user.password_hash && !verifyPassword(prev, user.password_hash)) {
        return reply.code(403).send({ error: '原密码不对，未做任何修改' });
      }
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [claims.sub, hashPassword(next)]);
      return { ok: true, message: '密码已更新（服务端只存 scrypt 哈希）' };
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 我是谁（要 JWT）
  app.get('/auth/me', async (req: FastifyRequest, reply) => {
    const claims = claimsFrom(req, env);
    if (!claims) return reply.code(401).send({ error: '未登录或登录已过期（需要 Authorization: Bearer <token>）' });
    try {
      const user = await loadUser(pool, 'id', claims.sub);
      if (!user) return reply.code(401).send({ error: '账号已不存在' });
      const p = await pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
        [user.id],
      );
      const a = p.rowCount === 1
        ? await pool.query<{ id: string; name: string }>(
            'SELECT id, name FROM agents WHERE project_id = $1 ORDER BY id ASC LIMIT 8',
            [p.rows[0].id],
          )
        : { rows: [] };
      const profile: AuthProfile = {
        user: {
          id: Number(user.id),
          xyz_id: user.xyz_id,
          has_password: Boolean(user.password_hash),
          phone_masked: user.phone_enc ? maskPhone(cipher.decryptText(user.phone_enc)) : null,
        } satisfies AuthUser,
        project: p.rowCount === 1 ? { id: Number(p.rows[0].id), name: p.rows[0].name } : { id: 0, name: '（无默认项目）' },
        agents: a.rows.map((r) => ({ id: Number(r.id), name: r.name })),
      };
      return profile;
    } catch (err) {
      return dbError(reply, err);
    }
  });

  // ------------------------------------------------- 微信：本步只预留占位，绝不发 JWT
  app.get('/auth/wechat/status', async () => ({ enabled: false }));

  app.post('/auth/wechat/login', async (_req: FastifyRequest, reply) => {
    return reply.code(501).send({
      code: 'wechat_not_enabled',
      error: '微信登录「即将开通」：本步只预留了 wechat_openid / wechat_unionid 字段，未接入真实微信，不发放任何 token',
    });
  });
}
