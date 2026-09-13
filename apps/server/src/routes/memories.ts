/**
 * 第 10 步：用户档案记忆 ——「记住这个人」。所有智能体共用同一 owner 的记忆，
 * **挂 owner_id，不按项目隔离**（memories 老表的 project_id 列保留但主逻辑不用）。
 *
 * 规矩（说明书钉死）：
 *   - preference：抽取后直接加密入库 status=active，不弹窗；
 *   - decision：status=pending，用户在确认卡上「确认」后才 active；「不用，忘掉这条」→ rejected；
 *   - fact：只在“会改变以后行为”（needs_confirm=true）时进 pending；否则整条丢弃；active 的 fact
 *     默认不注入，仅当本轮用户原话/任务目标命中其分词才追加；
 *   - pending 一律不注入；未确认永不影响行为；
 *   - 写入前必过敏感闸（密码/验证码/证件/卡号/账号/邮箱/Cookie 等原文一律丢弃该条）；
 *   - 语义去重用「规范化句子精确匹配」（不上向量库）；
 *   - 结束才抽取：任务 done/failed（服务端自触发）、聊天闲置 15 分钟（定时扫）、桌面「结束」按钮；
 *     同一会话/任务 10 分钟内不重复抽。
 *
 * 注入接口：buildMemoryBlock(pool, cipher, ownerId, userText) —— chat.ts 与 agent.ts 各调一次，
 * 拼在系统提示词尾部；两条冲突以更晚为准（写进块里）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { MemoryExtractResult, MemoryItem, MemoryListResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';

export interface MemoryDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/** 抽取提示词：只放服务端。输出契约 = 一个 JSON。 */
const EXTRACT_PROMPT = [
  '你是工作台的“记忆保管员”。从下面的对话/任务记录里，只抽取会改变你今后对该用户行为的记忆。',
  '只输出一个 JSON：{"items":[{"type":"preference|fact|decision","content":"一句话中文","needs_confirm":true或false}]}，没有值得记的就输出 {"items":[]}',
  '铁律：',
  '1. 没有「以后 / 每次 / 默认 / 都 / 别再问我」这类长期信号的，都是一次性指令，不要输出。',
  '2. 「这次用红色就行」这类临时要求、情绪发泄、执行耗时抱怨，一律不要输出。',
  '3. 密码、验证码、身份证号、银行卡号、Cookie、第三方账号的口令：永远不要出现在 content 里（该条直接不输出）。',
  '4. 「以后用当前已登录的浏览器账号」可以记成 decision，但 content 禁止写出账号、邮箱、密码的具体值。',
  '5. type=preference 时 needs_confirm 必须 false；type=decision 时必须 true；fact 仅当会改变以后行为才输出（needs_confirm true），否则不要输出它。',
  '6. 一次最多 5 条。content 一句话中文（30 字内最佳），不要解释、不要引号。',
].join('\n');

/** 写入前的敏感闸（模型已经收过一道，这里再兜一层；命中即丢弃该条） */
const SENSITIVE_MEM_RE =
  /(密码|口令|passw|验证\s*码|校验\s*码|captcha|\botp\b|动[态态].{0,2}(码|令)|身份证|银行\s*卡|信用\s*卡|卡号|\bcvv\b|\bcvc\b|cookie|token|令牌|\bsecret\b)/i;
const LONG_DIGITS_RE = /\d{11,}/;

/**
 * R4 补：账号/邮箱类“具体值”闸（说明书点名：content 里禁止出现账号、邮箱原文）。
 * 只认“带值”的写法——像「以后用当前已登录的浏览器账号」这种不带值的决定必须放行。
 */
const SENSITIVE_ACCOUNT_RE = new RegExp(
  [
    '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', // 邮箱地址形态
    '(?:账号|帐号|用户名|邮箱|手机号|email|account)\\s*(?:[:：=是为]\\s*)?[A-Za-z0-9][\\w.\\-@]{2,}', // 账号：abc123 / 邮箱是 a@b.com
    '(?:账号|帐号|用户名|邮箱|手机号)\\s*[:：=]\\s*[\\w\\u4e00-\\u9fa5]{2,}', // 账号：小明
  ].join('|'),
  'i',
);

/** 三闸合一：敏感关键词 + 账号/邮箱类具体值 + 长数字串（写入前与注入前都走这一支） */
function memSensitive(s: string): boolean {
  return SENSITIVE_MEM_RE.test(s) || SENSITIVE_ACCOUNT_RE.test(s) || LONG_DIGITS_RE.test(s);
}

function normalizeText(s: string): string {
  return String(s).toLowerCase().replace(/[\s，。、,.;；:：!！?？~～"'“”‘’()（）【】\-—_+·]/g, '');
}

function wordHits(text: string, fact: string): boolean {
  const hay = normalizeText(text);
  if (!hay) return false;
  const whole = normalizeText(fact);
  if (whole && (hay.includes(whole) || whole.includes(hay))) return true;
  const words = fact
    .split(/[\s,，、;；.。/|]+/)
    .map((w) => normalizeText(w))
    .filter((w) => w.length >= 2);
  for (const w of words) {
    if (w.length <= 3) {
      if (hay.includes(w)) return true;
      continue;
    }
    // 中文没有空格分词：对 4 字滑窗做“明显实体词”包含匹配（说明书要求的简单规则，不上向量库）
    for (let i = 0; i + 4 <= w.length; i += 1) {
      if (hay.includes(w.slice(i, i + 4))) return true;
    }
  }
  return false;
}

/** 同会话/同任务 10 分钟内不重复抽（进程内即可：重启后重复抽也会被“句子去重”挡住，不会重复入库） */
const DEDUP_MS = 10 * 60_000;
const lastExtractAt = new Map<string, number>();
const MAX_ITEMS = 5;
const CONTENT_MAX = 120;

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[memories] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

function extractJsonLoose(text: string): unknown {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 注入块：active preference+decision 全带上；active fact 仅命中才带 */
export async function buildMemoryBlock(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  userText: string,
): Promise<string> {
  try {
    const core = await pool.query<{ type: string; content_encrypted: string | null }>(
      "SELECT type, content_encrypted FROM memories WHERE owner_id = $1 AND status = 'active' AND type IN ('preference', 'decision') AND content_encrypted IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 20",
      [ownerId],
    );
    const lines: string[] = [];
    const label = (t: string): string => (t === 'preference' ? '偏好' : t === 'decision' ? '决定' : '事实');
    for (const r of core.rows) {
      let text = '';
      try {
        text = cipher.decryptText(String(r.content_encrypted));
      } catch {
        continue; // DATA_KEY 换过之类的脏行：跳过，不炸聊天
      }
      if (memSensitive(text)) continue; // 注入前也过闸（含账号/邮箱类），双保险
      lines.push(`- [${label(r.type)}] ${text}`);
    }
    if (lines.length > 0) lines.push('若两条冲突，以更晚的为准。');
    const facts = await pool.query<{ content_encrypted: string }>(
      "SELECT content_encrypted FROM memories WHERE owner_id = $1 AND status = 'active' AND type = 'fact' AND content_encrypted IS NOT NULL ORDER BY updated_at DESC LIMIT 10",
      [ownerId],
    );
    for (const f of facts.rows) {
      let text = '';
      try {
        text = cipher.decryptText(String(f.content_encrypted));
      } catch {
        continue;
      }
      if (memSensitive(text)) continue; // 注入前也过一遍闸（含账号/邮箱类）
      if (wordHits(userText, text)) lines.push(`- [事实·本轮相关] ${text}`);
    }
    if (lines.length === 0) return '';
    return `【用户档案记忆（该用户此前定下的，按规矩执行）】\n${lines.join('\n')}`;
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[memories] 注入块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

interface CoreOutcome {
  extracted: number;
  pending: MemoryItem[];
  skipped?: string;
}

/** 真正干活的抽取。source: 'chat_end' | 'chat_idle' | 'task_end' */
async function extractCore(
  deps: MemoryDeps,
  ownerId: number,
  source: string,
  transcript: string,
  dedupKey: string,
): Promise<CoreOutcome> {
  const { pool, env, cipher } = deps;
  const now = Date.now();
  const last = lastExtractAt.get(dedupKey) ?? 0;
  if (now - last < DEDUP_MS) return { extracted: 0, pending: [], skipped: 'dedup_10min' };
  lastExtractAt.set(dedupKey, now);
  if (lastExtractAt.size > 500) {
    const oldestKey = lastExtractAt.keys().next().value;
    if (oldestKey !== undefined) lastExtractAt.delete(oldestKey);
  }
  if (!transcript.trim()) return { extracted: 0, pending: [], skipped: 'empty_transcript' };
  if (!env.deepseekApiKey) return { extracted: 0, pending: [], skipped: 'llm_not_configured' };
  const empty: CoreOutcome = { extracted: 0, pending: [] };
  let raw: { items?: unknown };
  try {
    const r = await fetch(`${env.deepseekBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.deepseekApiKey}` },
      body: JSON.stringify({
        model: env.deepseekModel,
        stream: false,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: `记录如下：\n${transcript.slice(-6000)}` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return { ...empty, skipped: `upstream_http_${r.status}` };
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = extractJsonLoose(data.choices?.[0]?.message?.content ?? '');
    if (!parsed || typeof parsed !== 'object') return { ...empty, skipped: 'bad_model_json' };
    raw = parsed as { items?: unknown };
  } catch (err) {
    return { ...empty, skipped: `model_unreachable:${(err as Error).message.slice(0, 60)}` };
  }
  const list = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
  if (list.length === 0) return { ...empty, skipped: 'nothing_worth_remembering' };

  // 去重基线：owner 全部 pending/active/rejected 的规范化句子
  const exist = await pool.query<{ mem_key: string }>(
    "SELECT mem_key FROM memories WHERE owner_id = $1 AND status IN ('pending', 'active', 'rejected')",
    [ownerId],
  );
  const seen = new Set(exist.rows.map((r) => r.mem_key));
  const p = await pool.query<{ id: string }>(
    'SELECT id FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
    [ownerId],
  );
  // memories.project_id 是老表的 NOT NULL 外键（兼容保留）：没有默认项目就明确跳过，不撞约束
  if (p.rowCount !== 1) return { extracted: 0, pending: [], skipped: 'no_project' };
  const projectId = Number(p.rows[0].id);

  let inserted = 0;
  const pending: MemoryItem[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const type = String(o.type ?? '');
    if (!['preference', 'decision', 'fact'].includes(type)) continue;
    const content = typeof o.content === 'string' ? o.content.trim().slice(0, CONTENT_MAX) : '';
    if (content.length < 2) continue;
    // 说明书钉死：preference 永不需确认；decision 必确认；fact 不需确认就丢
    const needs = type === 'preference' ? false : type === 'decision' ? true : Boolean(o.needs_confirm);
    if (type === 'fact' && !needs) continue;
    // 写入前敏感闸（含长数字串=证件/卡号形态）
    if (memSensitive(content)) {
      console.warn('[memories] 一条疑似敏感内容在写入前被丢弃（不落库、不入卡）');
      continue;
    }
    const key = normalizeText(content);
    if (seen.has(key)) continue; // 已有/已拒，不再插也不弹卡
    seen.add(key);
    const status = needs ? 'pending' : 'active';
    const enc = cipher.encryptText(content);
    await pool.query(
      'INSERT INTO memories (project_id, agent_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES ($1, NULL, $2, $3, $4, $5, $3, $6, $7, $8)',
      [projectId, key, enc, ownerId, type, source, status, needs],
    );
    inserted += 1;
    if (needs) {
      const idq = await pool.query<{ id: string }>(
        'SELECT id FROM memories WHERE owner_id = $1 AND mem_key = $2 ORDER BY id DESC LIMIT 1',
        [ownerId, key],
      );
      if (idq.rowCount === 1) {
        pending.push({
          id: Number(idq.rows[0].id),
          type: type as MemoryItem['type'],
          content,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
  return { extracted: inserted, pending };
}

/** 任务 done/failed 时由 agent 路由调用（fire-and-forget，失败只静默） */
export function triggerTaskExtract(deps: MemoryDeps, ownerId: number, taskId: number, payload: unknown): void {
  setImmediate(() => {
    void (async () => {
      const pl = (payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string } };
      const transcript = [
        `任务目标：${pl.goal ?? ''}`,
        '步骤：',
        ...(pl.steps ?? []).map((x, i) => `${i + 1}. ${x}`),
        pl.doc?.summary ? `结论：${pl.doc.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await extractCore(deps, ownerId, 'task_end', transcript, `task:${taskId}`);
    })().catch((err) => console.warn('[memories] 任务收尾提取失败（忽略）：', (err as Error).message));
  });
}

/** 闲置 15 分钟自动提取：每分钟扫一轮（进程内记“处理到哪个消息号”，同一切点不重抽） */
export function startIdleScheduler(deps: MemoryDeps, intervalMs = 60_000): NodeJS.Timeout {
  const done = new Set<string>();
  const timer = setInterval(() => {
    void (async () => {
      const { pool } = deps;
      const r = await pool.query<{ conv_id: string; user_id: string; last_id: string | null; last_at: string | null }>(
        'SELECT c.id AS conv_id, p.user_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at FROM conversations c JOIN projects p ON p.id = c.project_id LEFT JOIN messages m ON m.conversation_id = c.id GROUP BY c.id, p.user_id',
      );
      const now = Date.now();
      for (const row of r.rows) {
        if (!row.last_id || !row.last_at) continue;
        const ago = now - new Date(row.last_at).getTime();
        if (ago < 15 * 60_000 || ago > 60 * 60_000) continue; // 15 分钟~1 小时窗口
        const key = `c${row.conv_id}:${row.last_id}`;
        if (done.has(key)) continue;
        done.add(key);
        if (done.size > 800) done.clear();
        const msgs = await pool.query<{ role: string; content_enc: string }>(
          'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
          [Number(row.conv_id)],
        );
        const transcript = msgs.rows
          .reverse()
          .map((x) => {
            let text = '';
            try {
              text = deps.cipher.decryptText(x.content_enc);
            } catch {
              return '';
            }
            return `${x.role === 'user' ? '用户' : '小助'}：${text}`;
          })
          .filter(Boolean)
          .join('\n');
        await extractCore(deps, Number(row.user_id), 'chat_idle', transcript, `conv:${row.conv_id}:idle`);
      }
    })().catch((err) => {
      if (!isDbUnreachable(err)) console.warn('[memories] 闲置扫描跳过：', (err as Error).message);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** 会话记录取数（桌面「结束」按钮用）：只取该用户自己的会话 */
async function conversationTranscript(deps: MemoryDeps, ownerId: number, conversationId: number): Promise<string | null> {
  const own = await deps.pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
    [conversationId, ownerId],
  );
  if (own.rowCount !== 1) return null;
  const msgs = await deps.pool.query<{ role: string; content_enc: string }>(
    'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
    [conversationId],
  );
  return msgs.rows
    .reverse()
    .map((x) => {
      let text = '';
      try {
        text = deps.cipher.decryptText(x.content_enc);
      } catch {
        return '';
      }
      return `${x.role === 'user' ? '用户' : '小助'}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryDeps): void {
  const { pool, env, cipher } = deps;

  // 桌面「结束」按钮：手动触发一次提取（同一会话 10 分钟内不重复）
  app.post('/memories/extract', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { conversationId?: unknown } | null;
    const convId = Number(b?.conversationId);
    if (!Number.isInteger(convId) || convId <= 0) return errJson(reply, 400, 'conversationId 必填（先聊过一次）');
    try {
      const transcript = await conversationTranscript(deps, claims.sub, convId);
      if (transcript === null) return errJson(reply, 404, '会话不存在或不是你的');
      const out = await extractCore(deps, claims.sub, 'chat_end', transcript, `conv:${convId}`);
      return out satisfies MemoryExtractResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 「我的记忆」列表：active 直接列；pending 单独给确认卡用
  app.get('/memories', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const q = async (status: string) => {
        const r = await pool.query<{ id: string; type: string; content_encrypted: string | null; updated_at: Date | string }>(
          "SELECT id, type, content_encrypted, updated_at FROM memories WHERE owner_id = $1 AND status = $2 AND content_encrypted IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 50",
          [claims.sub, status],
        );
        const out: MemoryItem[] = [];
        for (const row of r.rows) {
          let text = '';
          try {
            text = cipher.decryptText(String(row.content_encrypted));
          } catch {
            continue;
          }
          out.push({
            id: Number(row.id),
            type: (row.type === 'decision' || row.type === 'fact' ? row.type : 'preference') as MemoryItem['type'],
            content: text,
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
          });
        }
        return out;
      };
      const result: MemoryListResult = { active: await q('active'), pending: await q('pending') };
      return result;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 确认卡：整卡确认 / 整卡忘掉（also 支持逐条 ids）
  const decide = (target: 'active' | 'rejected') => async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { all?: unknown; ids?: unknown } | null;
    try {
      if (b?.all === true) {
        await pool.query(
          'UPDATE memories SET status = $2, updated_at = now() WHERE owner_id = $1 AND status = $3',
          [claims.sub, target, 'pending'],
        );
        return { ok: true, target };
      }
      const ids = Array.isArray(b?.ids) ? (b.ids as unknown[]).map(Number).filter(Number.isInteger).slice(0, 10) : [];
      if (ids.length === 0) return errJson(reply, 400, 'all 或 ids 至少给一个');
      for (const id of ids) {
        await pool.query(
          'UPDATE memories SET status = $2, updated_at = now() WHERE id = $3 AND owner_id = $1 AND status = $4',
          [claims.sub, target, id, 'pending'],
        );
      }
      return { ok: true, changed: ids.length, target };
    } catch (err) {
      return dbErr(reply, err);
    }
  };
  app.post('/memories/confirm', decide('active'));
  app.post('/memories/reject', decide('rejected'));

  // 忘掉这条：archived，立即从注入源消失（不提供编辑，按说明书）
  app.post('/memories/forget', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = Number((req.body as { id?: unknown } | null)?.id);
    if (!Number.isInteger(id)) return errJson(reply, 400, 'id 必填');
    try {
      const r = await pool.query(
        "UPDATE memories SET status = 'archived', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'active'",
        [id, claims.sub],
      );
      if (r.rowCount !== 1) return errJson(reply, 404, '这条记忆不存在、不是你的，或已不是生效状态');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
