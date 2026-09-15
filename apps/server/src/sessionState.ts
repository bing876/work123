/**
 * 第 16 步：轻量会话状态（每个智能体的那条会话一份），随会话一起持久化。
 *
 * 存在哪：**现有 Postgres 的 conversations 表**（第 5 步就有的会话表，只补了几列），
 * 不新建 SQLite、不建第二套库、不上向量库。
 *
 * 字段（与提示词里的块一一对应）：
 *   current_task                        当前任务（一句话）
 *   latest_user_intent                  用户最新一句
 *   browser_confirmed                   本会话是否已确认过用浏览器
 *   login_required                      是否需要用户自己在网页里登录
 *   sensitive_action                    本轮是否涉及敏感/不可逆操作
 *   last_page_summary                   最后一页摘要（可选，短）
 *   already_told_user_login_themselves  是否已经提醒过用户自己登录（提醒一次就够）
 *   keepalive                           该智能体是否处于「启动并保活」监听态
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
