/**
 * 子阶段 A · **按浏览器页（wcId）分片的实时状态**。
 *
 * 为什么要拆出来（原状 → 现状）：
 *   第 16 步把这 8 个字段（current_task / latest_user_intent / browser_confirmed / login_required /
 *   sensitive_action / last_page_summary / already_told_user_login_themselves / keepalive）**按
 *   「一个智能体一条会话」**存在 `conversations` 表上。一个智能体只跑一个任务时没问题；
 *   同一个智能体**同时开两张页跑两个任务**时，这两个任务共用同一行：
 *     - 两个循环拿到的「本会话状态」是同一份（后开的那个把先开的 current_task 覆盖掉）；
 *     - last_page_summary 只有一个值，A 页读到的摘要会被 B 页的覆盖。
 *   本文件把**任务态**按 `wcId`（内嵌页的 guest webContents id）分片存起来，
 *   `conversations` 那几列不再是「某个具体浏览器任务的实时状态」的存放处。
 *
 * 为什么用**内存注册表**而不是新建一张表（选型理由，与现状对齐）：
 *   1. 这一份状态的生命周期与 `toolLoop.ts` 的 `LoopSession` **完全一致** —— 循环起来才有、
 *      循环闲置回收就没。`LoopSession` 本身就是内存 `Map` + TTL（那一节明确写着
 *      「在内存里；进程重启即丢——本步明确不做重启恢复」）。放数据库反而会出现
 *      「循环没了、状态还留着」的孤儿行，还得额外写清理任务，生命周期对不齐。
 *   2. **改动最小**：零 DDL、零迁移，也不给每一步工具回执加一次数据库往返
 *      （循环热路径上原来根本不碰库）。
 *   3. **同一套 id 体系**：key 就是 `LoopSession.wcId`，条目里还记着 `loopId`（`LoopSession.id`），
 *      不引入第三套 id。
 *   4. 结论：**按现状风格选内存注册表**。将来若要「重启恢复」，
 *      只要把这一层的读写换成一张 `page_states` 表即可，接口形状不用动。
 *
 * 规矩：
 *   - **本文件是唯一入口**，别在路由里另写一套；
 *   - 条目带 `userId`，读接口只回自己的（别人的页当不存在）；
 *   - 容量与 TTL 跟 `toolLoop.ts` 的循环保持一致（最多 64 条、闲置 10 分钟回收）。
 *
 * `keepalive` 为什么**不**进这个分片表：
 *   它是**智能体级**的「启动并保活」监听开关 —— 写它的地方（`POST /chat/state`）与读它的地方
 *   （`GET /agents` 列表里的 `listening`，见 `keepaliveOfAgent`）都**没有 wcId 这一维**，
 *   一个智能体也就一个值。硬塞进按页分片只会让它变成「每张页一份、没人知道该读哪一份」。
 *   所以它继续留在 `conversations`（那本来就是它正确的粒度），本阶段不动。
 */
import type { PageSnapshot } from '@ai-workbench/shared';

/** 一条分片状态（字段名与 `conversations` 那几列**逐字一致**，方便对照与迁移） */
export interface PageState {
  /** 这张内嵌页的 guest webContents id —— 就是分片键（= LoopSession.wcId） */
  wcId: number;
  /** 归属人：读接口只回自己的 */
  userId: number;
  /** 这一路属于哪个智能体（与 LoopSession.agentId 同源） */
  agentId: number | null;
  /** 最近一次写它的循环 id（与 LoopSession.id 同一套，不引入第三套 id） */
  loopId: string | null;
  current_task: string;
  latest_user_intent: string;
  browser_confirmed: boolean;
  login_required: boolean;
  sensitive_action: boolean;
  last_page_summary: string;
  already_told_user_login_themselves: boolean;
  /** 这一路推进过几步（诊断用，不是步数上限） */
  step: number;
  createdAt: number;
  touchedAt: number;
}

/** 可以写进分片状态的字段（都是**任务态**；`keepalive` 不在其中，见文件末尾说明） */
export interface PageStatePatch {
  current_task?: string;
  latest_user_intent?: string;
  browser_confirmed?: boolean;
  login_required?: boolean;
  sensitive_action?: boolean;
  last_page_summary?: string;
  already_told_user_login_themselves?: boolean;
  step?: number;
}

/** 分片键 = wcId（同一个 id 体系：LoopSession.wcId） */
const pages = new Map<number, PageState>();

/** 同时在册的页数上限（与 toolLoop 的 MAX_LIVE_LOOPS 同量级；超过就先回收最旧的） */
const MAX_PAGE_STATES = 64;
/** 一张页闲置这么久就回收（与循环的 LOOP_TTL_MS 一致：10 分钟） */
const PAGE_STATE_TTL_MS = 10 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [wcId, s] of pages) {
    if (now - s.touchedAt > PAGE_STATE_TTL_MS) pages.delete(wcId);
  }
  if (pages.size <= MAX_PAGE_STATES) return;
  const oldest = [...pages.values()].sort((a, b) => a.touchedAt - b.touchedAt);
  for (const s of oldest.slice(0, pages.size - MAX_PAGE_STATES)) pages.delete(s.wcId);
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function create(wcId: number, userId: number, agentId: number | null, seed?: PageStatePatch | null): PageState {
  const now = Date.now();
  const st: PageState = {
    wcId,
    userId,
    agentId,
    loopId: null,
    current_task: s(seed?.current_task),
    latest_user_intent: s(seed?.latest_user_intent),
    browser_confirmed: Boolean(seed?.browser_confirmed),
    login_required: Boolean(seed?.login_required),
    sensitive_action: Boolean(seed?.sensitive_action),
    last_page_summary: s(seed?.last_page_summary),
    already_told_user_login_themselves: Boolean(seed?.already_told_user_login_themselves),
    step: Number.isFinite(Number(seed?.step)) ? Number(seed?.step) : 0,
    createdAt: now,
    touchedAt: now,
  };
  pages.set(wcId, st);
  return st;
}

/**
 * 取（必要时按 seed 建）某张页的状态。
 *
 * seed 只在**第一次**用到这张页时生效 —— 它就是「会话级状态」在页面上的初值
 * （browser_confirmed / already_told… 这些从聊天那边继承过来的东西），
 * 一旦这张页有了自己的记录，**页级状态优先**，绝不再被会话级覆盖回去。
 */
export function pageStateOf(
  wcId: number,
  opts: { userId: number; agentId?: number | null; seed?: PageStatePatch | null },
): PageState {
  sweep();
  const found = pages.get(wcId);
  if (found) {
    found.touchedAt = Date.now();
    if (typeof opts.agentId === 'number' && found.agentId === null) found.agentId = opts.agentId;
    // 兜底补归属：只有「还没归属过」的条目才认新的 userId（不让人抢走别人的页）
    if (opts.userId > 0 && found.userId <= 0) found.userId = opts.userId;
    return found;
  }
  return create(wcId, opts.userId, opts.agentId ?? null, opts.seed ?? null);
}

/** 只读地取（没有就返回 null，**不建条目**） */
export function loadPageState(wcId: number): PageState | null {
  const st = pages.get(wcId);
  if (!st) return null;
  if (Date.now() - st.touchedAt > PAGE_STATE_TTL_MS) {
    pages.delete(wcId);
    return null;
  }
  return st;
}

/** 合并写入（未给的字段保持原值）；返回写后的状态 */
export function patchPageState(
  wcId: number,
  patch: PageStatePatch,
  opts: { userId: number; agentId?: number | null; loopId?: string | null },
): PageState {
  const st = pageStateOf(wcId, { userId: opts.userId, agentId: opts.agentId, seed: patch });
  if (patch.current_task !== undefined) st.current_task = s(patch.current_task).slice(0, 300);
  if (patch.latest_user_intent !== undefined) st.latest_user_intent = s(patch.latest_user_intent).slice(0, 300);
  if (patch.browser_confirmed !== undefined) st.browser_confirmed = Boolean(patch.browser_confirmed);
  if (patch.login_required !== undefined) st.login_required = Boolean(patch.login_required);
  if (patch.sensitive_action !== undefined) st.sensitive_action = Boolean(patch.sensitive_action);
  if (patch.last_page_summary !== undefined) st.last_page_summary = s(patch.last_page_summary).slice(0, 200);
  if (patch.already_told_user_login_themselves !== undefined) {
    st.already_told_user_login_themselves = Boolean(patch.already_told_user_login_themselves);
  }
  if (patch.step !== undefined) st.step = Math.max(0, Math.floor(Number(patch.step) || 0));
  if (opts.loopId !== undefined) st.loopId = opts.loopId;
  st.touchedAt = Date.now();
  return st;
}

/** 把这一路在服务端的循环 id 记在页上（诊断 / 将来做「按页停」时用） */
export function bindPageLoop(wcId: number, loopId: string, userId: number, agentId: number | null): void {
  patchPageState(wcId, {}, { userId, agentId, loopId });
}

/** 从页面快照生成一句短摘要（与 sessionState 里那句 `已打开 <url>` 同风格，短、可扫读） */
export function summaryFromSnapshot(snapshot: PageSnapshot | null | undefined): string {
  if (!snapshot) return '';
  const url = s(snapshot.url).slice(0, 160);
  const title = s(snapshot.title).slice(0, 60);
  if (!url && !title) return '';
  return `已读 ${url}${title ? ` · ${title}` : ''}`.slice(0, 200);
}

/** 列表（诊断接口用；调用方自己按 userId 过滤） */
export function listPageStates(): PageState[] {
  sweep();
  return [...pages.values()].map((x) => ({ ...x }));
}

/** 现在在册几张页（/health 暴露它，用来证明分片真的按页建起来了） */
export function pageStateCount(): number {
  sweep();
  return pages.size;
}

/**
 * 某个智能体名下**最近被碰过**的那张页的状态（没有就 null）。
 *
 * 谁用它：`GET /chat/state`（桌面「当前任务」那一行 + 进程重启后的恢复）。
 * 子阶段 A 之后任务轮不再把任务态写进 `conversations`，所以那一行要能从**页级**取到值，
 * 否则「用户刚下了一个网页任务，左栏却不显示当前任务」——功能上算退步。
 * 多路并行时它给的是「最近动过的那一路」，与左栏横幅「N 路驾驶中」的聚合口径一致。
 */
export function latestPageStateOfAgent(agentId: number): PageState | null {
  sweep();
  let best: PageState | null = null;
  for (const st of pages.values()) {
    if (st.agentId !== agentId) continue;
    if (!best || st.touchedAt > best.touchedAt) best = st;
  }
  return best ? { ...best } : null;
}

/** 清掉某张页的状态（页关了 / 用户明确要求重置时用） */
export function clearPageState(wcId: number): boolean {
  return pages.delete(wcId);
}
