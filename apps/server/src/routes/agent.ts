/**
 * 第 7 步：云端驾驶员接口 —— 每次只决定【一个】本地能执行的动作。
 *
 *   POST /agent/next-action  要 JWT。{taskId?, goal, stepsSummary[], snapshot, paused?}
 *     → 用驾驶员系统提示词 + 目标 + 步摘要 + 当前页快照调 DeepSeek（非流式，JSON 模式），
 *       解析出唯一一个 BrowserAction 返回。
 *     - 模型输出不合法 / 编造动作 → 一律转成 ask_user（“我没看懂页面，请你指导”），绝不瞎点；
 *     - 空动作（空字符串 / 空 / 空 JSON {} / 缺 action 字段 / 占位词「空」）一律不当可执行动作：
 *       先带纠偏提示重问一次要合法 BrowserAction，两次都是空才转 ask_user 并写清原因，
 *       绝不静默推进——否则用户会卡在「点继续 → 立刻 paused」的空动作死循环里；
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
  '8. type 必须同时给出 target（输入框）和 text（真正要输入的文字）；不知道要输入什么就用 ask_user 问，禁止给 text 为空的 type。',
  '9. done 只表示「用户要的最终结果已经出现在当前页面上」。',
  '10. 只打开了首页 / 入口页不算完成。目标里含「搜索 / 搜一下 / 查 / 找 X」这类动作时，必须真的把关键词输进输入框并提交（或点搜索按钮）、页面已经跳到结果页，才允许 done。',
  '11. 没做完不要 done，也不要用 done 代替 ask_user。拿不准就 ask_user 问用户，宁可多问一次。',
  '12. 禁止编造页面上没有的按钮。',
].join('\n');

/** paused 覆盖提示：拼在用户消息最前 */
const PAUSED_OVERRIDE = [
  '用户已暂停。页面可能已被用户改过。',
  '在用户明确继续之前，禁止输出 open_url/click/type。',
  '用户说「我登好了」之后，必须用最新 snapshot 决策。',
].join('\n');

/** 允许的动作文法：与 shared BrowserAction 一致 */
const ALLOWED = new Set(['open_url', 'click', 'type', 'scroll', 'wait', 'ask_user', 'done']);

/** 模型「交白卷」时的常见写法（空串、占位词）。这些一律不算可执行动作。 */
const BLANK_ACTION_WORDS = new Set([
  '', '空', '无', '没有', 'none', 'null', 'nil', 'n/a', 'na', 'undefined', '-', '—', '()', '{}',
]);

function isBlankActionWord(v: unknown): boolean {
  return typeof v === 'string' && BLANK_ACTION_WORDS.has(v.trim().toLowerCase());
}

/**
 * 空动作判定：空字符串 / null / undefined / 空 JSON（{}）/ 缺 action 字段 / 占位词「空」……
 * 这些绝不当可执行动作下发，也不能静默当成一步推进——否则用户会卡在
 * 「点继续 → 立刻 paused → 再点继续」的空动作死循环里。
 */
function isEmptyAction(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return isBlankActionWord(raw);
  if (typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length === 0) return true; // 空 JSON {}
  if (!('action' in o) || o.action === null || o.action === undefined) return true; // 缺 action 字段
  return isBlankActionWord(o.action); // 空串 / 占位词
}

/** 第一轮交白卷时的纠偏提示：再要一次合法动作，别急着把用户踢成 paused */
const RETRY_HINT_BLANK = [
  '注意：你上一次的输出不是可执行动作（空动作、空 JSON、缺 action 字段，或根本不是合法 JSON）。',
  '空动作不会被本地执行，也不会推进任务，只会让用户卡住——请不要再用空动作回答。',
  '请只输出一个 JSON 对象，且必须带 action 字段，取值仅限：open_url / click / type / scroll / wait / ask_user / done。',
  '当前页信息不足以决定下一步 → 用 ask_user 并写清 question；目标已完成 → 用 done。',
].join('\n');

/** 第一轮就想收工（只开了首页）时的纠偏提示：把"完成"的门槛说清楚 */
const RETRY_HINT_EARLY_DONE = [
  '注意：你上一次直接给了 done，但现在只打开了首页 / 入口页，用户要的结果还没出现在页面上。',
  'done 只表示「用户要的最终结果已经在当前页面上」；只打开首页不算完成。',
  '请继续输出下一个动作（不要 done）：例如在搜索框里 type 关键词并 submit，或 click 搜索按钮。',
  '如果当前页信息不足以继续，就用 ask_user 问用户，不要用 done 蒙混过去。',
].join('\n');

/** 目标里有没有「要搜 / 要查 / 要找」的意图（纯「打开某页」不算） */
const SEARCH_INTENT = /(搜索|搜一下|搜搜|搜个|查询|查一下|查查|查找|搜|查|找一下|找找)/;
/** 到目前为止有没有真"动过手"的步骤（输入 / 点击 / 提交） */
const HANDS_ON_STEP = /(输入|写入|点击|提交|回车)/;

/** 当前页看起来已经是「结果页」：URL 上带了查询参数（例如百度 /s?wd=天气） */
function looksLikeResultPage(url: string): boolean {
  return /[?&][^=&#]+=[^&#]+/.test(url);
}

/**
 * 判断模型这次的 done 是不是「太早」（只打开首页就想收工）。
 * 判定刻意收窄，避免误伤：
 *   1) 目标里必须有搜索/查询意图 —— 单纯「打开百度」打开完 done 是合理的；
 *   2) 到目前为止没有任何「输入/点击」步骤 —— 说明只 open_url 过，没真推进目标；
 *   3) 当前页也不是带查询参数的结果页 —— 模型直接开结果 URL 的情况放过。
 * 三条同时成立才算早，然后会带纠偏提示重问一次；两次都这样才转 ask_user。
 */
function isPrematureDone(raw: unknown, goal: string, steps: string[], snapshot: PageSnapshot): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  if ((raw as Record<string, unknown>).action !== 'done') return false;
  if (!SEARCH_INTENT.test(goal)) return false;
  if (steps.some((s) => HANDS_ON_STEP.test(s))) return false;
  if (looksLikeResultPage(snapshot.url)) return false;
  return true;
}

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
      // 最多问两轮：第一轮模型可能交白卷（空动作 / 空 JSON / 坏 JSON），也可能「只开了首页就想 done」；
      // 第二轮带对应纠偏提示再要一次 —— 既不因一次坏输出就把用户踢进 paused，也不假装任务已完成。
      let parsed: unknown = null;
      let problem: 'bad_json' | 'empty_action' | 'early_done' | 'none' = 'bad_json';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const hint = attempt === 1 ? '' : problem === 'early_done' ? RETRY_HINT_EARLY_DONE : RETRY_HINT_BLANK;
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
              { role: 'user', content: hint ? `${userMsg}\n\n${hint}` : userMsg },
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
        parsed = extractJson(content);
        if (parsed === null) problem = 'bad_json';
        else if (isEmptyAction(parsed)) problem = 'empty_action';
        else if (isPrematureDone(parsed, goal, steps, snapshot)) problem = 'early_done';
        else problem = 'none';
        if (problem === 'none') break; // 拿到可用动作，收工
        if (attempt === 1) console.warn(`[agent] 模型第 1 轮结果不可用（${problem}），带纠偏提示再要一次`);
      }

      if (problem === 'bad_json') {
        // 模型没说人话：按说明书当 ask_user，不瞎执行
        return {
          action: askUser('parse_failed', '模型这两次都没给出合法 JSON 动作，我没有执行任何动作，也没有推进任务。请告诉我下一步，或你自己操作后点「继续」。'),
          note: '模型输出不是合法 JSON（已带纠偏提示重问一次），已按规则转成 ask_user',
        } satisfies AgentActionResponse;
      }
      if (problem === 'empty_action') {
        // 空字符串 / 空 / 空 JSON / 缺 action 字段：一律不当可执行动作，也不静默推进
        return {
          action: askUser(
            'empty_action',
            '模型这一步给的是空动作（没有可执行内容），我没有执行任何动作，也没有推进任务。请直接告诉我下一步，或你自己操作后点「继续」。',
          ),
          note: '模型两次都只给出空动作（空字符串/空 JSON/缺 action 字段），已按规则转成 ask_user',
        } satisfies AgentActionResponse;
      }
      if (problem === 'early_done') {
        // 只打开了首页就想收工：绝不当成完成，也不静默推进
        return {
          action: askUser(
            'early_done',
            `模型想直接宣告完成，但「${goal}」还没做完——现在只打开了入口页，关键词还没搜。我没有把它当成完成。请告诉我下一步，或你自己操作后点「继续」。`,
          ),
          note: '模型两次都想在只打开入口页时就 done，已按规则转成 ask_user（避免过早 done）',
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
