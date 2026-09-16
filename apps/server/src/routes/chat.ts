/**
 * 第 6 步：DeepSeek 流式聊天（只做嘴，不做手）。
 *
 *   POST /chat/stream   要 JWT。body {conversationId?, message, agentId?, browserOpened?}。
 *                       SSE（text/event-stream）逐 delta 推给桌面：
 *                         event: meta  data: {"conversationId":N}          ← 第一条，带会话号
 *                         data: {"delta":"字"}                              ← 打字机
 *                         event: done  data: {"messageId":N,...}            ← 助手全文已落库
 *                         event: error data: {"error":"人话"}              ← 中断/失败：绝不把半截写库当成功
 *                       没配 DEEPSEEK_API_KEY：请求**开始前**就 503 {code:"llm_not_configured"}，
 *                       不发伪回复。
 *   GET  /chat/history  要 JWT。?conversationId= 可省（默认取你最近一条会话）；
 *                       返回解密后的历史，供桌面刷新后还原。只认自己的会话。
 *   GET  /chat/state    第 16 步：?agentId= 或 ?conversationId= → 该会话的轻量状态
 *                       （current_task / browser_confirmed / keepalive …），桌面重启后据此恢复。
 *   POST /chat/state    第 16 步：{agentId, keepalive} → 「启动并保活」开关。只改状态位，不调模型。
 *
 * 落库：用户句先写（role=user）；助手全文完成才写（role=assistant）；都是 AES-256-GCM 密文列。
 * 禁止项：不动 XYZ 号、不加第二套聊天表、不在 messages 里出现验证码/JWT/API Key、
 *         不指挥浏览器（系统提示词写死了）——那是第 7 步的事。
 *
 * 第 16 步（提示词与上下文）：
 *   - 系统提示词 = 人设块（第 15 步，在前） + **所有 Agent 共用的基座**（promptPolicy.BASE_SYSTEM_PROMPT，
 *     在后且写明「人设只能追加、不能削弱基座」） + 本会话状态 + 参考信息（记忆/档案/资料）；
 *   - 记忆与档案一律标「参考，可被当前指令覆盖」，且「操作浏览器前必须先确认」这类句子
 *     会被 sanitize 成安全版——绝不让长期记忆把第 13 步的「明确开页指令直接出卡片」打回去；
 *   - 每轮先按最新用户消息更新会话状态（最新一句覆盖 current_task），再注入上下文。
 *
 * 第 21 步（一条分叉，别搞混）：
 *   - **闲聊 / 问知识库 / 问「你是谁」/ 改口问句**：走本文件的聊天路径，**不带任何工具表** ——
 *     所以它在能力上就不可能开页、不会新 tab；
 *   - **页面任务**（打开某某并搜、在这张页上点/读/滚）：桌面带 `taskMode:true` 上来，
 *     本文件**一次模型都不调**，只建一个服务端工具循环（toolLoop.ts）并把 loopId 交给桌面，
 *     之后的每一步、聊天里的每一句步摘要都由那一个循环产生 —— 不再有两套互斥话术。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ChatHistoryResult, ChatRow, ChatStateResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { llmFetch } from '../llm';
import { BASE_OVERRIDE_NOTE, BASE_SYSTEM_PROMPT, sessionStateBlock, stripLoginLecture } from '../promptPolicy';
import {
  applyUserMessage,
  loadConversationState,
  noteLoginReminder,
  setKeepalive,
} from '../sessionState';
import { buildMemoryBlock } from './memories';
import { buildKnowledgeBlock } from './knowledge';
import { buildAgentContext, buildUserMemoryBlock, ensureAgentConversation } from './agents';
import { startLoop } from '../toolLoop';

export interface ChatDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/**
 * 系统提示词的**首句**：只放服务端，绝不进前端。
 * 第 15 步起按当前智能体变；第 16 步起后面统一接基座（人设不能关掉基座）。
 */
function systemPromptHead(agentName: string | null): string {
  return agentName && agentName !== '小助'
    ? `你是用户桌面工作台里的一个 AI 智能体（名字见下面的人设块；没给人设就先用「${agentName}」）。`
    : '你是「小助」，用户桌面工作台里的 AI 同事。';
}

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

/**
 * 找/建当前用户的一条会话。owner 校验全走 projects.user_id，别人的会话号直接当不存在。
 *
 * 第 15 步：多了 agentId。**一个智能体一份聊天**——没带会话号时优先按智能体找它自己那条，
 * 绝不去捡「本账号最近一条会话」（那可能是别的智能体的，会串聊天）。
 */
async function resolveConversation(
  pool: Pool,
  userId: number,
  conversationId: number | null,
  seedTitle: string,
  agentId: number | null = null,
): Promise<{ id: number } | { err: string; status: number }> {
  if (conversationId !== null) {
    const own = await pool.query<{ id: string }>(
      'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
      [conversationId, userId],
    );
    if (own.rowCount !== 1) return { err: '会话不存在或不是你的', status: 404 };
    return { id: Number(own.rows[0].id) };
  }
  // 第 15 步：带智能体号 → 只认这个智能体自己的会话（没有就建一条给它）
  if (agentId !== null) {
    const owned = await pool.query<{ id: string }>(
      'SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.user_id = $2',
      [agentId, userId],
    );
    if (owned.rowCount !== 1) return { err: '智能体不存在或不是你的', status: 404 };
    const conv = await ensureAgentConversation(pool, userId, agentId);
    if (conv === null) return { err: '建会话失败（智能体或项目缺失）', status: 500 };
    return { id: conv };
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
  // 第 16 步 fixup：有「小助」就走原子的找/建（和 /chat/state、历史加载同一个入口），
  // 免得这条兜底路径和它们并发时又插出第二条会话。
  if (a.rowCount === 1) {
    const conv = await ensureAgentConversation(pool, userId, Number(a.rows[0].id));
    if (conv !== null) return { id: conv };
  }
  const ins = await pool.query<{ id: string }>(
    'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
    [p.rows[0].id, null, seedTitle.slice(0, 24) || '小助会话'],
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

    const body = req.body as
      | {
          conversationId?: unknown;
          message?: unknown;
          browserOpened?: unknown;
          agentId?: unknown;
          /** 第 21 步：这一轮是「页面任务」，交给服务端工具循环（不再并行第二套话术） */
          taskMode?: unknown;
          /** 第 21 步：这一轮要在哪张页上干活 */
          pageUrl?: unknown;
          /** 第 21 步：那张页的 guest webContents id（循环记着它，挡住串到别的 bot） */
          wcId?: unknown;
        }
      | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return errJson(reply, 400, 'message 不能为空');
    /**
     * 第 13 步：桌面判断出这是一句「开网页指令」时，会在发这句的同时把已经打开的网址带上来。
     * 它只是系统提示词的一个开关（不是网页内容、不进历史、不落库），用来告诉小助：
     * 网页已经在聊天卡片里打开并加载好了，别再让用户点「确认 / 开始任务」。
     */
    const openedUrl = typeof body?.browserOpened === 'string' ? body.browserOpened.trim().slice(0, 500) : '';
    /**
     * 第 17 步：光给一长串 URL，模型会从**历史**里捡站点名 ——
     * 实测在百度那张页上干活，它却回「好，我在当前页面（必应）搜…」（因为上一轮聊的是必应）。
     * 这里把站点名单独算出来，明写「这一轮只操作这一张页、别提前面出现过的站点」。
     * 纯字符串解析，不联网、不猜。
     */
    const openedHost = (() => {
      try {
        return new URL(openedUrl).host.replace(/^www\./i, '');
      } catch {
        return '';
      }
    })();
    if (message.length > MESSAGE_MAX) return errJson(reply, 400, `单条消息最长 ${MESSAGE_MAX} 字`);
    let conversationId: number | null = null;
    if (body?.conversationId !== undefined && body?.conversationId !== null && body?.conversationId !== '') {
      const n = Number(body.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数（或干脆不传）');
      conversationId = n;
    }
    // 第 15 步：当前智能体号。只在没带会话号时用来定位「它自己那条会话」。
    let agentId: number | null = null;
    if (body?.agentId !== undefined && body?.agentId !== null && body?.agentId !== '') {
      const n = Number(body.agentId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'agentId 要是正整数（或干脆不传）');
      agentId = n;
    }

    if (!env.deepseekApiKey) {
      // 明确拒绝，绝不用假回复冒充模型
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 dev:server', {
        code: 'llm_not_configured',
      });
    }

    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, message, agentId);
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const convId = conv.id;

      /**
       * 第 16 步：每轮先按**本轮最新消息**更新会话状态，再拿它拼上下文。
       * 规则见 sessionState.applyUserMessage：最新一句覆盖 current_task；「继续 / 按我上一条」
       * 或本轮带了 browserOpened（桌面已直接出卡片）→ browser_confirmed = true，
       * 于是同一会话后续的普通点击/搜索/滚动/读页都不再问。
       */
      const state = await applyUserMessage(pool, convId, message, { browserOpened: openedUrl });

      // 1) 先读历史（不含本句），再落用户消息
      const hist = await pool.query<{ role: string; content_enc: string }>(
        'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2',
        [convId, HISTORY_WINDOW],
      );
      const history = hist.rows
        .reverse()
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .map((r) => {
          const content = safeDecrypt(cipher, r.content_enc);
          /**
           * 第 16 步验收第 ④ 条：本会话已经提醒过「自己登录」之后，
           * 历史里的同类安全提示句不再喂给模型 —— 否则它会照抄旧话，变成每轮都提醒。
           * 只改**喂给模型的上下文**，不改库里存的消息、也不改界面上显示的。
           */
          return {
            role: r.role as 'user' | 'assistant',
            content:
              r.role === 'assistant' && state.already_told_user_login_themselves
                ? stripLoginLecture(content)
                : content,
          };
        });
      const um = await pool.query<{ id: string }>(
        "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'user', $2) RETURNING id",
        [convId, cipher.encryptText(message)],
      );
      const userMessageId = Number(um.rows[0].id);

      /**
       * 第 21 步 · 任务轮：**这一轮不进聊天模型，交给工具循环**。
       *
       * 为什么：聊天（嘴）与驾驶员（手）原来是两套提示词，容易互相矛盾
       * （一边说「确认后我开始操作」，一边已经在点）。本步把「页面任务」整轮交给
       * toolLoop.ts：循环自己选工具 → 桌面执行 → 结果喂回 → 再选下一步，
       * 聊天里出现的步摘要与结论也全部由这一个循环产生。
       *
       * 这里只做三件事：建循环、把开头一句话写进历史、把 loopId 交给桌面去驱动。
       * **一次模型都不调**（第一步由 /agent/loop/next 去问），所以也不会说半截假话。
       *
       * 闲聊 / 问知识库 / 问「你是谁」不会走到这里（桌面判定纯本地），
       * 它们照旧走下面的聊天路径，而且**不带任何工具表** —— 闲聊在能力上就不可能开页。
       */
      if (body?.taskMode === true) {
        const pageUrl = typeof body?.pageUrl === 'string' ? body.pageUrl.trim().slice(0, 500) : '';
        const wcIdRaw = Number(body?.wcId);
        const wcId = Number.isInteger(wcIdRaw) && wcIdRaw > 0 ? wcIdRaw : null;
        // 循环记的智能体以**会话自己的 agent_id** 为准（比请求里的 agentId 更权威）
        const convAgent = await pool.query<{ agent_id: string | null }>('SELECT agent_id FROM conversations WHERE id = $1', [convId]);
        const convAgentId = Number(convAgent.rows[0]?.agent_id);
        const loop = startLoop(env, {
          userId: claims.sub,
          agentId: Number.isInteger(convAgentId) && convAgentId > 0 ? convAgentId : agentId,
          conversationId: convId,
          wcId,
          goal: message,
          pageUrl: pageUrl || openedUrl,
          state: {
            current_task: state.current_task,
            browser_confirmed: state.browser_confirmed,
            login_required: state.login_required,
            already_told_user_login_themselves: state.already_told_user_login_themselves,
            last_page_summary: state.last_page_summary,
          },
        });
        const host = openedHost || (() => {
          try {
            return new URL(pageUrl).host.replace(/^www\./i, '');
          } catch {
            return '';
          }
        })();
        const opening = `好，我在${host ? `「${host}」` : '当前'}这张页上动手了，做完把结果给你。`;
        const am = await pool.query<{ id: string }>(
          "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'assistant', $2) RETURNING id",
          [convId, cipher.encryptText(opening)],
        );
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'access-control-allow-origin': req.headers.origin ?? '*',
        });
        sse(res, 'meta', { conversationId: convId, userMessageId, agentId: loop.agentId });
        sse(res, 'loop', { loopId: loop.id, maxSteps: loop.maxSteps, agentId: loop.agentId, pageUrl: pageUrl || openedUrl });
        sse(res, null, { delta: opening });
        sse(res, 'done', { conversationId: convId, messageId: Number(am.rows[0].id), contentLength: opening.length });
        res.end();
        return;
      }

      // 第 10 步：该用户已确认的档案记忆注入系统提示词（无记忆=空串，行为与第 9 步一致）
      // 第 16 步：它只是**参考**（buildMemoryBlock 自己带「可被当前指令覆盖」的表头）。
      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, message);
      // 第 15 步 · 两层记忆 + 当前智能体人设：
      //   - 用户记忆库（账号级）：所有智能体都读得到，是「这个人」的习惯/口味；
      //   - 项目记忆（智能体级）：**只**读当前会话所属智能体那一份，绝不串号；
      //   - 人设：引导表填完就按它干活；没填完只让模型引导用户去填表，不许空人设乱聊。
      const agentCtx = await buildAgentContext(pool, cipher, claims.sub, convId, agentId);
      const userMemoryBlockRaw = await buildUserMemoryBlock(pool, cipher, claims.sub);
      // 第 11 步：知识库资料是与 memories 完全独立的、仅聊天用的上下文位置。
      // buildKnowledgeBlock 只按当前 owner 的加密片段做关键词字面匹配；空命中/异常都返回空，
      // 不进 agent 的驾驶员 JSON，也不触碰第 10 步的确认逻辑。
      const knowledgeBlock = await buildKnowledgeBlock(pool, cipher, claims.sub, message);
      // 第 13 步：网页已开好时的当轮补充约束（只在带上 browserOpened 的那一轮出现）
      const browserContext = openedUrl
        ? `（本轮补充：用户要开网页，工作台浏览器卡片已经打开并加载 ${openedUrl}${
            openedHost ? `（站点：${openedHost}）` : ''
          }，就在这句下面的聊天里。
网页已经开好了，**不要再让用户点确认、不要再说「确认后我开始操作」**，直接用一句话说明你已经打开了这个网页。
**这一轮你只操作这一张页（${openedHost || openedUrl}）**：说「当前页面」时必须说对站点名，
不要提历史里出现过的别的站点（那些和这一轮无关）。
${
  state.already_told_user_login_themselves
    ? '登录提醒本会话已经说过，这一轮**不要再提**「密码/验证码自己在卡片里输」「我不代填」这类话。'
    : '提醒他可以直接在卡片里点、可以直接把验证码/密码打在网页自己的输入框里（你不会代填、也不会留存）。'
}
如果他还交代了具体要做的事，说你会在卡片里接着做，不要谎称已经做完。）`
        : '';

      /**
       * 第 16 步验收第 ④ 条（登录提醒最多一次）：模型会**照抄自己历史里的安全提醒**——
       * 光在状态块里写一句「已经提醒过」压不住。这里把这条硬性要求放到**系统提示词最末**，
       * 紧贴用户消息，利用近因位置把它按住。
       */
      const loginTail = state.already_told_user_login_themselves
        ? '（本轮硬性要求：本会话你已经提醒过用户「自己在网页卡片里输账号密码验证码」了，所以这一轮' +
          '**不要再写**这类安全提示，也不要写「我不代填 / 我不留存 / 不索要密码」。' +
          '要区分两件事：说「你还得先登录」是可以的（这是任务状态，不是安全提示）；' +
          '说「账号、密码、验证码你自己输，我不代填」就不行——这句本会话已经说过了。' +
          '历史里你之前的同类提醒是旧话，不要照抄。）'
        : '';

      /**
       * 第 16 步 · 系统提示词拼装顺序（顺序本身也是规矩）：
       *   ① 首句（小助 / 某个智能体）
       *   ② 人设块（第 15 步，**在前**）
       *   ③ 基座（所有 Agent 共用，**在后**并写明「人设只能追加、不能削弱基座」）
       *   ④ 本会话状态（current_task / browser_confirmed / keepalive…）
       *   ⑤ 参考信息（记忆/档案/资料，全部标明可被当前指令覆盖）
       * 这样人设与长期记忆都压不住基座，也不会把第 13 步打回「确认后我开始操作」。
       */
      /**
       * 第 16 步 fixup（验收第 ② 条）：本轮只要 current_task 被换掉，就在状态块里明说
       * 「旧目标作废」——模型最爱在这种情况下把旧任务搬回来，让用户在新旧目标之间二选一
       * （实测：「请问你现在想让我做什么：继续在 YouTube 上操作，还是去抖店看订单数据？」）。
       * task_switched 由 applyUserMessage 算好（不落库）。
       */
      const systemParts = [
        systemPromptHead(agentCtx.agentName),
        agentCtx.personaBlock,
        BASE_OVERRIDE_NOTE,
        BASE_SYSTEM_PROMPT,
        sessionStateBlock(state),
        userMemoryBlockRaw,
        agentCtx.projectMemoryBlock,
        memBlock,
        knowledgeBlock,
        browserContext,
        loginTail,
      ].filter((x) => x && x.trim());

      // 2) 调 DeepSeek（OpenAI 兼容 chat/completions，stream:true）。失败/无流 → 普通 JSON 错误，不开 SSE
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      let upstream: Response;
      try {
        upstream = await llmFetch(
          env,
          [
            { role: 'system', content: systemParts.join('\n\n') },
            ...history,
            { role: 'user', content: message },
          ],
          { tag: 'chat/stream', stream: true, signal: ac.signal },
        );
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
      sse(res, 'meta', { conversationId: convId, userMessageId, agentId: agentCtx.agentId });

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
        // 第 16 步：这轮是在让用户自己去网页里登录 → 记「已提醒过」，之后不再重复长篇提醒。
        await noteLoginReminder(pool, convId, full).catch(() => undefined);
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
    const q = req.query as { conversationId?: unknown; agentId?: unknown } | null;
    let conversationId: number | null = null;
    if (q?.conversationId !== undefined && q?.conversationId !== '') {
      const n = Number(q.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数');
      conversationId = n;
    }
    // 第 15 步：切智能体时按 agentId 拉「它自己那条会话」的历史——不会串到别的智能体
    let agentId: number | null = null;
    if (q?.agentId !== undefined && q?.agentId !== '') {
      const n = Number(q.agentId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'agentId 要是正整数');
      agentId = n;
    }
    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, '', agentId);
      if ('err' in conv) {
        // 历史接口对「一条会话都没有」宽容返回空，其余错误照报
        if (conversationId === null) {
          const empty: ChatHistoryResult = { conversationId: null, messages: [] };
          return empty;
        }
        return errJson(reply, conv.status, conv.err);
      }
      /**
       * 第 19 步 fixup：这里原来是 `ORDER BY id ASC LIMIT 200` —— 那是**最老**的 200 条。
       * 会话一旦超过 200 条，刷新/重启后桌面只能看到开头的旧消息，中间整段（包括刚刚
       * 那条带来源的回答）在 DOM 里根本不存在，看起来像「聊天记录丢了 / 知识库来源没生效」。
       * 桌面的诉求是「刷新后还原最近聊的」，所以取**最新** 200 条，再按 id 升序回给前端
       * （前端按数组顺序渲染，顺序不能反）。
       */
      const rows = await pool.query<{ id: string; role: string; content_enc: string; created_at: string }>(
        `SELECT id, role, content_enc, created_at FROM (
           SELECT id, role, content_enc, created_at FROM messages
           WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200
         ) AS recent ORDER BY id ASC`,
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

  // ------------------------------------------- 第 16 步：会话状态（读 / 保活开关）
  /**
   * 桌面重启后靠它恢复：当前任务目标、本会话是否已确认过浏览器、是否在监听。
   * 只认自己的会话（走 projects.user_id），别人的号当不存在。
   */
  app.get('/chat/state', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（会话状态需要第 5 步的 JWT）');
    const q = req.query as { conversationId?: unknown; agentId?: unknown } | null;
    const convIdRaw = Number(q?.conversationId);
    const agentIdRaw = Number(q?.agentId);
    const hasConvId = Number.isInteger(convIdRaw) && convIdRaw > 0;
    const hasAgentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0;
    /**
     * 一个 id 都没带就**直接回空**，不往下走 resolveConversation：
     * 那条兜底分支在账号还没有会话时会 INSERT 一条（GET 产生写副作用，不能接受）。
     * 桌面的 loadAgentState 永远带 agentId，所以这里只是堵住口子。
     */
    if (!hasConvId && !hasAgentId) return { conversationId: null, state: null } satisfies ChatStateResult;
    try {
      const conv = await resolveConversation(
        pool,
        claims.sub,
        hasConvId ? convIdRaw : null,
        '',
        hasAgentId ? agentIdRaw : null,
      );
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const state = await loadConversationState(pool, conv.id);
      return { conversationId: conv.id, state } satisfies ChatStateResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  /**
   * 「启动并保活」：把该智能体的会话标记为监听态。
   * 保活**不等于**会一直调模型——空闲时服务端一次 LLM 都不调（看 /health 的 llmCalls），
   * 有新消息才走本文件的 /chat/stream。也不起新进程、不开新窗口、不做计费看板。
   */
  app.post('/chat/state', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = (req.body ?? {}) as { agentId?: unknown; conversationId?: unknown; keepalive?: unknown };
    const agentIdRaw = Number(b.agentId);
    const convIdRaw = Number(b.conversationId);
    if (typeof b.keepalive !== 'boolean') return errJson(reply, 400, 'keepalive 要是 true/false');
    try {
      const conv = await resolveConversation(
        pool,
        claims.sub,
        Number.isInteger(convIdRaw) && convIdRaw > 0 ? convIdRaw : null,
        '',
        Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null,
      );
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const state = await setKeepalive(pool, conv.id, b.keepalive);
      return { conversationId: conv.id, state } satisfies ChatStateResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
