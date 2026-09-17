import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings, onSettingsChange } from './settings';
import {
  type BrowserInstanceInfo,
  type ResourceAggregate,
  type ResourceAlert,
  type ResourceGuardSnapshot,
  type ResourceLevel,
  type ResourceProcInfo,
  type ResourceReason,
  type ResourceSample,
  type ResourceThresholds,
} from '@ai-workbench/shared';

/**
 * Phase 4 · 资源守护者（持续资源监控）
 *
 * 产品理念：**不写死浏览器数量上限**，接近资源极限时才友好提示。
 * 所以这一层只做采集 / 判定 / 落盘 / 暴露数据，**一件事都不改浏览器行为**：
 *   - 不设任何写死的实例数量上限（上限仍只有那个可调配置）；
 *   - **绝不自动关闭任何浏览器** —— 提示里只给"最久未使用"的排序 + 在跑任务的标记，
 *     关不关由用户自己决定；
 *   - 不阻止用户开新页（提示不是闸门）。
 *
 * ---------------------------------------------------------------------------
 * 采集频率为什么是 5 秒（可在配置里改：resourceSampleMs）
 *
 * 1. **够及时**：判定要连续 3 个点（=15s）才算越过警戒线，用户"开了一堆页 → 感觉卡"
 *    到收到提示，量级是十几秒 —— 对"提示"这件事足够快；这是提示不是刹车。
 * 2. **读数稳**：CPU 是**区间均值**。`percentCPUUsage` 是"距上次调用之间的平均占用"，
 *    采样间隔越短，分母越小、噪声越大（1s 采样的抖动能到 ±100%，同一条曲线看着像心电图）。
 * 3. **不成为新负担**：单次采集是一次 `app.getAppMetrics()`（遍历本应用那 10~40 个进程，
 *    微秒~亚毫秒级），5s 一次的实际开销见验收报告里的「开/关监控对照」实测值。
 *    数据量上，落盘只留 60s 汇总（≈290KB/天），不做无界增长。
 *
 * 双时间尺度（这就是"够及时但不变成负担"的落地方式）：
 *   - **5s 原始点**：只进主进程内存的环形缓冲，保留最近 1 小时（720 点）——供"立刻看趋势"；
 *   - **60s 汇总点**：落盘 jsonl —— 供"事后查询"。原始点落盘默认关，
 *     需要时用环境变量 `WB_RESOURCE_GUARD_RAW=1` 打开（排查用）。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 两个最容易说假话的口径（都写进样本里，让读取方能复核）
 *
 * 1. **CPU 口径：Electron 给的已经是整机口径，不要再除核数。**
 *    源码 `shell/browser/api/electron_api_app.cc`：
 *      `cpu_dict.Set("percentCPUUsage", GetPlatformIndependentCPUUsage() / processor_count)`
 *    —— 每个进程的 `percentCPUUsage` 已经除过逻辑核数，即"这个进程占**整机** CPU 的百分比"；
 *    12 核机器上一个核跑满，它读出来是 8.33（=100/12），不是 100。
 *    所以：`cpuPct` = 各进程之和 = 本应用占整机多少（100 = 所有核跑满），
 *    与任务管理器 / `typeperf \Process(*)\% Processor Time` 逐进程求和**同口径、可直接比**。
 *    另外给一个 `cpuCoresUsed`（相当于几个核）只用于文案。
 *    （第一版踩的坑：把"各进程之和"当成"占一个核的百分比"又除以一次核数 ——
 *     12 核上把判定灵敏度缩小 12 倍，20% 的警戒线实际要 240% 才可能到。
 *     真机取证时抓到：一个内嵌页跑满一个核，单进程读数 8.25 ≈ 100/12。）
 * 2. **内存用工作集之和**，与 `tasklist` / 任务管理器同口径。
 *    （任务管理器的"内存"列是工作集；"提交大小"是另一列，拿错列就会"对不上"。）
 */

/** 内存环形缓冲：5s 一个点 × 720 = 最近 1 小时 */
const RING_CAPACITY = 720;
/** 落盘汇总窗口：60s */
const AGGREGATE_WINDOW_MS = 60_000;
/** 同一类提示的冷却：5 分钟（"触发一次提示"，不是每条采样都喊一遍） */
const ALERT_COOLDOWN_MS = 5 * 60_000;
/** 连续几个点越线才算数（去抖：一次毛刺不算问题） */
const OVER_STREAK_TO_TRIGGER = 3;
/** 连续几个点回到线下才解除警戒（滞回：避免在线附近来回抖动、反复提示） */
const UNDER_STREAK_TO_CLEAR = 3;
/** 落盘保留天数 */
const KEEP_DAYS = 7;
/** 内存里保留的提示事件条数（`resourceEvents` 优先从盘上读，这只是兜底） */
const EVENT_RING = 50;

const DIR_NAME = 'resource-guard';
const RAW_ENABLED = process.env.WB_RESOURCE_GUARD_RAW === '1';

interface GuardState {
  ring: ResourceSample[];
  level: ResourceLevel;
  overStreak: number;
  underStreak: number;
  lastAlertAt: number | null;
  events: ResourceAlert[];
  currentWindowAt: number;
  windowSamples: ResourceSample[];
  instances: Map<number, BrowserInstanceInfo>;
  timer: NodeJS.Timeout | null;
  scheduledMs: number;
  started: boolean;
}

const state: GuardState = {
  ring: [],
  level: 'ok',
  overStreak: 0,
  underStreak: 0,
  lastAlertAt: null,
  events: [],
  currentWindowAt: 0,
  windowSamples: [],
  instances: new Map(),
  timer: null,
  scheduledMs: 0,
  started: false,
};

/** 主进程 → 渲染层的广播口（由 main.ts 注入，避免这里 import main 造成循环依赖） */
let broadcast: (channel: string, payload?: unknown) => void = () => undefined;

/**
 * 「哪几张页正在被驾驶」的取值函数（由 main.ts 注入 = lanes 的键）。
 *
 * 为什么不让渲染层报：驾驶状态的权威在主进程（driver / lanes），渲染层只是镜像。
 * 提示里"这个正在干活，别关"这句话必须站得住 —— 用户照着列表关掉正在跑任务的页就完了。
 */
let drivingProvider: () => number[] = () => [];

// --------------------------------------------------------------------- 小工具

function guardDir(): string {
  return path.join(app.getPath('userData'), DIR_NAME);
}

function ensureDir(): string {
  const dir = guardDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[resources] 建目录失败：', (error as Error).message);
  }
  return dir;
}

function dayStamp(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function appendLine(file: string, record: unknown): void {
  try {
    ensureDir();
    appendFileSync(path.join(guardDir(), file), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    // 落盘失败不该影响采集与提示：内存里那份仍然可用，只是重启后查不到这段
    console.warn(`[resources] 写 ${file} 失败：`, (error as Error).message);
  }
}

/** 启动时清掉过期文件（保留 KEEP_DAYS 天）。读不动/删不掉都只告警，不抛。 */
function pruneOldFiles(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of readdirSync(guardDir())) {
      const m = /^(samples|raw)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      const at = new Date(`${m[2]}-${m[3]}-${m[4]}T00:00:00`).getTime();
      if (Number.isFinite(at) && at < cutoff) unlinkSync(path.join(guardDir(), name));
    }
  } catch {
    /* 目录还不存在 / 文件被占用：下次启动再清 */
  }
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function thresholdsOf(): ResourceThresholds {
  const s = getSettings();
  return {
    memHealthMB: s.resourceMemHealthMB,
    memWarnMB: s.resourceMemWarnMB,
    cpuHealthPct: s.resourceCpuHealthPct,
    cpuWarnPct: s.resourceCpuWarnPct,
    sysMemGuard: s.resourceSysMemGuard,
    sysMemFloorMB: s.resourceSysMemFloorMB,
  };
}

// ------------------------------------------------------------------- 采集本体

/**
 * 采一次：本应用**全部进程**的内存 / CPU。
 *
 * 数据源是主进程自己的 `app.getAppMetrics()`（Electron 官方接口）：
 *   - 覆盖 Browser(主) / GPU / Utility / Tab(每个渲染进程，含每个 guest webview)；
 *   - `memory.workingSetSize` 单位是 **KB**；
 *   - `cpu.percentCPUUsage` = 距上次调用之间的平均占用（首次调用接近 0，属正常），
 *     **已经除过逻辑核数**，所以它本身就是"占整机"的百分比（详见文件头口径说明）。
 */
function collect(): ResourceSample {
  const metrics = app.getAppMetrics();
  const logicalCores = Math.max(1, os.cpus().length);
  const procs: ResourceProcInfo[] = metrics.map((m) => ({
    pid: m.pid,
    type: String(m.type),
    name: m.name ? String(m.name) : undefined,
    memMB: round((m.memory?.workingSetSize ?? 0) / 1024, 1),
    cpuPct: round(m.cpu?.percentCPUUsage ?? 0, 2),
  }));
  const memMB = round(
    procs.reduce((sum, p) => sum + p.memMB, 0),
    1,
  );
  const cpuPct = round(
    procs.reduce((sum, p) => sum + p.cpuPct, 0),
    2,
  );
  const s = getSettings();
  const sysFreeMB =
    s.resourceSysMemGuard === 1 ? Math.round(os.freemem() / 1048576) : null;
  const at = Date.now();
  return {
    at,
    atIso: new Date(at).toISOString(),
    memMB,
    cpuPct,
    cpuCoresUsed: round((cpuPct / 100) * logicalCores, 2),
    logicalCores,
    procCount: procs.length,
    procs,
    sysFreeMB,
    sysTotalMB: Math.round(os.totalmem() / 1048576),
    level: 'ok', // 由 evaluate() 填
    reasons: [],
  };
}

/** 阈值判定（纯函数，方便复核）：只判"这一点是不是越线 / 在灰区"，去抖在 evaluate 里做 */
function judge(sample: ResourceSample, t: ResourceThresholds): ResourceReason[] {
  const reasons: ResourceReason[] = [];
  if (sample.memMB >= t.memWarnMB) reasons.push('mem');
  if (sample.cpuPct >= t.cpuWarnPct) reasons.push('cpu');
  // 兜底信号默认关（配置里开）；关着的时候 sysFreeMB 恒为 null，这里自然判不到
  if (t.sysMemGuard === 1 && sample.sysFreeMB !== null && sample.sysFreeMB <= t.sysMemFloorMB) {
    reasons.push('sys-mem');
  }
  return reasons;
}

function isElevated(sample: ResourceSample, t: ResourceThresholds): boolean {
  return sample.memMB >= t.memHealthMB || sample.cpuPct >= t.cpuHealthPct;
}

/**
 * 一次采样进来：判定档位（带去抖 + 滞回 + 冷却），必要时发一次提示。
 *
 * 三个刻意的设计：
 *   - **去抖**：连续 3 点越线才算数 —— 一次瞬时毛刺不该打扰用户；
 *   - **滞回**：解除警戒也要连续 3 点回到线下 —— 否则在阈值附近来回抖会反复提示；
 *   - **冷却**：一次提示之后 5 分钟内不再重复（"触发一次提示"，不是每 5 秒喊一遍）。
 *
 * `sample.level` 记的是**去抖后所属的档位**（与 snapshot.level 同一口径）；
 * `sample.reasons` 记的是**这一点自己**有没有越线 —— 所以会出现
 * 「reasons 非空但 level=ok」的点，那正是"单点毛刺、还没到连续 3 点"的如实记录。
 */
function evaluate(sample: ResourceSample): ResourceLevel {
  const t = thresholdsOf();
  const reasons = judge(sample, t);

  if (reasons.length > 0) {
    state.overStreak += 1;
    state.underStreak = 0;
  } else {
    state.underStreak += 1;
    state.overStreak = 0;
  }

  let fired = false;
  if (state.level === 'warning') {
    if (state.underStreak >= UNDER_STREAK_TO_CLEAR) {
      // 先判"是否需要解除"，再判"要不要再提醒一次" —— 顺序反了会在恢复那一刻误报。
      state.level = 'ok';
    } else if (
      reasons.length > 0 &&
      state.lastAlertAt !== null &&
      Date.now() - state.lastAlertAt >= ALERT_COOLDOWN_MS
    ) {
      // ⚠️ `reasons.length > 0` 这一条是必须的（自检时抓到的真 bug）：
      // 警戒态要连续 3 个点回到线下才解除，所以"刚回落 1~2 个点"时 level 仍是 warning，
      // 而此刻 reasons 为空。若这里不拦，冷却一到就会发一条**没有任何越线理由**的提示，
      // 文案会退化成"资源占用偏高：。"+ 一串空闲页 —— 用户被叫去看一个其实已经正常的指标。
      // 提示必须能指认一个真实理由，否则不如不发。
      fired = true;
    }
  } else if (state.overStreak >= OVER_STREAK_TO_TRIGGER) {
    state.level = 'warning';
    fired = true;
  }

  sample.reasons = reasons;
  // 非警戒态下再细分为「灰区 elevated / 健康 ok」：灰区只记录、不提示，
  // 但后续 UI 阶段可以据此点一盏黄灯（本阶段不做样式）。
  if (state.level !== 'warning') state.level = isElevated(sample, t) ? 'elevated' : 'ok';
  sample.level = state.level;
  if (fired) fireAlert(sample, reasons, t);
  return sample.level;
}

/** 拼「最久未使用」排序：按 lastActiveAt 升序；**正在跑任务的不剔除，只标记** */
function idleRanking(): BrowserInstanceInfo[] {
  syncDrivingFlags(drivingProvider());
  const now = Date.now();
  const list = [...state.instances.values()].map((it) => ({
    ...it,
    // 正在被驾驶的页"此刻就是在用"，参与排序时也按现在算（同时打上 driving 标记）
    lastActiveAt: it.driving ? now : it.lastActiveAt,
  }));
  list.sort((a, b) => a.lastActiveAt - b.lastActiveAt || a.wcId - b.wcId);
  return list;
}

function humanAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

/** 人话文案（本阶段直接复用既有单行提示通道；正式样式留给 UI 阶段） */
function alertText(sample: ResourceSample, reasons: ResourceReason[], ranking: BrowserInstanceInfo[]): string {
  const bits: string[] = [];
  if (reasons.includes('mem')) bits.push(`内存 ${(sample.memMB / 1024).toFixed(2)} GB`);
  if (reasons.includes('cpu')) bits.push(`CPU 占整机 ${sample.cpuPct}%（约 ${sample.cpuCoresUsed}/${sample.logicalCores} 核）`);
  if (reasons.includes('sys-mem')) bits.push(`系统可用内存只剩 ${((sample.sysFreeMB ?? 0) / 1024).toFixed(2)} GB`);
  const head = `资源占用偏高：${bits.join('、')}。`;
  const tail =
    ranking.length > 0
      ? `以下是最久未使用的浏览器（共 ${ranking.length} 个，越靠前越久没用）：` +
        ranking
          .map((it, i) => {
            // 措辞刻意是「有未结束的任务」而不是「正在跑」：暂停/等答复的页也还没结束，
            // 把它说成空闲会诱导用户关掉一个还有下文的任务。
            const tag = it.driving ? '⚠️ 有未结束的任务，别关' : '空闲';
            return `\n${i + 1}. ${it.title || it.url}（${humanAgo(Date.now() - it.lastActiveAt)}，${tag}）`;
          })
          .join('')
      : '当前没有打开的浏览器实例。';
  return `${head}\n${tail}\n（只是提示，不拦你继续开新页，也不会自动关掉任何一个。）`;
}

function fireAlert(sample: ResourceSample, reasons: ResourceReason[], t: ResourceThresholds): void {
  const ranking = idleRanking();
  const at = Date.now();
  const alert: ResourceAlert = {
    id: `ra-${at}-${Math.floor(Math.random() * 1000)}`,
    at,
    atIso: new Date(at).toISOString(),
    level: 'warning',
    sample,
    reasons,
    thresholds: t,
    idleRanking: ranking,
    text: alertText(sample, reasons, ranking),
  };
  state.lastAlertAt = at;
  state.events.push(alert);
  if (state.events.length > EVENT_RING) state.events.shift();
  appendLine('events.jsonl', alert);
  broadcast('workbench:browser:resources', JSON.stringify(alert));
  console.log(`[resources] 触发警戒提示（${reasons.join('+')}）：内存 ${sample.memMB}MB / CPU ${sample.cpuPct}%`);
}

// ------------------------------------------------------------------- 落盘汇总

function accumulate(sample: ResourceSample): void {
  const windowAt = Math.floor(sample.at / AGGREGATE_WINDOW_MS) * AGGREGATE_WINDOW_MS;
  if (state.currentWindowAt === 0) state.currentWindowAt = windowAt;
  if (windowAt !== state.currentWindowAt) {
    flushWindow();
    state.currentWindowAt = windowAt;
  }
  state.windowSamples.push(sample);
  if (RAW_ENABLED) appendLine(`raw-${dayStamp(sample.at)}.jsonl`, sample);
}

function flushWindow(): void {
  const list = state.windowSamples;
  state.windowSamples = [];
  if (list.length === 0 || state.currentWindowAt === 0) return;
  const agg: ResourceAggregate = {
    windowAt: state.currentWindowAt,
    windowAtIso: new Date(state.currentWindowAt).toISOString(),
    count: list.length,
    memAvgMB: round(list.reduce((s, x) => s + x.memMB, 0) / list.length, 1),
    memMaxMB: Math.max(...list.map((x) => x.memMB)),
    cpuAvgPct: round(list.reduce((s, x) => s + x.cpuPct, 0) / list.length, 2),
    cpuMaxPct: Math.max(...list.map((x) => x.cpuPct)),
    maxLevel: list.some((x) => x.level === 'warning')
      ? 'warning'
      : list.some((x) => x.level === 'elevated')
        ? 'elevated'
        : 'ok',
  };
  appendLine(`samples-${dayStamp(agg.windowAt)}.jsonl`, agg);
}

// --------------------------------------------------------------------- 调度

function applySchedule(): void {
  const s = getSettings();
  const enabled = s.resourceGuardEnabled === 1;
  const ms = Math.max(1000, s.resourceSampleMs);

  if (state.timer && (!enabled || ms !== state.scheduledMs)) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (!enabled) {
    if (state.started) flushWindow();
    state.scheduledMs = 0;
    return;
  }
  if (!state.timer) {
    state.scheduledMs = ms;
    state.timer = setInterval(tick, ms);
    // unref：这个定时器不该拖住进程退出（Electron 关窗即退出的行为不能变）
    state.timer.unref?.();
    tick(); // 立刻先采一次，别让 UI 等一个完整周期才有数
  }
}

function tick(): void {
  try {
    const sample = collect();
    evaluate(sample);
    state.ring.push(sample);
    if (state.ring.length > RING_CAPACITY) state.ring.shift();
    accumulate(sample);
  } catch (error) {
    // 监控自己绝不能把应用搞崩：采失败就跳过这一点
    console.warn('[resources] 采集失败：', (error as Error).message);
  }
}

// --------------------------------------------------------------------- 对外

/** 渲染层上报浏览器实例清单（只在变化时发；主进程据此算「最久未使用」排序） */
export function setBrowserInstances(raw: unknown): void {
  const list = Array.isArray(raw) ? (raw as BrowserInstanceInfo[]) : [];
  const next = new Map<number, BrowserInstanceInfo>();
  for (const it of list) {
    const wcId = Number(it?.wcId);
    if (!Number.isInteger(wcId) || wcId < 0) continue;
    next.set(wcId, {
      wcId,
      agentId: Number(it.agentId) || 0,
      projectId: it.projectId === null || it.projectId === undefined ? null : Number(it.projectId),
      title: String(it.title ?? ''),
      url: String(it.url ?? ''),
      createdAt: Number(it.createdAt) || Date.now(),
      lastActiveAt: Number(it.lastActiveAt) || Date.now(),
      driving: Boolean(it.driving),
    });
  }
  state.instances = next;
}

/**
 * 主进程自己知道「哪几张页正在被驾驶」—— 以它为准覆盖渲染层报上来的标记。
 *
 * 为什么不让渲染层说了算：驾驶状态的权威在 driver/lanes 那边（渲染层只是镜像）。
 * 提示里"别关这个"的说法必须站得住，否则用户照着列表关掉正在干活的页就完了。
 */
export function syncDrivingFlags(activeWcIds: number[]): void {
  const live = new Set(activeWcIds.map((x) => Number(x)).filter((x) => Number.isInteger(x)));
  // 先把差异算完再写回：一边遍历 Map 一边 set 虽然对"改已有键"是安全的，
  // 但这属于"靠语言细节成立"的写法，读的人不该需要先确认一遍 Map 的迭代语义。
  const fixes: Array<[number, BrowserInstanceInfo]> = [];
  for (const [wcId, it] of state.instances) {
    if (live.has(wcId) !== it.driving) fixes.push([wcId, { ...it, driving: live.has(wcId) }]);
  }
  for (const [wcId, it] of fixes) state.instances.set(wcId, it);
}

export function resourceSnapshot(): ResourceGuardSnapshot {
  const s = getSettings();
  const t = thresholdsOf();
  return {
    enabled: s.resourceGuardEnabled === 1,
    sampleMs: Math.max(1000, s.resourceSampleMs),
    // 主进程自己的 pid：把"监控自身的开销"单独量出来要用它（验收标准③）
    mainPid: process.pid,
    level: state.level,
    sample: state.ring.length > 0 ? state.ring[state.ring.length - 1] : null,
    thresholds: t,
    overStreak: state.overStreak,
    underStreak: state.underStreak,
    lastAlertAt: state.lastAlertAt,
    cooldownMs: ALERT_COOLDOWN_MS,
    dir: guardDir(),
    buffered: state.ring.length,
  };
}

/** 内存环形缓冲（5s 原始点）—— 供"立刻看趋势" */
export function resourceRecent(limit = RING_CAPACITY): ResourceSample[] {
  return state.ring.slice(-Math.max(1, Math.min(RING_CAPACITY, limit)));
}

/**
 * 历史汇总点（给"事后查询"用）。
 *
 * 数据源**只有盘上的 60s 汇总**：内存里那份是 5s 原始点（另一个时间尺度），
 * 拿它冒充汇总会给出不同口径的数字 —— 宁可为空，也不混口径。
 * 目录还不存在 / 一行都没落盘时返回 `[]`，调用方据此判断"还没攒够"。
 */
export function resourceHistory(minutes = 60): ResourceAggregate[] {
  const since = Date.now() - Math.max(1, minutes) * 60_000;
  const out: ResourceAggregate[] = [];
  try {
    const files = readdirSync(guardDir())
      .filter((n) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort();
    for (const f of files) {
      const text = readFileSync(path.join(guardDir(), f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const agg = JSON.parse(line) as ResourceAggregate;
          if (agg.windowAt >= since) out.push(agg);
        } catch {
          /* 半行/坏行跳过 */
        }
      }
    }
  } catch {
    /* 目录不存在 / 文件读不动：返回空数组，不假装有数据 */
  }
  return out.sort((a, b) => a.windowAt - b.windowAt);
}

/** 历史警戒事件：同样优先从盘上读 */
export function resourceEvents(limit = 20): ResourceAlert[] {
  const n = Math.max(1, Math.min(200, limit));
  try {
    const text = readFileSync(path.join(guardDir(), 'events.jsonl'), 'utf8');
    const rows = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ResourceAlert;
        } catch {
          return null;
        }
      })
      .filter((x): x is ResourceAlert => Boolean(x));
    if (rows.length > 0) return rows.slice(-n);
  } catch {
    /* 还没触发过提示 / 文件不存在：走内存兜底 */
  }
  return state.events.slice(-n);
}

/**
 * 注册 IPC 并起调度。由 main.ts 在 whenReady 里调一次。
 * @param send 主进程 → 渲染层广播口（main.ts 的 sendToMainWindow）
 * @param getDriving 当前正在被驾驶的 guest id（main.ts 的 lanes + 挂起目标）
 */
export function initResourceGuard(
  send: (channel: string, payload?: unknown) => void,
  getDriving: () => number[] = () => [],
): void {
  broadcast = send;
  drivingProvider = getDriving;
  if (state.started) return;
  state.started = true;
  ensureDir();
  pruneOldFiles();

  ipcMain.handle('workbench:resources:snapshot', () => resourceSnapshot());
  ipcMain.handle('workbench:resources:history', (_e: IpcMainInvokeEvent, minutes?: unknown) =>
    resourceHistory(Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Number(minutes) : 60),
  );
  ipcMain.handle('workbench:resources:events', (_e: IpcMainInvokeEvent, limit?: unknown) =>
    resourceEvents(Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20),
  );
  ipcMain.handle('workbench:resources:instances', (_e: IpcMainInvokeEvent, list: unknown) => {
    setBrowserInstances(list);
  });

  // 配置一变（开关 / 频率 / 阈值）立刻生效：不用重启，也不用重建 hook
  onSettingsChange(() => applySchedule());
  applySchedule();
  console.log(`[resources] 资源守护者已就绪（间隔 ${state.scheduledMs}ms，目录 ${guardDir()}）`);
}
