/**
 * 子阶段 2-A · **项目层的作用域助手**（服务端唯一出口）。
 *
 * 背景（现状排查的结论）：`projects` 表与 `agents/conversations/tasks/memories.project_id`
 * 这些外键**第 5 步就存在**，但每个用户只被建了一条「默认项目」，所有涉及项目的代码都是
 * 同一句「取这个用户的那一条项目」——项目只是鉴权中转，不是容器。
 * 本文件把「当前项目」这件事收口成一个函数，其余路由不再各写一句 SQL。
 *
 * 两条口径（写清楚，改这块先读这里）：
 *   1. **当前项目** = `users.current_project_id`；为空/失效时**回落到** `is_default` 那条
 *      （回落保证老账号、老代码路径行为一行不变）。
 *   2. **母鸡** = `agents.kind = 'hen'`，随项目一起创建、**不可删除**、`can_create_agents = true`。
 *      默认项目里没有母鸡（建号时就有的是「小助」），所以「不可删除且能建智能体」这个角色
 *      在默认项目里由小助承担 —— 这样**老账号不需要补数据**，前端也不需要改。
 *   3. **调用者身份不允许回落**（2-A 修正）：`POST /agents` 的 `asAgentId` 必填，
 *      不传/非法一律 400，**绝不替你挑一个内置角色**（那是提权）。见 `resolveAgentCreator`。
 *   4. **新建智能体的项目归属 = 调用者自己所在的项目**，与「当前查看中的项目」无关 ——
 *      用户切了项目视角，也不会把新智能体塞进别的项目。
 */
import type { Pool, PoolClient } from 'pg';
import type { ProjectSummary } from '@ai-workbench/shared';
import { withTx } from './db';

/** 母鸡的 kind；`deletable` 与删除路由都认它 */
export const HEN_KIND = 'hen';
/** 母鸡的默认名（用户可改；改的是 agents.name，kind 不变） */
export const HEN_NAME = '项目管家';
/** 自带「小助」的 kind —— 它同样不可删、同样有建智能体的权限 */
export const ASSISTANT_KIND = 'assistant';
export const PROJECT_NAME_MAX = 24;

/** 不可删除、且默认具备「建智能体」权限的两种 kind */
export function isProtectedKind(kind: string): boolean {
  return kind === ASSISTANT_KIND || kind === HEN_KIND;
}

export interface ProjectRow {
  id: string;
  name: string;
  is_default: boolean;
  created_at: Date | string;
  /** 这个项目里的母鸡 id（没有则 null） */
  hen_agent_id?: string | null;
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

export function toProjectSummary(row: ProjectRow, currentProjectId: number | null): ProjectSummary {
  const id = Number(row.id);
  return {
    id,
    name: row.name,
    isCurrent: currentProjectId !== null && id === currentProjectId,
    isDefault: Boolean(row.is_default),
    henAgentId: row.hen_agent_id === null || row.hen_agent_id === undefined ? null : Number(row.hen_agent_id),
    createdAt: toIso(row.created_at),
  };
}

/**
 * 当前使用中的项目 id。
 *
 * 顺序：`users.current_project_id`（且必须仍属于这个用户）→ 回落 `is_default` 那条 → 再回落 id 最小的那条。
 * 全都没有时返回 null（调用方自己决定怎么报错，别在这里抛）。
 */
export async function currentProjectId(pool: Pool, userId: number): Promise<number | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT p.id
       FROM users u
       JOIN projects p ON p.id = u.current_project_id AND p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  if (r.rowCount === 1) return Number(r.rows[0].id);
  const fallback = await pool.query<{ id: string }>(
    'SELECT id FROM projects WHERE user_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1',
    [userId],
  );
  return fallback.rowCount === 1 ? Number(fallback.rows[0].id) : null;
}

/** 某个项目是不是这个用户的（不是 = 当不存在） */
export async function loadOwnedProject(pool: Pool, userId: number, projectId: number): Promise<ProjectRow | null> {
  const r = await pool.query<ProjectRow>(
    `SELECT p.id, p.name, p.is_default, p.created_at,
            (SELECT a.id FROM agents a WHERE a.project_id = p.id AND a.kind = $3 ORDER BY a.id ASC LIMIT 1) AS hen_agent_id
       FROM projects p
      WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, userId, HEN_KIND],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/** 列这个用户的全部项目（母鸡 id 一并带出来，前端/验收都用得上） */
export async function listProjects(pool: Pool, userId: number): Promise<ProjectSummary[]> {
  const cur = await currentProjectId(pool, userId);
  const r = await pool.query<ProjectRow>(
    `SELECT p.id, p.name, p.is_default, p.created_at,
            (SELECT a.id FROM agents a WHERE a.project_id = p.id AND a.kind = $2 ORDER BY a.id ASC LIMIT 1) AS hen_agent_id
       FROM projects p
      WHERE p.user_id = $1
      ORDER BY p.is_default DESC, p.id ASC
      LIMIT 50`,
    [userId, HEN_KIND],
  );
  return r.rows.map((row) => toProjectSummary(row, cur));
}

function cleanProjectName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, PROJECT_NAME_MAX) : '';
}

export { cleanProjectName };

/**
 * 建项目 + **随项目建一只母鸡**（一个事务，要么全成要么全不成）。
 *
 * 母鸡做三件事：`kind='hen'`（不可删）、`can_create_agents=true`（能建智能体）、
 * `persona_status='ready'`（不强制用户先填引导表 —— 母鸡是「干活用的」，不是待配置的新人）。
 * 同时给它建一条空会话，这样它立刻可聊（与 `POST /agents` 的建法一致）。
 *
 * 新项目会**被设为当前项目**（`users.current_project_id`）：建完项目紧接着就用它，
 * 是最符合直觉的默认；想切回去用 `POST /projects/:id/activate`。
 */
export async function createProjectWithHen(
  pool: Pool,
  userId: number,
  rawName: string,
): Promise<{ project: ProjectSummary; henAgentId: number }> {
  const name = cleanProjectName(rawName) || '新项目';
  return withTx(pool, async (client: PoolClient) => {
    const p = await client.query<{ id: string; name: string; created_at: Date | string }>(
      "INSERT INTO projects (user_id, name, is_default) VALUES ($1, $2, false) RETURNING id, name, created_at",
      [userId, name],
    );
    const projectId = Number(p.rows[0].id);
    const a = await client.query<{ id: string }>(
      "INSERT INTO agents (project_id, name, kind, persona_status, can_create_agents) VALUES ($1, $2, 'hen', 'ready', true) RETURNING id",
      [projectId, HEN_NAME],
    );
    const henAgentId = Number(a.rows[0].id);
    await client.query('INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3)', [
      projectId,
      henAgentId,
      HEN_NAME,
    ]);
    await client.query('UPDATE users SET current_project_id = $2 WHERE id = $1', [userId, projectId]);
    return {
      project: toProjectSummary(
        { id: p.rows[0].id, name: p.rows[0].name, is_default: false, created_at: p.rows[0].created_at, hen_agent_id: a.rows[0].id },
        projectId,
      ),
      henAgentId,
    };
  });
}

/**
 * 把一个智能体的权限开关读出来（给 `POST /agents` 的调用者校验用）。
 * 归属校验一并做掉：不是这个账号的智能体一律返回 null。
 */
export async function loadCallerPermission(
  pool: Pool,
  userId: number,
  agentId: number,
): Promise<{ agentId: number; name: string; kind: string; projectId: number; canCreateAgents: boolean } | null> {
  const r = await pool.query<{ id: string; name: string; kind: string; project_id: string; can_create_agents: boolean }>(
    `SELECT a.id, a.name, a.kind, a.project_id, a.can_create_agents
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE a.id = $1 AND p.user_id = $2`,
    [agentId, userId],
  );
  if (r.rowCount !== 1) return null;
  const row = r.rows[0];
  return {
    agentId: Number(row.id),
    name: row.name,
    kind: row.kind,
    projectId: Number(row.project_id),
    canCreateAgents: Boolean(row.can_create_agents),
  };
}

/** 调用者解析结果：要么拿到一个**真实的、属于本账号的**智能体，要么明确说清为什么没拿到。 */
export type AgentCreatorLookup =
  | { ok: true; caller: NonNullable<Awaited<ReturnType<typeof loadCallerPermission>>> }
  | { ok: false; reason: 'missing' | 'not_found' };

/**
 * `POST /agents` 的**调用者**是谁 —— 2-A 修正后：`asAgentId` **必填，没有任何回落**。
 *
 * 为什么不留回落（这是被总控拍板堵掉的**提权口子**）：
 * 调用者身上带的是**权限位**（`can_create_agents`）。任何「不传就替你挑一个」的兜底，
 * 挑中的必然是内置角色（自带小助 / 母鸡，两者都是 `true`）——
 * 于是**不传身份的请求反而拿到了最高权限**，闸门形同不存在。
 * 所以这里只做「参数是否给了」与「这个智能体是不是你的」两件事，
 * **一次都不替调用方挑身份**；权限位放不放行由调用方判断（403 的文案要说得出是谁被拒了）。
 *
 * 归属口径也要一起钉住：调用者的 **`projectId`** 就是新智能体的落点
 * （不是「当前查看中的项目」）—— 见 `routes/agents.ts` 的 `POST /agents`。
 */
export async function resolveAgentCreator(
  pool: Pool,
  userId: number,
  rawAsAgentId: unknown,
): Promise<AgentCreatorLookup> {
  const asId = Number(rawAsAgentId);
  if (!Number.isSafeInteger(asId) || asId <= 0) return { ok: false, reason: 'missing' };
  const caller = await loadCallerPermission(pool, userId, asId);
  return caller ? { ok: true, caller } : { ok: false, reason: 'not_found' };
}
