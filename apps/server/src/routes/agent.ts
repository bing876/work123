/**
 * 第 7 步：云端驾驶员的**单步**接口（第 21 步起只是兼容壳）+ 任务记账。
 *
 *   POST /agent/next-action  要 JWT。{taskId?, goal, stepsSummary[], snapshot, paused?}
 *     → 第 21 步：**引擎、工具表、提示词全部复用 toolLoop.ts**（同一份 LOOP_SYSTEM_PROMPT、
 *       同一份 LOOP_TOOLS、同一套参数校验），这里只把「模型选的工具」翻成桌面能执行的
 *       BrowserAction 返回。**不再是第二套话术**——桌面现在走 /agent/loop/*，
 *       这个接口留着是为了不把老路径打断，行为与新循环一致。
 *   POST /agent/task/start  {goal} → tasks 表记一条 running（payload.steps=[]），返回 {taskId}
 *   POST /agent/task/step   {taskId, summary, ok} → 追加一步“人话摘要”（绝不存整页 HTML/快照）
 *   POST /agent/task/status {taskId, status} → running/paused/done/failed
 *   GET  /agent/task/current → 我最近一条任务（桌面刷新后还原任务卡用）
 *
 * 循环本体（消息历史 + 步数上限）在服务端 toolLoop.ts；执行在桌面主进程（现有 driver）。
 * 用户暂停时本地先停手，这里是第二道闸。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentActionRequest, AgentActionResponse, PageSnapshot } from '@ai-workbench/shared';
import type { BrowserAction } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { llmFetch } from '../llm';
import { notifyUser } from '../notify';
import { buildMemoryBlock, triggerTaskExtract } from './memories';
import { decideOnce } from '../toolLoop';
import { currentProjectId } from '../projectScope';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
  /** 第 8 步：done 的结果文档要加密进 tasks.result_enc（复用第 5 步 AES-256-GCM） */
  cipher: JsonCipher;
}

/** 第 8 步「任务结束整理」提示词（只在服务端；编造是红线） */
const WRAP_PROMPT = [
  '你是工作台的“任务收尾员”。根据任务目标、步骤摘要和最后看到的页面要点，把已完成任务整理成结果。',
  '只输出一个 JSON：{"summary":"给聊天窗口的短结论（可扫读，不要过程流水账）","document_title":"文档标题","document_markdown":"完整 Markdown：## 目标 / ## 结论 / ## 要点列表 / ## 来源 / ## 没做成的事","unread_hint":"红点旁极短提示，例如：调研结果已生成"}',
  '不要编造没在输入里出现过的数字和原文；找不到就写「未找到」。',
  'document_markdown 里禁止出现手机号、验证码、密码、token、API Key。',
  '来源网址只能引用输入里出现过的 url。',
].join('\n')

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[agent] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 从模型回复里抠第一个 JSON 对象（容忍 ``` 围栏和前后废话）——第 8 步收尾整理在用 */
function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 任务归属校验：tasks JOIN projects，只认自己的 */
async function ownTask(pool: Pool, taskId: number, userId: number) {
  const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean; result_enc: string | null }>(
    'SELECT t.id, t.status, t.title, t.payload, t.unread, t.result_enc FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.user_id = $2',
    [taskId, userId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/** 第 8 步：兜底文档——没配 Key 或模型乱答时，用已落库字段拼一份**不编造**的 Markdown */
function buildFallbackDoc(goal: string, steps: string[], done: Record<string, unknown>): { summary: string; title: string; markdown: string; hint: string } {
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const summary = str(done.summary, '任务已完成（细节见文档）');
  const title = str(done.document_title, '任务记录');
  const outline = Array.isArray(done.document_outline) ? (done.document_outline as unknown[]).map(String).slice(0, 12) : [];
  const lines = [
    `# ${title}`,
    '',
    '## 目标',
    goal || '未找到',
    '',
    '## 结论',
    summary,
    '',
    '## 要点',
    ...(outline.length ? outline.map((x) => `- ${x}`) : ['- 未找到（模型未配置或未能整理，以下为原始步骤）']),
    '',
    '## 步骤摘要',
    ...(steps.length ? steps.map((x) => `- ${x}`) : ['- 未找到']),
    '',
    '> 本文档由任务记录字段兜底生成（第 8 步）；未接入模型整理，也未编造任何页面数据。',
  ];
  return { summary, title, markdown: lines.join('\n'), hint: '任务结果已生成' };
}

export function registerAgentRoutes(app: FastifyInstance, { pool, env, cipher }: AgentDeps): void {
  // ------------------------------------------------- 第 21 步：兼容壳（同一引擎）
  /**
   * 老的单步接口。**不再自己写提示词、也不再自己解析 JSON 动作** ——
   * 直接调 toolLoop.decideOnce（同一份 LOOP_SYSTEM_PROMPT + 同一份 LOOP_TOOLS +
   * 同一套参数校验），把模型选的工具翻成一个 BrowserAction 返回。
   *
   * 桌面现在走 /agent/loop/*，这里留着是为了不把老路径打断；两边行为一致，
   * 所以不存在「两套互斥话术」。
   */
  app.post('/agent/next-action', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（驾驶员接口需要第 5 步的 JWT）');
    if (!env.deepseekApiKey) {
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server', {
        code: 'llm_not_configured',
      });
    }
    const body = req.body as AgentActionRequest | null;
    const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空（先告诉我要完成什么）');
    const snapshot = body?.snapshot;
    if (!snapshot || typeof snapshot.url !== 'string') return errJson(reply, 400, 'snapshot 需要 read_page 的当前页快照');
    const steps = Array.isArray(body?.stepsSummary) ? body.stepsSummary.filter((x) => typeof x === 'string').slice(-12) : [];
    const paused = Boolean(body?.paused);

    try {
      // 第 10 步：驾驶员同样吃“已确认记忆”（pending 不会出现在这里——只查 active）
      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, goal);
      const out = await decideOnce(env, {
        goal,
        stepsSummary: steps,
        snapshot,
        paused,
        memoryBlock: memBlock,
      });
      return { action: out.action, note: out.note } satisfies AgentActionResponse;
    } catch (err) {
      const msg =
        (err as Error)?.name === 'TimeoutError'
          ? '模型响应超时（90s），本轮没执行任何动作'
          : `模型服务连不上：${(err as Error).message}`;
      return errJson(reply, 502, msg);
    }
  });

  // ---------------------------------------------------------------- 任务记账
  app.post('/agent/task/start', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const goal = typeof (req.body as { goal?: unknown } | null)?.goal === 'string' ? String((req.body as { goal: string }).goal).trim() : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空');
    try {
      // 子阶段 2-A：任务挂到**当前使用中的项目**（没有就回落默认项目）
      const projectId = await currentProjectId(pool, claims.sub);
      if (projectId === null) return errJson(reply, 500, '当前账号没有项目（重新登录一次让建号流程补上）');
      const t = await pool.query<{ id: string }>(
        "INSERT INTO tasks (project_id, status, title, payload) VALUES ($1, 'running', $2, $3::jsonb) RETURNING id",
        [projectId, goal.slice(0, 80), JSON.stringify({ goal, steps: [] })],
      );
      return { taskId: Number(t.rows[0].id) };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/step', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; ok?: unknown } | null;
    const taskId = Number(b?.taskId);
    const summary = typeof b?.summary === 'string' ? b.summary.slice(0, 300) : '';
    if (!Number.isInteger(taskId) || !summary) return errJson(reply, 400, 'taskId / summary 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[] };
      const steps = [...(payload.steps ?? []), `${summary}${b?.ok === false ? '（失败）' : ''}`].slice(-50);
      await pool.query('UPDATE tasks SET payload = $2::jsonb, updated_at = now() WHERE id = $1', [
        taskId,
        JSON.stringify({ ...payload, steps }),
      ]);
      return { ok: true, stepCount: steps.length };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/status', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; status?: unknown } | null;
    const taskId = Number(b?.taskId);
    const status = String(b?.status ?? '');
    if (!Number.isInteger(taskId) || !['running', 'paused', 'done', 'failed'].includes(status)) {
      return errJson(reply, 400, 'taskId 必填；status ∈ running/paused/done/failed');
    }
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [taskId, status]);
      if (status === 'done' || status === 'failed') {
        triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, t.payload);
      }
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

// ============================================================ 第 8 步：done 的收尾
  // finish：调模型整理一次（可缺）→ 兜底不卡死 → 文档密文入 result_enc → unread=true → 通知桩
  app.post('/agent/task/finish', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; document_title?: unknown; document_outline?: unknown; pagePoints?: unknown } | null;
    const taskId = Number(b?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[] };
      const goal = payload.goal ?? t.title ?? '';
      const steps = payload.steps ?? [];
      const doneBits = {
        summary: typeof b?.summary === 'string' ? b.summary.slice(0, 400) : '',
        document_title: typeof b?.document_title === 'string' ? b.document_title.slice(0, 120) : '',
        document_outline: Array.isArray(b?.document_outline) ? (b.document_outline as unknown[]).slice(0, 12) : [],
      };
      let doc = buildFallbackDoc(goal, steps, doneBits as unknown as Record<string, unknown>);
      if (env.deepseekApiKey) {
        // 只整理一次；模型连不上/乱答都退回兜底，绝不让收尾卡死
        try {
          const points = Array.isArray(b?.pagePoints) ? (b.pagePoints as unknown[]).map(String).slice(0, 12) : [];
          const r = await llmFetch(
            env,
            [
              { role: 'system', content: WRAP_PROMPT },
              {
                role: 'user',
                content: [
                  `任务目标：${goal}`,
                  `步骤摘要：\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）'}`,
                  `驾驶员 done 结论：${doneBits.summary || '（无）'}`,
                  `要点提纲：${doneBits.document_outline.join(' / ') || '（无）'}`,
                  `最后页面要点（仅标题/按钮级，不含整页）：\n${points.join('\n') || '（无）'}`,
                ].join('\n\n'),
              },
            ],
            { tag: 'agent/task/finish', json: true, temperature: 0.2 },
          );
          if (r.ok) {
            const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
            const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
            if (parsed && typeof parsed === 'object') {
              const o = parsed as Record<string, unknown>;
              const md = typeof o.document_markdown === 'string' ? o.document_markdown.slice(0, 20_000) : '';
              if (md.trim()) {
                doc = {
                  summary: (typeof o.summary === 'string' && o.summary.trim()) ? o.summary.slice(0, 400) : doc.summary,
                  title: (typeof o.document_title === 'string' && o.document_title.trim()) ? o.document_title.slice(0, 120) : doc.title,
                  markdown: md,
                  hint: (typeof o.unread_hint === 'string' && o.unread_hint.trim()) ? o.unread_hint.slice(0, 24) : doc.hint,
                };
              }
            }
          }
        } catch (err) {
          console.warn('[agent] 收尾整理未用模型（走兜底，任务仍算完成）：', (err as Error).message);
        }
      }
      await pool.query(
        "UPDATE tasks SET status = 'done', unread = true, result_enc = $2, payload = $3::jsonb, updated_at = now() WHERE id = $1",
        [
          taskId,
          cipher.encryptText(doc.markdown),
          JSON.stringify({ ...payload, doc: { summary: doc.summary, title: doc.title, hint: doc.hint, outline: doneBits.document_outline } }),
        ],
      );
      try {
        notifyUser(claims.sub, `${doc.hint}（任务 #${taskId}：${goal.slice(0, 30)}）`);
      } catch (err) {
        // 通知挂了不碍事：说明书钉死——任务仍算 done，红点和文档都在
        console.warn('[agent] 通知失败（忽略，不影响任务）：', (err as Error).message);
      }
      triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, {
        ...(payload as Record<string, unknown>),
        doc: { summary: doc.summary },
      } as never);
      return { ok: true, unread: true, unreadHint: doc.hint, docTitle: doc.title };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 下载前取文档（密文解回）；老任务没存过 result_enc 就用字段兜底再生成
  app.get('/agent/task/doc', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { taskId?: unknown } | null;
    const taskId = Number(q?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = (t.payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string; title?: string; outline?: string[] } };
      let markdown: string;
      if (t.result_enc) {
        try {
          markdown = cipher.decryptText(t.result_enc);
        } catch {
          return errJson(reply, 500, '文档解密失败：DATA_KEY 可能换过');
        }
      } else {
        const bits = { summary: payload.doc?.summary ?? '', document_title: payload.doc?.title ?? '', document_outline: payload.doc?.outline ?? [] };
        markdown = buildFallbackDoc(payload.goal ?? t.title ?? '', payload.steps ?? [], bits as unknown as Record<string, unknown>).markdown;
      }
      const title = (payload.doc?.title ?? '任务记录').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 60) || '任务记录';
      return { title, markdown };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 看完即读：红点灭
  app.post('/agent/task/read', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const taskId = Number((req.body as { taskId?: unknown } | null)?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET unread = false, updated_at = now() WHERE id = $1', [taskId]);
      return { ok: true, unread: false };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/agent/task/current', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean }>(
        'SELECT t.id, t.status, t.title, t.payload, t.unread FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.user_id = $1 ORDER BY t.id DESC LIMIT 1',
        [claims.sub],
      );
      if (r.rowCount !== 1) return { task: null };
      const row = r.rows[0];
      const payload = (row.payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string; title?: string; hint?: string; outline?: string[] } };
      return {
        task: {
          id: Number(row.id),
          status: row.status,
          goal: payload.goal ?? row.title ?? '',
          steps: payload.steps ?? [],
          unread: Boolean(row.unread),
          summary: payload.doc?.summary ?? '',
          docTitle: payload.doc?.title ?? '',
          unreadHint: payload.doc?.hint ?? '',
          outline: payload.doc?.outline ?? [],
        },
      };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}