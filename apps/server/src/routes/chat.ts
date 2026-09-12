/**
 * 第 6 步：DeepSeek 流式聊天（只做嘴，不做手）。
 *
 *   POST /chat/stream   要 JWT。body {conversationId?, message}。
 *                       SSE（text/event-stream）逐 delta 推给桌面：
 *                         event: meta  data: {"conversationId":N}          ← 第一条，带会话号
 *                         data: {"delta":"字"}                              ← 打字机
 *                         event: done  data: {"messageId":N,...}            ← 助手全文已落库
 *                         event: error data: {"error":"人话"}              ← 中断/失败：绝不把半截写库当成功
 *                       没配 DEEPSEEK_API_KEY：请求**开始前**就 503 {code:"llm_not_configured"}，
 *                       不发伪回复。
 *   GET  /chat/history  要 JWT。?conversationId= 可省（默认取你最近一条会话）；
 *                       返回解密后的历史，供桌面刷新后还原。只认自己的会话。
 *
 * 落库：用户句先写（role=user）；助手全文完成才写（role=assistant）；都是 AES-256-GCM 密文列。
 * 禁止项：不动 XYZ 号、不加第二套聊天表、不在 messages 里出现验证码/JWT/API Key、
 *         不指挥浏览器（系统提示词写死了）——那是第 7 步的事。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ChatHistoryResult, ChatRow } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';

export interface ChatDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/** 系统提示词：只放服务端，绝不进前端。逐字按第 6 步说明。 */
const SYSTEM_PROMPT = [
  '你是「小助」，用户桌面工作台里唯一的 AI 同事。说话短、像同事，不要官腔。',
  '你现在只能聊天和帮用户把需求说清楚。',
  '当用户的需求必须打开网页才能完成时，不要假装已经打开了网页，只回答：',
  '「这需要用工作台浏览器，确认后我开始操作。」',
  '（本步不要真的开始操作浏览器。）',
  '不要向用户索要任何网站密码。需要登录时，让用户自己在工作台浏览器里登录。',
  '不要编造你没有查到的数据和链接。',
  '不要输出 JSON 动作，不要输出 function call。',
].join('\n');

const HISTORY_WINDOW = 24; // 拼给模型的历史条数（含本轮前的最近 24 条）
const MESSAGE_MAX = 2000; // 单条用户输入上限
const UPSTREAM_TIMEOUT_MS = 180_000; // 一次模型请求最长 3 分钟

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  const msg = (err as Error)?.message ?? String(err);
  console.error('[chat] 未分类错误：', msg); // 只打 message；调用方保证 message 里不含密钥
  return errJson(reply, 500, `服务端错误：${msg}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 把任意历史行解密成人话文本；密文坏了（比如换过 DATA_KEY）不炸，给占位 */
function safeDecrypt(cipher: JsonCipher, enc: string): string {
  try {
    return cipher.decryptText(enc);
  } catch {
    return '（这条记录解密失败：DATA_KEY 可能换过）';
  }
}

/** 找/建当前用户默认项目 + 「小助」下的一条会话。owner 校验全走 projects.user_id，别人的会话号直接当不存在。 */
async function resolveConversation(
  pool: Pool,
  userId: number,
  conversationId: number | null,
  seedTitle: string,
): Promise<{ id: number } | { err: string; status: number }> {
  if (conversationId !== null) {
    const own = await pool.query<{ id: string }>(
      'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
      [conversationId, userId],
    );
    if (own.rowCount !== 1) return { err: '会话不存在或不是你的', status: 404 };
    return { id: Number(own.rows[0].id) };
  }
  const latest = await pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE p.user_id = $1 AND p.is_default = true ORDER BY c.id DESC LIMIT 1',
    [userId],
  );
  if (latest.rowCount === 1) return { id: Number(latest.rows[0].id) };
  const p = await pool.query<{ id: string }>(
    'SELECT id FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
    [userId],
  );
  if (p.rowCount !== 1) return { err: '当前账号还没有默认项目（请重新登录一次让建号流程补上）', status: 500 };
  const a = await pool.query<{ id: string }>(
    "SELECT id FROM agents WHERE project_id = $1 AND kind = 'assistant' ORDER BY id ASC LIMIT 1",
    [p.rows[0].id],
  );
  const ins = await pool.query<{ id: string }>(
    'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
    [p.rows[0].id, a.rowCount === 1 ? a.rows[0].id : null, seedTitle.slice(0, 24) || '小助会话'],
  );
  return { id: Number(ins.rows[0].id) };
}

/** 转发上游 SSE 时只回给桌面这三类事件；这里统一走 JSON.stringify 防换行截断 */
function sse(res: { write(c: string): unknown }, ev: string | null, data: unknown): void {
  res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

export function registerChatRoutes(app: FastifyInstance, { pool, env, cipher }: ChatDeps): void {
  // ------------------------------------------------------------------ 聊天流
  app.post('/chat/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（聊天需要第 5 步的 JWT）');

    const body = req.body as { conversationId?: unknown; message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return errJson(reply, 400, 'message 不能为空');
    if (message.length > MESSAGE_MAX) return errJson(reply, 400, `单条消息最长 ${MESSAGE_MAX} 字`);
    let conversationId: number | null = null;
    if (body?.conversationId !== undefined && body?.conversationId !== null && body?.conversationId !== '') {
      const n = Number(body.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数（或干脆不传）');
      conversationId = n;
    }

    if (!env.deepseekApiKey) {
      // 明确拒绝，绝不用假回复冒充模型
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 dev:server', {
        code: 'llm_not_configured',
      });
    }

    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, message);
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const convId = conv.id;

      // 1) 先读历史（不含本句），再落用户消息
      const hist = await pool.query<{ role: string; content_enc: string }>(
        'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2',
        [convId, HISTORY_WINDOW],
      );
      const history = hist.rows
        .reverse()
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .map((r) => ({ role: r.role as 'user' | 'assistant', content: safeDecrypt(cipher, r.content_enc) }));
      const um = await pool.query<{ id: string }>(
        "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'user', $2) RETURNING id",
        [convId, cipher.encryptText(message)],
      );
      const userMessageId = Number(um.rows[0].id);

      // 2) 调 DeepSeek（OpenAI 兼容 chat/completions，stream:true）。失败/无流 → 普通 JSON 错误，不开 SSE
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await fetch(`${env.deepseekBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.deepseekApiKey}` },
          body: JSON.stringify({
            model: env.deepseekModel,
            stream: true,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: message }],
          }),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(deadline);
        return errJson(reply, 502, `模型服务连不上：${(err as Error).message}（检查 DEEPSEEK_BASE_URL / 网络）`);
      }
      if (!upstream.ok || !upstream.body) {
        clearTimeout(deadline);
        const brief = (await upstream.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
        console.error('[chat] 上游 HTTP', upstream.status, brief); // 上游 body 不含我们的 key；也只截 200 字
        return errJson(reply, 502, `模型服务返回 HTTP ${upstream.status}：${brief || '（无详情）'}`);
      }

      // 3) 劫持连接改手写 SSE（hijack 绕过 fastify 的缓冲；CORS 头手动补上）
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': req.headers.origin ?? '*',
      });
      sse(res, 'meta', { conversationId: convId, userMessageId });

      const onClose = (): void => ac.abort(); // 桌面关了窗口/按停：上游掐掉，半截不落库
      req.raw.on('close', onClose);

      let full = '';
      let upstreamDone = false;
      try {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE 一帧以空行分隔；末尾不完整的半帧留在 buf 里等下一包
          const parts = buf.split(/\r?\n\r?\n/);
          buf = parts.pop() ?? '';
          for (const block of parts) {
            const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (payload === '[DONE]') {
              upstreamDone = true;
              continue;
            }
            try {
              const json = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
                error?: { message?: string };
              };
              if (json.error?.message) throw new Error(json.error.message);
              const delta = json.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                full += delta;
                sse(res, null, { delta });
              }
            } catch (e) {
              throw new Error(`上游 SSE 帧解析失败：${(e as Error).message}`);
            }
          }
          if (upstreamDone) break;
        }
        if (!upstreamDone) {
          // 流没见 [DONE] 就断了（超时掐线/上游半路关）：不给成功，也不落库
          throw new Error('上游在 [DONE] 前结束，回复只有半截');
        }
      } catch (err) {
        clearTimeout(deadline);
        req.raw.removeListener('close', onClose);
        const rawMsg = (err as Error).message || '未知错误';
        const msg = /abort/i.test(rawMsg)
          ? '已取消（客户端断开或超时）；这条没写入历史'
          : `模型连接中断：${rawMsg}；回复未完成，没有存入历史`;
        try {
          sse(res, 'error', { error: msg });
          res.end();
        } catch {
          /* 客户端早走了 */
        }
        return;
      }

      // 4) 助手全文完成才落库；再回 done
      try {
        const am = await pool.query<{ id: string }>(
          "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'assistant', $2) RETURNING id",
          [convId, cipher.encryptText(full)],
        );
        sse(res, 'done', { conversationId: convId, messageId: Number(am.rows[0].id), contentLength: full.length });
      } catch (err) {
        sse(res, 'error', { error: `回复完成但入库失败：${(err as Error).message}` });
      } finally {
        clearTimeout(deadline);
        req.raw.removeListener('close', onClose);
        res.end();
      }
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------------------------ 历史
  app.get('/chat/history', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（历史需要第 5 步的 JWT）');
    const q = req.query as { conversationId?: unknown } | null;
    let conversationId: number | null = null;
    if (q?.conversationId !== undefined && q?.conversationId !== '') {
      const n = Number(q.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数');
      conversationId = n;
    }
    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, '');
      if ('err' in conv) {
        // 历史接口对「一条会话都没有」宽容返回空，其余错误照报
        if (conversationId === null) {
          const empty: ChatHistoryResult = { conversationId: null, messages: [] };
          return empty;
        }
        return errJson(reply, conv.status, conv.err);
      }
      const rows = await pool.query<{ id: string; role: string; content_enc: string; created_at: string }>(
        'SELECT id, role, content_enc, created_at FROM messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT 200',
        [conv.id],
      );
      const out: ChatHistoryResult = {
        conversationId: conv.id,
        messages: rows.rows.map((r) => ({
          id: Number(r.id),
          role: r.role === 'assistant' ? 'assistant' : 'user',
          text: safeDecrypt(cipher, r.content_enc),
          created_at: r.created_at,
        })) satisfies ChatRow[],
      };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
