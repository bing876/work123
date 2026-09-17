/**
 * 第 15 步：多智能体（添加 + 聊天内引导表）+ 两层记忆。
 *
 * 分表（写清楚，交回也照这个说）：
 *   - 智能体人设  → agents.persona / agents.persona_status（**不是记忆**，不碰 memories 表）；
 *   - 用户记忆库  → user_memories（owner_id 账号级，所有智能体都读，属于「这个人」的口味/习惯）；
 *   - 项目记忆    → agent_memories（agent_id 智能体级，一个智能体一份，**绝不串**）；
 *   - 第 10 步的 memories 表原样保留、本步不再写入（老确认流不做第 10 步那套复杂确认）。
 *
 * 接口面（全部要 JWT）：
 *   GET    /agents                 → 我的智能体列表（含人设状态 + 各自的会话号）
 *   POST   /agents                 → 点「添加」：建一个智能体 + 立刻给它建一条空会话
 *   POST   /agents/:id/persona     → 引导表确认：存人设 → persona_status='ready'，之后按它干活
 *   DELETE /agents/:id             → 删自建智能体（「小助」恒不可删）
 *   POST   /agents/:id/tidy        → 把这段聊天**总结**进两层记忆（不存整段聊天）
 *   GET    /memory/user            → 用户记忆库（账号级）
 *   GET    /agents/:id/memory      → 这个智能体的项目记忆
 *   POST   /memory/forget          → {layer:'user'|'agent', id} 忘掉一条
 *
 * 铁律：密码/验证码/支付/身份证/银行卡/扫码 两层都不写（写入前后各过一道敏感闸）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  AgentCreateResult,
  AgentListResult,
  AgentPersona,
  AgentTidyResult,
  AgentView,
  MemoryEntry,
  MemoryLayerList,
} from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable, withTx } from '../db';
import { llmFetch } from '../llm';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { keepaliveOfAgent } from '../sessionState';
import { HEN_KIND, isProtectedKind, loadOwnedProject, resolveAgentCreator } from '../projectScope';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/** 新建智能体的默认名；引导表确认后会被用户填的名称替换 */
export const DEFAULT_AGENT_NAME = '新智能体';
const NAME_MAX = 24;
const PERSONA_FIELD_MAX = 120;
const MEM_CONTENT_MAX = 120;
const MEM_MAX_PER_LAYER = 5;
const TRANSCRIPT_MAX = 6000;

// ---------------------------------------------------------------------------
// 敏感闸：两层记忆都不许写、也不许被当成记忆源。命中即整条丢弃（一票否决）。
// ---------------------------------------------------------------------------
const SENSITIVE_MEM_RE =
  /(密码|口令|passw|验证\s*码|校验\s*码|captcha|\botp\b|动[态态].{0,2}(码|令)|身份证|银行\s*卡|信用\s*卡|卡号|\bcvv\b|\bcvc\b|cookie|token|令牌|\bsecret\b|扫\s*码|支付|付款|转账)/i;
const LONG_DIGITS_RE = /\d{11,}/;

function isSensitive(text: string): boolean {
  return SENSITIVE_MEM_RE.test(text) || LONG_DIGITS_RE.test(text);
}

function normalizeText(s: string): string {
  return String(s).toLowerCase().replace(/[\s，。、,.;；:：!！?？~～"'“”‘’()（）【】\-—_+·]/g, '');
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[agents] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

function oneLine(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** 从 JSONB 里取人设；坏数据/老行一律当没填，不炸 */
function parsePersona(raw: unknown): AgentPersona | null {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const name = oneLine(o.name, NAME_MAX);
  if (!name) return null;
  return {
    name,
    who: oneLine(o.who, PERSONA_FIELD_MAX),
    tone: oneLine(o.tone, PERSONA_FIELD_MAX),
    duty: oneLine(o.duty, PERSONA_FIELD_MAX),
  };
}

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  persona: unknown;
  persona_status: string;
  conversation_id: string | null;
  /** 子阶段 2-A：项目归属 + 权限开关（老调用点的 SELECT 没带这两列时为 undefined） */
  project_id?: string | null;
  can_create_agents?: boolean | null;
}

function toAgentView(r: AgentRow): AgentView {
  const persona = parsePersona(r.persona);
  return {
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    // 小助（assistant）与母鸡（hen）都不可删。前端本来就只按 deletable 决定要不要画「删掉」按钮，
    // 所以这里返回 false 就等于**前端也拦住了**，不需要改前端。
    deletable: !isProtectedKind(r.kind),
    projectId: r.project_id === null || r.project_id === undefined ? undefined : Number(r.project_id),
    canCreateAgents: Boolean(r.can_create_agents),
    // 老库里的行没有 persona_status（DEFAULT 'ready'）——只要 kind 是 assistant 就一律 ready，
    // 「小助」不会被强制再走一遍引导表。
    //
    // 子阶段 2-A：**母鸡也一律 ready**，而且这里必须写成 isProtectedKind —— 不只为好看：
    // 前端「引导表」组件（App.tsx 的 `<AgentGuide>`）只在 personaStatus==='pending' 时渲染，
    // 它里面那个 onDelete **没有** deletable 守卫（那是 UI 自己的路子，本阶段不动前端）。
    // 所以只要保证「内置角色永远不是 pending」，那条**前端唯一没被 deletable 拦住**的删除入口
    // 就永远渲染不出来 —— 前端拦截因此是结构性的，不靠人记得加判断。
    personaStatus: isProtectedKind(r.kind) ? 'ready' : r.persona_status === 'pending' ? 'pending' : 'ready',
    persona,
    conversationId: r.conversation_id === null ? null : Number(r.conversation_id),
  };
}

/** 智能体必须属于这个账号（走 projects.user_id）；不是你的 = 当不存在 */
async function loadOwnedAgent(pool: Pool, ownerId: number, agentId: number): Promise<AgentRow | null> {
  const r = await pool.query<AgentRow>(
    `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
            (SELECT c.id FROM conversations c WHERE c.agent_id = a.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE a.id = $1 AND p.user_id = $2`,
    [agentId, ownerId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/**
 * 找/建某个智能体的会话（一个智能体一份聊天，绝不复用别人的会话）。
 *
 * 第 16 步 fixup：**必须原子**。原来写成「先查后插」，dev 下 React StrictMode 会把挂载
 * effect 跑两遍 → 两个并发请求都读到「还没会话」→ 各插一条，于是「消息进 A、状态读 B」，
 * 会话状态行 / 保活就写到了另一条会话上（实测踩到）。
 *
 * 做法（三步都在一个事务里，顺序不能动）：
 *   1) 先 `FOR UPDATE` 锁住 agents 那一行 —— 并发调用在这里排队；
 *   2) **取到锁之后再另起一条语句**查有没有会话；
 *   3) 没有才插。
 *
 * 第 2 步为什么不能省、也不能塞进第 1 步的 SELECT 里（这是踩过的坑）：
 * READ COMMITTED 下快照是**按语句**取的，而 `FOR UPDATE` 等锁期间用的还是
 * 语句开始时那个快照；EPQ 只会为被锁的那张表的行重新取版本，**不会**刷新 SELECT
 * 列表里子查询的快照。于是后进来的事务即便排到了锁，子查询仍然「看不见」前一个事务
 * 刚提交的会话，照样重复插入 → 撞唯一索引 500。拆成独立语句，新语句拿到新快照，才对。
 *
 * 兜底：conversations(agent_id) 上的部分唯一索引（见 db.ts），保证任何路径都插不进第二条。
 */
export async function ensureAgentConversation(pool: Pool, ownerId: number, agentId: number): Promise<number | null> {
  return withTx(pool, async (client) => {
    // 1) 锁住这个智能体所在行（顺带校验归属：不是这个账号的就当不存在）
    const a = await client.query<{ id: string; name: string; project_id: string }>(
      `SELECT a.id, a.name, a.project_id
         FROM agents a JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND p.user_id = $2
        FOR UPDATE OF a`,
      [agentId, ownerId],
    );
    if (a.rowCount !== 1) return null;

    // 2) 拿到锁之后再查一次（**新语句 = 新快照**，看得见排在前面那个事务刚提交的会话）
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM conversations WHERE agent_id = $1 ORDER BY id DESC LIMIT 1',
      [agentId],
    );
    if ((existing.rowCount ?? 0) >= 1) return Number(existing.rows[0].id);

    // 3) 确实还没有，才建
    const ins = await client.query<{ id: string }>(
      'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
      [a.rows[0].project_id, agentId, a.rows[0].name.slice(0, 24) || '会话'],
    );
    return Number(ins.rows[0].id);
  });
}

// ---------------------------------------------------------------------------
// 注入块（chat.ts 调）：人设 + 两层记忆。全部按 owner / agent 双条件取，绝不串号。
// ---------------------------------------------------------------------------

/**
 * 用户记忆库（账号级）：任何智能体都能读。
 * 属于「这个人」的习惯/口味/展示偏好，与具体项目无关。
 *
 * 第 16 步：注入优先级降级——整块标「参考，可被当前指令覆盖」，并且每一行都过
 * sanitizeReferenceLine：「操作浏览器前必须先确认」这类句子会被改写成安全版，
 * 免得长期记忆把第 13 步「明确开页指令直接出卡片」打回去。
 */
export async function buildUserMemoryBlock(pool: Pool, cipher: JsonCipher, ownerId: number): Promise<string> {
  try {
    const r = await pool.query<{ content_enc: string }>(
      'SELECT content_enc FROM user_memories WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 20',
      [ownerId],
    );
    const lines = referenceLines(r.rows, cipher);
    if (lines.length === 0) return '';
    return ['【参考·用户记忆库（账号级，所有智能体都读得到）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 用户记忆块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

/** 某个智能体的项目记忆（智能体级）：**只**读它自己那份，读不到别的智能体的 */
export async function buildAgentProjectMemoryBlock(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  agentId: number,
): Promise<string> {
  try {
    const r = await pool.query<{ content_enc: string }>(
      'SELECT content_enc FROM agent_memories WHERE agent_id = $1 AND owner_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 20',
      [agentId, ownerId],
    );
    const lines = referenceLines(r.rows, cipher);
    if (lines.length === 0) return '';
    return ['【参考·本项目记忆（只属于当前这个智能体，别的智能体看不到）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 项目记忆块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

/**
 * 参考信息统一处理：解密 → 敏感闸 → 浏览器确认类规则 sanitize → 去重 → 编号。
 * 同一句（尤其被 sanitize 成同一句安全版的）只出现一次，避免刷屏式重复。
 */
function referenceLines(rows: Array<{ content_enc: string }>, cipher: JsonCipher): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    let text = '';
    try {
      text = cipher.decryptText(row.content_enc);
    } catch {
      continue;
    }
    if (isSensitive(text)) continue; // 注入前再兜一道，双保险
    const line = sanitizeReferenceLine(text);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(`- ${line}`);
  }
  return lines;
}

export interface AgentContext {
  agentId: number | null;
  agentName: string | null;
  /** 人设块（引导表填完才有内容；没填完给的是「先引导」指令） */
  personaBlock: string;
  projectMemoryBlock: string;
}

/**
 * 按会话号找到当前智能体，拼出「人设块 + 项目记忆块」。
 * 会话不属于这个账号时返回空上下文（调用方另有 404 校验，这里只是兜底）。
 */
export async function buildAgentContext(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  conversationId: number | null,
  agentIdHint: number | null,
): Promise<AgentContext> {
  const empty: AgentContext = { agentId: null, agentName: null, personaBlock: '', projectMemoryBlock: '' };
  try {
    let row: AgentRow | null = null;
    if (conversationId !== null) {
      const r = await pool.query<AgentRow>(
        `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
                (SELECT c2.id FROM conversations c2 WHERE c2.agent_id = a.id ORDER BY c2.id DESC LIMIT 1) AS conversation_id
           FROM conversations c JOIN projects p ON p.id = c.project_id
           LEFT JOIN agents a ON a.id = c.agent_id
          WHERE c.id = $1 AND p.user_id = $2`,
        [conversationId, ownerId],
      );
      if (r.rowCount === 1) row = r.rows[0];
    }
    if (!row && agentIdHint !== null) row = await loadOwnedAgent(pool, ownerId, agentIdHint);
    if (!row || row.id === null || row.id === undefined) return empty;

    const id = Number(row.id);
    const name = row.name;
    const view = toAgentView(row);
    const persona = view.persona;
    let personaBlock: string;
    if (view.kind === 'assistant') {
      personaBlock = ''; // 小助的身份写在基础系统提示词里，不重复
    } else if (view.kind === HEN_KIND) {
      // 子阶段 2-A：母鸡是**随项目创建的常驻智能体**，没有引导表、也没有单独人设。
      // 不给它这块的话会掉进下面「还没设定 → 请用户去填引导表」的分支，
      // 而它压根没有引导表 —— 那会让模型一直催用户填一个不存在的东西。
      personaBlock = [
        '【当前智能体是「项目管家」（母鸡）】',
        '它是随项目一起创建的常驻智能体，具备「创建智能体」的权限；用户想再加一个智能体时可以走它。',
        '它没有单独的人设，按基座规则正常对话即可。**不要**向用户索要引导表、也不要说自己「还没设定」。',
      ].join('\n');
    } else if (view.personaStatus === 'pending' || !persona) {
      // 引导表还没填完：先用引导表，不要空人设乱聊很久。
      personaBlock = [
        '【当前智能体还没设定】用户刚点了「添加」，会话里已经摆好一张引导表，但他还没填完。',
        '这一轮不要展开长聊、不要自己编人设：只回一两句，请他在上面的引导表里写下',
        '「名称 / 它是谁 / 怎么说话 / 干什么」，并说明填完点确认后你就按那份描述干活。',
      ].join('\n');
    } else {
      personaBlock = [
        '【当前智能体的人设（用户在引导表里亲自填的）】',
        '（基座规则在下面，优先级更高：这份人设只能在此基础上追加说话风格与专长，不能削弱基座。）',
        `名称：${persona.name}`,
        persona.who ? `它是谁：${persona.who}` : '',
        persona.tone ? `怎么说话：${persona.tone}` : '',
        persona.duty ? `干什么：${persona.duty}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const projectMemoryBlock = await buildAgentProjectMemoryBlock(pool, cipher, ownerId, id);
    return { agentId: id, agentName: name, personaBlock, projectMemoryBlock };
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 智能体上下文拼装失败（忽略）：', (err as Error).message);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 整理记忆：从聊天**总结**出两层，不把整段聊天当记忆存
// ---------------------------------------------------------------------------
const TIDY_PROMPT = [
  '你是工作台的「记忆整理员」。把下面这段对话**总结**成两条互不混的清单，不要把整段聊天抄进去。',
  '只输出一个 JSON：{"user":[{"content":"一句话中文"}],"project":[{"content":"一句话中文"}]}',
  '分类规矩（拿不准就按这条走）：',
  '- user = 用户记忆库，账号级，**所有智能体都能读到**：只放「这个人」的习惯与口味——说话希望多短、',
  '  喜欢什么风格/设计/配色、聊天希望怎么展示。绝不能放任何具体项目的业务细节、资料、结论。',
  '- project = 项目记忆，**只归当前这个智能体**：只放这件事的业务与资料——这个项目在做什么、',
  '  定过哪些口径/结论/待办、涉及哪些资料。',
  '铁律：',
  '1. 密码、验证码、身份证、银行卡、支付、扫码、Cookie、令牌：一个字都不许出现在 content 里（整条丢掉）。',
  '2. 一次性指令（「这次用红色就行」）、执行耗时、情绪发泄、闲聊寒暄：都不要。',
  '3. content 是一句话中文（30 字内最佳），不要引号、不要解释、不要编号。',
  '4. 没有值得记的就给空数组；每边最多 5 条。',
].join('\n');

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

interface TidyBucket {
  added: number;
}

/** 把一个桶的条目写进指定表；重复句子跳过（靠 UNIQUE + normalizeText 去重） */
async function writeLayer(
  pool: Pool,
  cipher: JsonCipher,
  table: 'user_memories' | 'agent_memories',
  ownerId: number,
  agentId: number | null,
  items: unknown,
  source: string,
): Promise<TidyBucket> {
  const list = Array.isArray(items) ? items.slice(0, MEM_MAX_PER_LAYER) : [];
  let added = 0;
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const content = oneLine(o.content, MEM_CONTENT_MAX);
    if (content.length < 2) continue;
    if (isSensitive(content)) {
      console.warn('[agents] 一条疑似敏感内容在写入前被丢弃（两层都不落库）');
      continue;
    }
    const key = normalizeText(content);
    if (!key) continue;
    const enc = cipher.encryptText(content);
    const r =
      table === 'user_memories'
        ? await pool.query(
            'INSERT INTO user_memories (owner_id, mem_key, content_enc, source) VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, mem_key) DO NOTHING',
            [ownerId, key, enc, source],
          )
        : await pool.query(
            'INSERT INTO agent_memories (owner_id, agent_id, mem_key, content_enc, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (agent_id, mem_key) DO NOTHING',
            [ownerId, agentId, key, enc, source],
          );
    added += r.rowCount ?? 0;
  }
  return { added };
}

async function transcriptOfConversation(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  conversationId: number,
): Promise<string | null> {
  const own = await pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
    [conversationId, ownerId],
  );
  if (own.rowCount !== 1) return null;
  const msgs = await pool.query<{ role: string; content_enc: string }>(
    'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
    [conversationId],
  );
  return msgs.rows
    .reverse()
    .map((x) => {
      let text = '';
      try {
        text = cipher.decryptText(x.content_enc);
      } catch {
        return '';
      }
      return `${x.role === 'user' ? '用户' : '助手'}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** 注意：函数名不能叫 registerAgentRoutes —— 那个名字被第 7 步的 routes/agent.ts（驾驶员）占了。 */
export function registerMultiAgentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  const { pool, env, cipher } = deps;

  // ------------------------------------------------------------- 我的智能体列表
  app.get('/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    /**
     * 子阶段 2-A：可选按项目过滤。
     *   `?projectId=123` → 只回这个项目里的智能体（不是自己的项目 → 404，不泄漏别人有几个项目）；
     *   不带参数        → **保持改造前的行为**（这个账号的全部智能体），
     *                     因为前端还没接项目层，改默认语义会悄悄改掉它看到的东西。
     */
    const rawProjectId = (req.query as { projectId?: unknown } | null)?.projectId;
    let projectId: number | null = null;
    if (rawProjectId !== undefined && rawProjectId !== null && String(rawProjectId).trim() !== '') {
      const n = Number(String(rawProjectId).trim());
      if (!Number.isSafeInteger(n) || n <= 0) return errJson(reply, 400, 'projectId 不正确');
      projectId = n;
    }
    try {
      if (projectId !== null) {
        const owned = await loadOwnedProject(pool, claims.sub, projectId);
        if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      }
      const r = await pool.query<AgentRow>(
        `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
                (SELECT c.id FROM conversations c WHERE c.agent_id = a.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
           FROM agents a JOIN projects p ON p.id = a.project_id
          WHERE p.user_id = $1 AND ($2::bigint IS NULL OR a.project_id = $2::bigint)
          ORDER BY CASE WHEN a.kind = 'assistant' THEN 0 WHEN a.kind = 'hen' THEN 1 ELSE 2 END, a.id ASC
          LIMIT 20`,
        [claims.sub, projectId],
      );
      const out: AgentListResult = { agents: r.rows.map(toAgentView) };
      // 第 16 步：「启动并保活」的监听态挂在会话状态上（conversations.keepalive），
      // 这里按智能体逐个取回来给左栏显示；空闲时不调模型，只是把状态标出来。
      for (const a of out.agents) {
        a.listening = await keepaliveOfAgent(pool, claims.sub, a.id);
      }
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // -------------------------------------------- 点「添加」：建智能体 + 立刻建空会话
  // 前端一点就切到这个新会话（引导表摆在聊天里），这里不做任何“先填后台表”的前置。
  //
  // 子阶段 2-A 加了两件事（2-A 修正后已按总控拍板收紧）：
  //   1. **权限校验**：调用者由 `body.asAgentId` **显式指定，必填** —— 不传/非法一律 400，
  //      **没有任何回落**（回落到任何内置角色都等于「不传身份就能拿最高权限」的提权口子）。
  //      指定到的那个智能体必须有 `can_create_agents = true`，否则 403。
  //      母鸡与自带小助为 true，普通智能体默认 false。
  //   2. **项目归属**：新智能体进**调用者自己所在的项目**（`caller.projectId`），
  //      不是「当前使用中的项目」—— 用户切了项目视角也不会把新智能体塞进别的项目。
  app.post('/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const found = await resolveAgentCreator(
        pool,
        claims.sub,
        (req.body as { asAgentId?: unknown } | null)?.asAgentId,
      );
      if (!found.ok) {
        return found.reason === 'missing'
          ? errJson(reply, 400, '缺少 asAgentId：建智能体必须显式指定调用者（不会替你挑身份）')
          : errJson(reply, 404, '调用者智能体不存在或不是你的');
      }
      const caller = found.caller;
      if (!caller.canCreateAgents) {
        return errJson(
          reply,
          403,
          `「${caller.name}」没有创建智能体的权限 —— 只有项目里的母鸡和自带的「小助」可以建智能体。`,
        );
      }
      // 落点 = 调用者自己所在的项目（loadCallerPermission 已经 JOIN projects 校验过归属，
      // 所以这里一定是个属于本账号的合法项目，不需要再回落）。
      const projectId = caller.projectId;
      const created = await withTx(pool, async (client) => {
        const a = await client.query<{ id: string; name: string }>(
          "INSERT INTO agents (project_id, name, kind, persona_status) VALUES ($1, $2, 'custom', 'pending') RETURNING id, name",
          [projectId, DEFAULT_AGENT_NAME],
        );
        const c = await client.query<{ id: string }>(
          'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
          [projectId, a.rows[0].id, DEFAULT_AGENT_NAME],
        );
        return { agentId: a.rows[0].id, conversationId: c.rows[0].id };
      });
      const row = await loadOwnedAgent(pool, claims.sub, Number(created.agentId));
      if (!row) return errJson(reply, 500, '智能体建好了但读不回来，请刷新一次');
      const out: AgentCreateResult = { agent: toAgentView(row) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------------- 引导表确认：存人设 → ready
  app.post('/agents/:id/persona', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const persona: AgentPersona = {
      name: oneLine(b.name, NAME_MAX),
      who: oneLine(b.who, PERSONA_FIELD_MAX),
      tone: oneLine(b.tone, PERSONA_FIELD_MAX),
      duty: oneLine(b.duty, PERSONA_FIELD_MAX),
    };
    if (!persona.name) return errJson(reply, 400, '至少给它起个名称（名称不能为空）');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      if (a.kind === 'assistant') return errJson(reply, 400, '「小助」是自带智能体，不需要（也不允许）重设人设');
      await pool.query("UPDATE agents SET persona = $2::jsonb, persona_status = 'ready', name = $3 WHERE id = $1", [
        agentId,
        JSON.stringify(persona),
        persona.name,
      ]);
      const row = await loadOwnedAgent(pool, claims.sub, agentId);
      const out: AgentCreateResult = { agent: toAgentView(row as AgentRow) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // --------------------------------------------------------------- 删自建智能体
  app.delete('/agents/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      // 「小助」不能删（自带智能体，第 5 步建号时就跟着账号一起创建）；
      // 子阶段 2-A 起**母鸡也不能删** —— 它是项目的「能建智能体的那个角色」，
      // 删了那个项目就再没人能建智能体了。前端靠 deletable=false 已经不画删除按钮，
      // 这里再挡一道（后端才是权威闸）。
      if (a.kind === 'assistant') return errJson(reply, 400, '「小助」是自带的，不能删');
      if (a.kind === HEN_KIND) {
        return errJson(reply, 400, '这是项目的母鸡（随项目创建、有建智能体的权限），不能删。');
      }
      // 只删自己的：它的会话、消息、项目记忆一并级联（不会碰到别的智能体）
      await withTx(pool, async (client) => {
        await client.query('DELETE FROM conversations WHERE agent_id = $1', [agentId]);
        await client.query('DELETE FROM agents WHERE id = $1', [agentId]);
      });
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------- 整理记忆：总结进两层（不存整段）
  app.post('/agents/:id/tidy', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    const bodyConv = Number((req.body as { conversationId?: unknown } | null)?.conversationId);
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      const convId =
        Number.isInteger(bodyConv) && bodyConv > 0 ? bodyConv : await ensureAgentConversation(pool, claims.sub, agentId);
      if (convId === null) return errJson(reply, 404, '这个智能体还没有会话');
      const transcript = await transcriptOfConversation(pool, cipher, claims.sub, convId);
      if (transcript === null) return errJson(reply, 404, '会话不存在或不是你的');
      if (!transcript.trim()) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'empty_transcript' };
        return out;
      }
      if (!env.deepseekApiKey) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'llm_not_configured' };
        return out;
      }

      let parsed: { user?: unknown; project?: unknown } | null = null;
      try {
        const r = await llmFetch(
          env,
          [
            { role: 'system', content: TIDY_PROMPT },
            { role: 'user', content: `对话如下：\n${transcript.slice(-TRANSCRIPT_MAX)}` },
          ],
          { tag: 'agents/tidy', json: true, temperature: 0.2 },
        );
        if (!r.ok) {
          const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: `upstream_http_${r.status}` };
          return out;
        }
        const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        const loose = extractJsonLoose(data.choices?.[0]?.message?.content ?? '');
        if (loose && typeof loose === 'object') parsed = loose as { user?: unknown; project?: unknown };
      } catch (err) {
        const out: AgentTidyResult = {
          userAdded: 0,
          projectAdded: 0,
          skipped: `model_unreachable:${(err as Error).message.slice(0, 60)}`,
        };
        return out;
      }
      if (!parsed) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'bad_model_json' };
        return out;
      }

      // 用户库（账号级）与项目记忆（本智能体）分别落库；敏感条目在 writeLayer 里整条丢弃。
      const userLayer = await writeLayer(pool, cipher, 'user_memories', claims.sub, null, parsed.user, 'chat_tidy');
      const projectLayer = await writeLayer(pool, cipher, 'agent_memories', claims.sub, agentId, parsed.project, 'chat_tidy');
      const out: AgentTidyResult = { userAdded: userLayer.added, projectAdded: projectLayer.added };
      if (userLayer.added === 0 && projectLayer.added === 0) out.skipped = 'nothing_worth_remembering';
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ----------------------------------------------------------- 用户记忆库（账号级）
  app.get('/memory/user', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; content_enc: string; updated_at: Date | string }>(
        'SELECT id, content_enc, updated_at FROM user_memories WHERE owner_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 50',
        [claims.sub],
      );
      const out: MemoryLayerList = { items: r.rows.map((row) => toEntry(row, cipher)).filter((x): x is MemoryEntry => x !== null) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------- 某个智能体的项目记忆（智能体级）
  app.get('/agents/:id/memory', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      const r = await pool.query<{ id: string; content_enc: string; updated_at: Date | string }>(
        'SELECT id, content_enc, updated_at FROM agent_memories WHERE agent_id = $1 AND owner_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 50',
        [agentId, claims.sub],
      );
      const out: MemoryLayerList = { items: r.rows.map((row) => toEntry(row, cipher)).filter((x): x is MemoryEntry => x !== null) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------------------------ 忘掉一条
  app.post('/memory/forget', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = (req.body ?? {}) as { layer?: unknown; id?: unknown };
    const layer = b.layer === 'agent' ? 'agent' : b.layer === 'user' ? 'user' : null;
    const id = Number(b.id);
    if (!layer) return errJson(reply, 400, "layer 只能是 'user' 或 'agent'");
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const r =
        layer === 'user'
          ? await pool.query('DELETE FROM user_memories WHERE id = $1 AND owner_id = $2', [id, claims.sub])
          : await pool.query('DELETE FROM agent_memories WHERE id = $1 AND owner_id = $2', [id, claims.sub]);
      if ((r.rowCount ?? 0) !== 1) return errJson(reply, 404, '这条记忆不存在或不是你的');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}

function toEntry(
  row: { id: string; content_enc: string; updated_at: Date | string },
  cipher: JsonCipher,
): MemoryEntry | null {
  let text = '';
  try {
    text = cipher.decryptText(row.content_enc);
  } catch {
    return null;
  }
  return {
    id: Number(row.id),
    content: text,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
  };
}
