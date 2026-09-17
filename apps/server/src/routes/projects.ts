/**
 * 子阶段 2-A：**项目**（智能体的上层容器）。
 *
 * 现状（排查结论）：`projects` 表第 5 步就建了，但每个用户只有一条「默认项目」，
 * 且没有任何接口 —— 项目只是鉴权中转。本文件把它开放出来：
 *
 *   GET    /projects                → 我的项目列表（标出「当前使用中」的那条）
 *   POST   /projects   {name}       → 建项目：**同时自动建一只母鸡**，并设为当前项目
 *   PATCH  /projects/:id {name}     → 重命名
 *   POST   /projects/:id/activate   → 设为「当前使用中的项目」
 *
 * 三条口径：
 *   - 归属一律走 JWT 的 `claims.sub`，URL/body 里**不接受**任何客户端传来的 owner；
 *     不是自己的项目一律 404（不区分「不存在」与「是别人的」，避免用 id 探测别人有几个项目）。
 *   - **当前项目**存 `users.current_project_id`；为空/失效时回落到 `is_default` 那条
 *     （老账号、老代码路径行为不变）。
 *   - 建项目**不删、不改**任何已有数据；默认项目（`is_default`）永远保留，它是兜底。
 *
 * 明确不做（本阶段边界）：删项目、项目级配额、母鸡的「调度其他智能体」能力。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ProjectCreateResult, ProjectListResult, ProjectUpdateResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import {
  cleanProjectName,
  createProjectWithHen,
  currentProjectId,
  listProjects,
  loadOwnedProject,
  toProjectSummary,
} from '../projectScope';

export interface ProjectDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[projects] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** URL 里的项目 id：只认纯数字，'12abc' 不能被悄悄当成 12 */
function projectIdFromParams(req: FastifyRequest): number | null {
  const raw = String((req.params as { id?: string } | undefined)?.id ?? '').trim();
  if (!/^\d{1,18}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function registerProjectRoutes(app: FastifyInstance, { pool, env }: ProjectDeps): void {
  // ------------------------------------------------------------------ 我的项目
  app.get('/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const projects = await listProjects(pool, claims.sub);
      const cur = projects.find((p) => p.isCurrent) ?? null;
      const out: ProjectListResult = { projects, currentProjectId: cur ? cur.id : null };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // -------------------------------------------------- 建项目（连带建母鸡 + 设为当前）
  app.post('/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const name = cleanProjectName((req.body as { name?: unknown } | null)?.name);
    if (!name) return errJson(reply, 400, '给项目起个名字（不能为空）');
    try {
      const { project } = await createProjectWithHen(pool, claims.sub, name);
      const out: ProjectCreateResult = { project };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------------------------ 重命名
  app.patch('/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = projectIdFromParams(req);
    if (id === null) return errJson(reply, 400, '项目编号不正确');
    const name = cleanProjectName((req.body as { name?: unknown } | null)?.name);
    if (!name) return errJson(reply, 400, '给项目起个名字（不能为空）');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, id);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [id, name]);
      const after = await loadOwnedProject(pool, claims.sub, id);
      const cur = await currentProjectId(pool, claims.sub);
      const out: ProjectUpdateResult = { project: toProjectSummary(after ?? owned, cur) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------- 设为「当前使用中」
  app.post('/projects/:id/activate', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = projectIdFromParams(req);
    if (id === null) return errJson(reply, 400, '项目编号不正确');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, id);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      await pool.query('UPDATE users SET current_project_id = $2 WHERE id = $1', [claims.sub, id]);
      const out: ProjectUpdateResult = { project: toProjectSummary(owned, id) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
