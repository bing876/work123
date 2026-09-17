/**
 * 第 16 步：轻量会话状态。**子阶段 A 起按「页」与「会话」两个粒度分开存**：
 *
 *   - **会话级**（本文件，继续存在 `conversations` 表上，表结构与唯一约束一律不动）：
 *     `browser_confirmed` / `already_told_user_login_themselves` / `keepalive`，
 *     以及闲聊轮（没有页维度）下的全部字段。它服务的是「一个智能体的那条会话」。
 *   - **页级 / 任务级**（`pageState.ts`，按 wcId 分片的内存注册表）：
 *     `current_task` / `latest_user_intent` / `last_page_summary` / `login_required` /
 *     `sensitive_action`（+ 上面那几个的页内副本）。
 *     任务轮（`/chat/stream` 带 taskMode 且带 wcId）**不再覆写 conversations 这几列**，
 *     否则同一智能体的两个浏览器任务会互相覆盖。
 *
 * 存在哪：会话级仍是**现有 Postgres 的 conversations 表**（第 5 步就有的会话表），
 * 不新建 SQLite、不建第二套库、不上向量库；页级见 pageState.ts 的选型说明。
 *
 * 字段（与提示词里的块一一对应）：
 *   current_task                        当前任务（一句话）           ← 任务轮：页级
 *   latest_user_intent                  用户最新一句                 ← 任务轮：页级
 *   browser_confirmed                   本会话是否已确认过用浏览器     ← 会话级 + 页级副本
 *   login_required                      是否需要用户自己在网页里登录   ← 任务轮：页级
 *   sensitive_action                    本轮是否涉及敏感/不可逆操作    ← 任务轮：页级
 *   last_page_summary                   最后一页摘要（可选，短）      ← 任务轮：页级
 *   already_told_user_login_themselves  是否已经提醒过用户自己登录（提醒一次就够）
 *   keepalive                           该智能体是否处于「启动并保活」监听态（**智能体级**）
 *
 * 更新规则（本文件是唯一入口，别在路由里另写一套）：
 *   - 每轮先解析最新用户消息，更新 latest_user_intent；
 *   - 最新一句**覆盖** current_task（改口立刻切换，旧任务不再提起）；
 *   - 用户说「继续 / 按我上一条」→ 视为已确认执行当前最新意图（current_task 保持不变，
 *     browser_confirmed = true），这样下一轮不会再问「是否继续」；
 *   - 本轮是明确开页指令（桌面带 browserOpened 上来）→ browser_confirmed = true；
 *   - 空闲保活不调模型：本文件只读写状态，不触发任何模型调用。
 */
import type { Pool } from 'pg';
import { patchPageState } from './pageState';
import {
  isContinueMarker,
  looksLikeLoginReminder,
  looksLikeSensitiveAction,
  mentionsLogin,
  type SessionStateLike,
} from './promptPolicy';

export interface ConversationState extends SessionStateLike {
  conversationId: number;
}

/** 列表/回传统一用的列（顺序与 ConversationState 的读取一致） */
const STATE_COLS =
  'current_task, latest_user_intent, browser_confirmed, login_required, sensitive_action, last_page_summary, already_told_user_login_themselves, keepalive';

interface StateRow {
  current_task: string | null;
  latest_user_intent: string | null;
  browser_confirmed: boolean | null;
  login_required: boolean | null;
  sensitive_action: boolean | null;
  last_page_summary: string | null;
  already_told_user_login_themselves: boolean | null;
  keepalive: boolean | null;
}

const s = (v: string | null): string => (typeof v === 'string' ? v : '');

function toState(conversationId: number, r: StateRow | undefined, taskSwitched = false): ConversationState {
  return {
    conversationId,
    task_switched: taskSwitched,
    current_task: s(r?.current_task ?? null),
    latest_user_intent: s(r?.latest_user_intent ?? null),
    browser_confirmed: Boolean(r?.browser_confirmed),
    login_required: Boolean(r?.login_required),
    sensitive_action: Boolean(r?.sensitive_action),
    last_page_summary: s(r?.last_page_summary ?? null),
    already_told_user_login_themselves: Boolean(r?.already_told_user_login_themselves),
    keepalive: Boolean(r?.keepalive),
  };
}

/** 读一条会话的状态（会话不存在就返回全空，不抛） */
export async function loadConversationState(pool: Pool, conversationId: number): Promise<ConversationState> {
  const r = await pool.query<StateRow>(`SELECT ${STATE_COLS} FROM conversations WHERE id = $1`, [conversationId]);
  return toState(conversationId, r.rowCount === 1 ? r.rows[0] : undefined);
}

export interface ApplyUserMessageOptions {
  /** 桌面已因「明确开页指令」打开（或复用）了网页卡片时带上的地址 —— 视为用户已确认用浏览器 */
  browserOpened?: string;
  /**
   * 子阶段 A：这一轮**是任务轮、且知道在哪张页上干活**时传它（wcId + 归属 + 智能体）。
   *
   * 传了以后，**任务态**（current_task / latest_user_intent / last_page_summary /
   * login_required / sensitive_action）写进 `pageState.ts` 那个**按 wcId 分片**的存储，
   * **不再覆写 `conversations` 这几列** —— 这就是「同一个智能体两个任务互相覆盖」的根治点。
   * `conversations` 上只保留 agent 级的聚合标志（browser_confirmed），供闲聊轮与桌面恢复使用。
   *
   * 不传（闲聊 / 知识库 / 没有页的任务轮）时行为与改造前**完全一致**。
   */
  page?: { wcId: number; userId: number; agentId: number | null } | null;
}

/**
 * 每轮收到用户消息时调一次：更新状态并回传最新值（调用方拿它拼上下文）。
 * 只在**用户真的发了消息**时调用；空闲保活路径不会走到这里（所以不会调模型）。
 */
export async function applyUserMessage(
  pool: Pool,
  conversationId: number,
  message: string,
  opts: ApplyUserMessageOptions = {},
): Promise<ConversationState> {
  const msg = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const openedUrl = String(opts.browserOpened ?? '').trim().slice(0, 500);
  const cur = await loadConversationState(pool, conversationId);

  const cont = isContinueMarker(msg);
  // 最新一句覆盖 current_task；「继续 / 按我上一条」表示沿用上一条，不改 current_task
  let currentTask = cur.current_task;
  if (!cont && msg) currentTask = msg;
  if (!currentTask && msg) currentTask = msg;

  const browserConfirmed = cur.browser_confirmed || Boolean(openedUrl) || cont;
  const loginRequired = mentionsLogin(msg) ? true : cur.login_required;
  // 敏感操作按「本轮」算，不粘住：这轮没有就不带着上一轮的 true 走
  const sensitiveAction = looksLikeSensitiveAction(msg);
  const lastPageSummary = openedUrl ? `已打开 ${openedUrl}`.slice(0, 200) : cur.last_page_summary;
  /**
   * 本轮是否「改口」：不是继续语、原来已经有任务、且这句把任务换成了别的目标。
   * 只在本轮内存里用（提示词里给模型一个「旧目标作废」的信号），不落库。
   */
  const taskSwitched = !cont && Boolean(msg) && Boolean(cur.current_task) && cur.current_task !== msg;

  /**
   * 子阶段 A · 任务轮：**任务态写进按 wcId 分片的存储**。
   *
   * 为什么这里必须分叉：任务轮（/chat/stream 带 taskMode）本来就是「某一张页上的一个任务」，
   * 而 conversations 是「一个智能体一条会话」。同一个智能体开两张页跑两个任务时，
   * 两条任务轮会先后覆写同一行 —— 后开的那条把先开那条的 current_task / last_page_summary 顶掉。
   */
  const page = opts.page && Number.isInteger(Number(opts.page.wcId)) ? opts.page : null;
  if (page) {
    const ps = patchPageState(
      page.wcId,
      {
        current_task: currentTask || '',
        latest_user_intent: msg || '',
        browser_confirmed: browserConfirmed,
        login_required: loginRequired,
        sensitive_action: sensitiveAction,
        last_page_summary: lastPageSummary || '',
      },
      { userId: page.userId, agentId: page.agentId },
    );
    // conversations 只保留 agent 级聚合：确认过用浏览器这件事仍然是「这个会话」的属性
    const r = await pool.query<StateRow>(
      `UPDATE conversations SET browser_confirmed = $2, state_updated_at = now() WHERE id = $1 RETURNING ${STATE_COLS}`,
      [conversationId, browserConfirmed],
    );
    const base = toState(conversationId, r.rowCount === 1 ? r.rows[0] : undefined, taskSwitched);
    return {
      ...base,
      current_task: ps.current_task,
      latest_user_intent: ps.latest_user_intent,
      login_required: ps.login_required,
      sensitive_action: ps.sensitive_action,
      last_page_summary: ps.last_page_summary,
      already_told_user_login_themselves:
        ps.already_told_user_login_themselves || base.already_told_user_login_themselves,
      browser_confirmed: browserConfirmed,
    };
  }

  const r = await pool.query<StateRow>(
    `UPDATE conversations
        SET current_task = $2,
            latest_user_intent = $3,
            browser_confirmed = $4,
            login_required = $5,
            sensitive_action = $6,
            last_page_summary = $7,
            state_updated_at = now()
      WHERE id = $1
      RETURNING ${STATE_COLS}`,
    [conversationId, currentTask || null, msg || null, browserConfirmed, loginRequired, sensitiveAction, lastPageSummary || null],
  );
  return toState(conversationId, r.rowCount === 1 ? r.rows[0] : undefined, taskSwitched);
}

/**
 * 助手回复完成后调一次：如果它是在让用户自己去网页里登录，就记下「已提醒过」，
 * 之后不再每轮重复长篇安全说明（只提醒一次）。
 */
export async function noteLoginReminder(pool: Pool, conversationId: number, assistantText: string): Promise<void> {
  if (!looksLikeLoginReminder(assistantText)) return;
  await pool.query(
    'UPDATE conversations SET already_told_user_login_themselves = true, state_updated_at = now() WHERE id = $1',
    [conversationId],
  );
}

/** 「启动并保活」开关：只改状态位，不调模型、不起新进程、不开新窗口 */
export async function setKeepalive(pool: Pool, conversationId: number, on: boolean): Promise<ConversationState> {
  const r = await pool.query<StateRow>(
    `UPDATE conversations SET keepalive = $2, state_updated_at = now() WHERE id = $1 RETURNING ${STATE_COLS}`,
    [conversationId, on],
  );
  return toState(conversationId, r.rowCount === 1 ? r.rows[0] : undefined);
}

/** 某个智能体最新那条会话的保活状态（GET /agents 列表用；没有会话就是 false） */
export async function keepaliveOfAgent(pool: Pool, ownerId: number, agentId: number): Promise<boolean> {
  const r = await pool.query<{ keepalive: boolean | null }>(
    `SELECT c.keepalive
       FROM conversations c
       JOIN projects p ON p.id = c.project_id
      WHERE c.agent_id = $1 AND p.user_id = $2
      ORDER BY c.id DESC LIMIT 1`,
    [agentId, ownerId],
  );
  return r.rowCount === 1 ? Boolean(r.rows[0].keepalive) : false;
}
