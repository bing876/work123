/**
 * 第 7 步：云端驾驶员接口 —— 每次只决定【一个】本地能执行的动作。
 *
 *   POST /agent/next-action  要 JWT。{taskId?, goal, stepsSummary[], snapshot, paused?}
 *     → 用驾驶员系统提示词 + 目标 + 步摘要 + 当前页快照调 DeepSeek（非流式，JSON 模式），
 *       解析出唯一一个 BrowserAction 返回。
 *     - 模型输出不合法 / 编造动作 → 一律转成 ask_user（“我没看懂页面，请你指导”），绝不瞎点；
 *     - paused=true → 服务端兜底：click/type/open_url 全部拦下换成 ask_user；
 *     - 没配 DEEPSEEK_API_KEY → 503 llm_not_configured，不放假动作。
 *   POST /agent/task/start  {goal} → tasks 表记一条 running（payload.steps=[]），返回 {taskId}
 *   POST /agent/task/step   {taskId, summary, ok} → 追加一步“人话摘要”（绝不存整页 HTML/快照）
 *   POST /agent/task/status {taskId, status} → running/paused/done/failed
 *   GET  /agent/task/current → 我最近一条任务（桌面刷新后还原任务卡用）
 *
 * 循环本体在桌面主进程（agent.ts）：这里只当“问一句答一步”的大脑；
 * 用户暂停时本地先停手，这里是第二道闸。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentActionRequest, AgentActionResponse, PageSnapshot } from '@ai-workbench/shared';
import type { BrowserAction } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
}

/** 驾驶员系统提示词：只放服务端。逐字按第 7 步说明。 */
const DRIVER_PROMPT = [
  '你是工作台浏览器的驾驶员。用户能看见工作台里的真实网页，也可随时暂停自己操作。',
  '每次只输出一个 JSON，不要 Markdown，不要注释，不要额外文字。',
  '动作仅限：open_url, click, type, scroll, wait, ask_user, done（字段与产品类型一致）。',
  '规则：',
  '1. 一次一步。不要一次规划十步。',
  '2. 当前页信息不够就 wait 或 ask_user，禁止瞎点。',
  '3. 遇到登录、验证码、短信、扫码、支付、删除、发送、授权：必须 ask_user。不要猜密码，不要让用户把密码发到聊天里。',
  '4. 同一动作失败两次，第三次 ask_user，说明你看见了什么。',
  '5. 不要改浏览器设置，不要下安装包，不要关闭用户标签，不要绕过验证码，不要攻击网站。',
  '6. 系统告诉你已暂停时，只能 ask_user 或简短确认，不能输出 click/type/open_url。',
  '7. 用户说继续时，只根据「当前 url + 当前页面元素」，不要假设还在旧页面，不要从头再来。',
  '8. 做完立刻 done，带 summary 和 document_outline。',
  '9. 禁止编造页面上没有的按钮。',
].join('\n');

/** paused 覆盖提示：拼在用户消息最前 */
const PAUSED_OVERRIDE = [
  '用户已暂停。页面可能已被用户改过。',
  '在用户明确继续之前，禁止输出 open_url/click/type。',
  '用户说「我登好了」之后，必须用最新 snapshot 决策。',
].join('\n');

/** 允许的动作文法：与 shared BrowserAction 一致 */
const ALLOWED = new Set(['open_url', 'click', 'type', 'scroll', 'wait', 'ask_user', 'done']);

function askUser(reason: string, question: string): Extract<BrowserAction, { action: 'ask_user' }> {
  return { action: 'ask_user', reason, question };
}

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

/** 校验/归一模型吐出来的 JSON：不合法就换 ask_user，绝不让脏动作下发到本地执行 */
function sanitizeAction(raw: unknown, paused: boolean): BrowserAction {
  if (typeof raw !== 'object' || raw === null) return askUser('parse_failed', '我没看懂页面，请你指导一下（告诉我点哪里，或先自己操作再继续）。');
  const o = raw as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action : '';
  if (!ALLOWED.has(action)) return askUser('bad_action', `我不认识这个动作「${action || '(空)'}」，请换个说法或指导我。`);
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const clip = (v: unknown, n: number): string[] =>
    Array.isArray(v) ? v.slice(0, n).map((x) => String(x).slice(0, 120)) : [];
  switch (action) {
    case 'open_url': {
      const url = str(o.url, 500);
      if (!/^https?:\/\//i.test(url)) return askUser('bad_url', '我要打开的网址不合法（需要 http(s):// 开头），请确认目标。');
      return { action: 'open_url', url };
    }
    case 'click': {
      const target = str(o.target, 160);
      if (!target) return askUser('bad_target', '点击目标没写清楚。页面上你想让我点哪个？');
      return { action: 'click', target };
    }
    case 'type': {
      const target = str(o.target, 160);
      const text = typeof o.text === 'string' ? o.text.slice(0, 500) : '';
      if (!target || !text) return askUser('bad_target', '输入框或要输入的内容没写清楚，请指导。');
      return { action: 'type', target, text, submit: Boolean(o.submit) };
    }
    case 'scroll':
      return { action: 'scroll', direction: o.direction === 'up' ? 'up' : 'down' };
    case 'wait': {
      const seconds = Math.max(0, Math.min(Number(o.seconds) || 1, 30));
      return { action: 'wait', seconds };
    }
    case 'ask_user':
      return askUser(str(o.reason, 200) || 'need_help', str(o.question, 500) || '我需要你的指导，接下来怎么办？');
    case 'done':
      return {
        action: 'done',
        summary: str(o.summary, 500) || '任务完成',
        document_title: str(o.document_title, 120) || '任务记录',
        document_outline: clip(o.document_outline, 12),
      };
    default:
      return askUser('bad_action', '这个动作不在本步能力里，请指导我换条路。');
  }
}

/** 兜底：paused 时物理拦掉会动页面的动作（规则 6 的服务端执行） */
function enforcePausedGate(action: BrowserAction, paused: boolean): BrowserAction {
  if (!paused) return action;
  if (action.action === 'click' || action.action === 'type' || action.action === 'open_url') {
    return askUser('paused_by_user', '你已暂停接管中，我不会动页面。要继续就点「继续」，或直接告诉我下一步。');
  }
  return action;
}

/** 从模型回复里抠第一个 JSON 对象（容忍 ``` 围栏和前后废话） */
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

function snapshotBrief(s: PageSnapshot): string {
  const list = (a: string[] | undefined, n: number): string => (a && a.length ? a.slice(0, n).join(' | ') : '（无）');
  return [
    `url: ${s.url}`,
    `title: ${s.title}`,
    `可见按钮: ${list(s.buttons, 24)}`,
    `可见链接: ${list(s.links, 16)}`,
    `可见输入框: ${list(s.inputs, 12)}`,
  ].join('\n');
}

/** 任务归属校验：tasks JOIN projects，只认自己的 */
async function ownTask(pool: Pool, taskId: number, userId: number) {
  const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown }>(
    'SELECT t.id, t.status, t.title, t.payload FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.user_id = $2',
    [taskId, userId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

export function registerAgentRoutes(app: FastifyInstance, { pool, env }: AgentDeps): void {
  // ---------------------------------------------------------------- 只给一步
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

    const userMsg = [
      paused ? PAUSED_OVERRIDE : '',
      `任务目标：${goal}`,
      `已完成步骤（最近 ${steps.length} 条）：`,
      steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（第一步，还没有）',
      '当前页面快照（只信这个，不要想象别的）：',
      snapshotBrief(snapshot),
      paused ? '现在只允许：ask_user 或简短确认。' : '请只输出下一个动作的 JSON。',
    ]
      .filter(Boolean)
      .join('\n\n');

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
            { role: 'system', content: DRIVER_PROMPT },
            { role: 'user', content: userMsg },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const brief = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
        console.error('[agent] 上游 HTTP', r.status, brief);
        return errJson(reply, 502, `模型服务返回 HTTP ${r.status}：${brief || '（无详情）'}`);
      }
      const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? '';
      const parsed = extractJson(content);
      if (parsed === null) {
        // 模型没说人话：按说明书当 ask_user，不瞎执行
        return {
          action: askUser('parse_failed', '我没看懂页面，请你指导一下下一步（也可以你自己操作，然后点「继续」）。'),
          note: '模型输出不是合法 JSON，已按规则转成 ask_user',
        } satisfies AgentActionResponse;
      }
      return { action: enforcePausedGate(sanitizeAction(parsed, paused), paused) } satisfies AgentActionResponse;
    } catch (err) {
      const msg = (err as Error)?.name === 'TimeoutError' ? '模型响应超时（60s），本轮没执行任何动作' : `模型服务连不上：${(err as Error).message}`;
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
      const p = await pool.query<{ id: string }>(
        'SELECT id FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
        [claims.sub],
      );
      if (p.rowCount !== 1) return errJson(reply, 500, '当前账号没有默认项目（重新登录一次让建号流程补上）');
      const t = await pool.query<{ id: string }>(
        "INSERT INTO tasks (project_id, status, title, payload) VALUES ($1, 'running', $2, $3::jsonb) RETURNING id",
        [p.rows[0].id, goal.slice(0, 80), JSON.stringify({ goal, steps: [] })],
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
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/agent/task/current', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown }>(
        'SELECT t.id, t.status, t.title, t.payload FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.user_id = $1 ORDER BY t.id DESC LIMIT 1',
        [claims.sub],
      );
      if (r.rowCount !== 1) return { task: null };
      const row = r.rows[0];
      const payload = (row.payload ?? {}) as { goal?: string; steps?: string[] };
      return {
        task: { id: Number(row.id), status: row.status, goal: payload.goal ?? row.title ?? '', steps: payload.steps ?? [] },
      };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
