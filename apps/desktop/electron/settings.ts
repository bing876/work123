import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SETTINGS_RANGE,
  type WorkbenchSettings,
} from '@ai-workbench/shared';

/**
 * 第 22 步（浏览器多实例融合）：**可调配置**的权威副本 —— 就在主进程这一份。
 *
 * 为什么权威副本放主进程、而不是渲染层的 localStorage：
 *   - 两个配置的**执行点一个在主进程、一个在渲染层**（并发数挡在 agentStart 上，
 *     实例上限要在开页时判），放 localStorage 就得两边各存一份、还会对不齐；
 *   - 落盘成 userData 下的一个 JSON，**用户手改也能生效**（重启后读到），
 *     这才是「不写死在代码里、可在设置里调整」的完整含义。
 *
 * 渲染层不直接读文件：走 IPC 的 getSettings / setSettings，并跟随 'settings' 广播。
 *
 * ⚠️ 与 driver.ts 的 TaskState 不同：**配置本来就该是全局唯一的一份**，
 *    这里不做 per-target。A1.5 要求按 target 独立的是**驾驶状态**，不是配置。
 */

const SETTINGS_FILE = 'workbench-settings.json';

/** 内存缓存（权威副本的运行时形态）；null = 还没读过盘 */
let cache: WorkbenchSettings | null = null;

/** 变更订阅者（main.ts 用来向渲染层广播） */
const listeners = new Set<(s: WorkbenchSettings) => void>();

function filePath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

/** 把单个数值夹到合法区间；不是有限数就回默认值（手改 JSON 改坏了也不至于把功能锁死） */
function clampValue(key: keyof WorkbenchSettings, raw: unknown): number {
  const range = SETTINGS_RANGE[key];
  const fallback = DEFAULT_SETTINGS[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

/**
 * 任意输入 → 一份**完整且合法**的配置（缺字段补默认、越界夹回来）
 *
 * ⚠️ **每个字段都必须在这里显式列一遍** —— 这就是子阶段 A 那次「新旧默认值合并」的做法：
 * 老版本落盘的 `workbench-settings.json` 里没有新字段，`clampValue` 会给它回落到
 * `DEFAULT_SETTINGS`，于是**老文件 + 新代码 = 新字段拿到默认值**。
 * 反过来，如果偷懒写成 `{...DEFAULT_SETTINGS, ...src}`，旧文件里那些**被夹过**的字段
 * 会盖住新默认值（子阶段 A 真踩过：改默认值不生效，因为磁盘上的老值说了算）。
 *
 * Phase 4 新加的 8 个资源字段走的就是这条路：**用户不手改，也会自动拿到本阶段定案的默认值**，
 * 不需要写迁移脚本、也不需要等"测出问题再回头补"。
 */
export function normalizeSettings(raw: unknown): WorkbenchSettings {
  const src = (raw ?? {}) as Partial<Record<keyof WorkbenchSettings, unknown>>;
  return {
    maxConcurrentAgentTasks: clampValue('maxConcurrentAgentTasks', src.maxConcurrentAgentTasks),
    maxBrowserInstances: clampValue('maxBrowserInstances', src.maxBrowserInstances),
    // Phase 4：资源守护者（阈值 / 频率 / 开关）
    resourceGuardEnabled: clampValue('resourceGuardEnabled', src.resourceGuardEnabled),
    resourceSampleMs: clampValue('resourceSampleMs', src.resourceSampleMs),
    resourceMemHealthMB: clampValue('resourceMemHealthMB', src.resourceMemHealthMB),
    resourceMemWarnMB: clampValue('resourceMemWarnMB', src.resourceMemWarnMB),
    resourceCpuHealthPct: clampValue('resourceCpuHealthPct', src.resourceCpuHealthPct),
    resourceCpuWarnPct: clampValue('resourceCpuWarnPct', src.resourceCpuWarnPct),
    resourceSysMemGuard: clampValue('resourceSysMemGuard', src.resourceSysMemGuard),
    resourceSysMemFloorMB: clampValue('resourceSysMemFloorMB', src.resourceSysMemFloorMB),
  };
}

function load(): WorkbenchSettings {
  if (cache) return cache;
  try {
    const text = readFileSync(filePath(), 'utf8');
    cache = normalizeSettings(JSON.parse(text));
  } catch {
    // 文件不存在 / 读不动 / JSON 坏了：一律回默认值，**不抛错**（配置不该拖垮启动）
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

function persist(next: WorkbenchSettings): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(filePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    // 落盘失败不该让「改配置」这一步失败：内存里已经生效，只是下次启动会回到旧值
    console.warn('[settings] 写入配置失败（内存里已生效）：', (err as Error).message);
  }
}

/** 读当前配置（渲染层挂载时同步一次） */
export function getSettings(): WorkbenchSettings {
  return { ...load() };
}

/**
 * 改配置：只传要改的字段即可。
 * 夹到合法区间 → 更新内存 → 落盘 → 广播（订阅者拿到的是一份快照副本）。
 */
export function setSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings {
  const next = normalizeSettings({ ...load(), ...patch });
  cache = next;
  persist(next);
  const snapshot = { ...next };
  for (const fn of listeners) fn(snapshot);
  return snapshot;
}

/** 主进程内部订阅变更（main.ts 用它向渲染层广播 'settings'） */
export function onSettingsChange(fn: (s: WorkbenchSettings) => void): void {
  listeners.add(fn);
}
