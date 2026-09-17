/**
 * 第 21 步 · 工具循环的 HTTP 面（脑在服务端，手在桌面）。
 *
 *   POST /agent/loop/start  要 JWT。{agentId, goal, pageUrl?, wcId?, conversationId?}
 *        → 建一个循环（消息历史、工具表、步数上限都在服务端），回 {loopId, maxSteps, step}
 *   POST /agent/loop/next   要 JWT。{loopId, agentId?, wcId?, result?}
 *        → 喂回上一个工具的回执（第一次不带），回下一格决策：
 *          {kind:'tool'} 给一个工具 → 桌面在**这张页**上执行
 *          {kind:'ask'}  停下来问用户（原因 + 一个下一步）
 *          {kind:'done'} 收尾（结论/提纲给任务文档用）
 *          {kind:'say'}  模型只是说话，循环停住等新指令
 *          {kind:'stopped'} 已被叫停
 *   POST /agent/loop/stop   要 JWT。{loopId} 或 {wcId}
 *        → 用户喊「停」/ 桌面放下某一路时调；之后这一路再也不调模型。
 *
 * 不串 bot：循环里记着 agentId 与 wcId，`next` 每次都要对上 —— 对不上直接 409，
 * 绝不让 A 智能体的循环把动作打到 B 智能体那张页上。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentLoopDecision, AgentLoopStartResult, LoopToolResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { listPageStates, loadPageState } from '../pageState';
import { loadConversationState } from '../sessionState';
import {
  advance,
  getLoop,
  liveLoopCount,
  LoopBusyError,
  startLoop,
  stopLoop,
  stopLoopsOfPage,
  stopLoopsOfUser,
  type LoopStateBrief,
} from '../toolLoop';

export interface LoopDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[loop] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 智能体归属校验：只认自己项目下的智能体（别人的号当不存在） */
async function ownsAgent(pool: Pool, userId: number, agentId: number): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    'SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.user_id = $2',
    [agentId, userId],
  );
  return r.rowCount === 1;
}

export function registerLoopRoutes(app: FastifyInstance, { pool, env }: LoopDeps): void {
  app.post('/agent/loop/start', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（工具循环需要第 5 步的 JWT）');
    if (!env.deepseekApiKey) {
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server', {
        code: 'llm_not_configured',
      });
    }
    const b = req.body as
      | { agentId?: unknown; goal?: unknown; pageUrl?: unknown; wcId?: unknown; conversationId?: unknown }
      | null;
    const goal = typeof b?.goal === 'string' ? b.goal.trim().slice(0, 500) : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空（先告诉我要完成什么）');
    const agentIdRaw = Number(b?.agentId);
    const agentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null;
    if (agentId !== null) {
      try {
        if (!(await ownsAgent(pool, claims.sub, agentId))) return errJson(reply, 404, '智能体不存在或不是你的');
      } catch (err) {
        return dbErr(reply, err);
      }
    }
    const wcIdRaw = Number(b?.wcId);
    const wcId = Number.isInteger(wcIdRaw) && wcIdRaw > 0 ? wcIdRaw : null;
    const convIdRaw = Number(b?.conversationId);
    const conversationId = Number.isInteger(convIdRaw) && convIdRaw > 0 ? convIdRaw : null;

    // 会话状态（第 16 步那一份，循环与聊天共用；空会话就传 null）
    let state: LoopStateBrief | null = null;
    if (conversationId !== null) {
      try {
        const s = await loadConversationState(pool, conversationId);
        state = {
          current_task: s.current_task,
          browser_confirmed: s.browser_confirmed,
          login_required: s.login_required,
          already_told_user_login_themselves: s.already_told_user_login_themselves,
          last_page_summary: s.last_page_summary,
        };
      } catch (err) {
        return dbErr(reply, err);
      }
    }

    const session = startLoop(env, {
      userId: claims.sub,
      agentId,
      conversationId,
      wcId,
      goal,
      pageUrl: typeof b?.pageUrl === 'string' ? b.pageUrl.trim().slice(0, 500) : '',
      state,
    });
    console.log(
      `[loop] 新循环 ${session.id}（智能体 ${agentId ?? '-'}，页 ${wcId ?? '-'}，上限 ${session.maxSteps} 步）：${goal.slice(0, 40)}`,
    );
    return {
      loopId: session.id,
      agentId: session.agentId,
      maxSteps: session.maxSteps,
      step: session.step,
    } satisfies AgentLoopStartResult;
  });

  app.post('/agent/loop/next', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; agentId?: unknown; wcId?: unknown; result?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (!loopId) return errJson(reply, 400, 'loopId 必填');
    const session = getLoop(loopId);
    if (!session) return errJson(reply, 404, '这个循环不存在或已过期（重新下指令即可）');
    if (session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');

    /**
     * 不串 bot 的硬闸：智能体 / 那张页都必须和建循环时一致。
     * 桌面两路并行（两个智能体各一张页）时，这一条挡住「A 的循环点到 B 的页上」。
     */
    const agentIdRaw = Number(b?.agentId);
    if (session.agentId !== null && Number.isInteger(agentIdRaw) && agentIdRaw !== session.agentId) {
      return errJson(reply, 409, `这个循环属于智能体 ${session.agentId}，不是 ${agentIdRaw}——没有执行任何动作。`, {
        code: 'agent_mismatch',
      });
    }
    const wcIdRaw = Number(b?.wcId);
    if (session.wcId !== null && Number.isInteger(wcIdRaw) && wcIdRaw !== session.wcId) {
      return errJson(reply, 409, '这个循环只操作它自己那张页，别的页我不碰——没有执行任何动作。', {
        code: 'page_mismatch',
      });
    }

    const raw = b?.result as Partial<LoopToolResult> | undefined;
    const result: LoopToolResult | null = raw
      ? {
          ok: Boolean(raw.ok),
          detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 500) : undefined,
          error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : undefined,
          noChange: Boolean(raw.noChange),
          refused: typeof raw.refused === 'string' ? raw.refused.slice(0, 300) : undefined,
          userAnswer: typeof raw.userAnswer === 'string' ? raw.userAnswer.slice(0, 300) : undefined,
          page: raw.page && typeof raw.page === 'object' ? raw.page : undefined,
        }
      : null;

    try {
      const decision: AgentLoopDecision = await advance(env, session, result);
      return { decision };
    } catch (err) {
      /**
       * 子阶段 A：同一条循环被并发推进 → **409**，把「被拒了、什么都没发生」说清楚。
       * 这不是服务端故障，是调用方重试/双发，所以不能混进 500。
       */
      if (err instanceof LoopBusyError) {
        return errJson(reply, 409, err.message, { code: err.code, loopId: err.loopId });
      }
      console.error('[loop] 推进失败：', (err as Error)?.message ?? String(err));
      return errJson(reply, 500, `推进循环失败：${(err as Error)?.message ?? String(err)}`);
    }
  });

  app.post('/agent/loop/stop', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; wcId?: unknown; reason?: unknown } | null;
    const reason = typeof b?.reason === 'string' ? b.reason.slice(0, 60) : 'user_stop';
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (loopId) {
      const session = getLoop(loopId);
      if (session && session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');
      const ok = stopLoop(loopId, reason);
      return { ok, stopped: ok ? 1 : 0, live: liveLoopCount() };
    }
    const wcIdRaw = Number(b?.wcId);
    if (Number.isInteger(wcIdRaw)) {
      const n = stopLoopsOfPage(claims.sub, wcIdRaw);
      return { ok: true, stopped: n, live: liveLoopCount() };
    }
    // 都不带 = 全停（登出 / 全局停止）
    const n = stopLoopsOfUser(claims.sub);
    return { ok: true, stopped: n, live: liveLoopCount() };
  });

  /** 诊断用：当前有几路循环活着（不泄漏内容，只看个数） */
  app.get('/agent/loop/live', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    return { live: liveLoopCount() };
  });

  /**
   * 子阶段 A · **按页（wcId）分片的状态读接口**（诊断 / 验收取证用）。
   *
   *   GET /agent/loop/state?wcId=123 → 这一张页自己的状态
   *   GET /agent/loop/state          → 自己名下所有在册的页
   *
   * 只回**调用方自己的**页（条目里记着 userId；别人的页当不存在，回 404）。
   * 为什么要有它：分片状态是不是真的按页分开，必须能**读出来对照**，
   * 光看「两个循环都在跑」证明不了「状态没有互相覆盖」。
   */
  app.get('/agent/loop/state', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { wcId?: unknown } | null;
    const wcIdRaw = Number(q?.wcId);
    if (Number.isInteger(wcIdRaw)) {
      const st = loadPageState(wcIdRaw);
      if (!st || st.userId !== claims.sub) return errJson(reply, 404, '这张页没有在册的分片状态（或不是你的）');
      return { wcId: wcIdRaw, state: st };
    }
    const mine = listPageStates().filter((x) => x.userId === claims.sub);
    return { count: mine.length, pages: mine };
  });
}
