#!/usr/bin/env node
/**
 * Phase 4：资源守护者落盘数据的**只读**查询入口。
 *
 * 为什么要有它：监控采到的数据必须「有一个地方能查到」——
 *   - 后续 UI 阶段做提示界面时走的是同名 IPC（`workbench:resources:*`）；
 *   - 但排查、运维、以及"不启动应用也要看历史"的场景，需要一条不经过 UI 的路：
 *     直接读 `<userData>/resource-guard/` 下那份 jsonl。
 *
 * 它**只读**（只 open + read，不写不删），也**不起 Electron**。
 *
 * 用法：
 *   node scripts/verify/resource-query.mjs <userData目录> [--minutes 30] [--events 10] [--raw 20]
 *
 * userData 目录就是应用的数据目录，Windows 下通常是：
 *   %APPDATA%\AI 工作台        （打包版）
 *   验收时的临时 profile        （见 4-resource-guard-tests.py 的 --user-data-dir）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};

if (!dir) {
  console.error('用法：node scripts/verify/resource-query.mjs <userData目录> [--minutes 30] [--events 10] [--raw 20]');
  process.exit(2);
}

const guardDir = path.join(dir, 'resource-guard');
if (!existsSync(guardDir)) {
  console.error(`没有找到 ${guardDir} —— 目录不对，或者这一版还没跑过资源守护者。`);
  process.exit(1);
}

const minutes = flag('minutes', 60);
const eventLimit = flag('events', 10);
const rawLimit = flag('raw', 0);
const since = Date.now() - minutes * 60_000;

const readLines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const files = readdirSync(guardDir).sort();
const aggFiles = files.filter((n) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
const rawFiles = files.filter((n) => /^raw-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));

// ---- 60s 汇总点 ----
const aggs = aggFiles.flatMap((f) => readLines(path.join(guardDir, f))).filter((a) => a.windowAt >= since);
console.log(`# 目录：${guardDir}`);
console.log(`# 最近 ${minutes} 分钟内：汇总点 ${aggs.length} 个 / 文件 ${aggFiles.length} 个` +
  `${rawFiles.length ? `（另有原始采样文件 ${rawFiles.length} 个）` : ''}`);
if (aggs.length) {
  console.log('\n时间                 点数  内存 avg/max (MB)      CPU avg/max (%)   最高档位');
  for (const a of aggs.slice(-40)) {
    console.log(
      `${new Date(a.windowAt).toISOString()}  ${String(a.count).padStart(3)}   ` +
        `${String(a.memAvgMB).padStart(8)} /${String(a.memMaxMB).padStart(8)}   ` +
        `${String(a.cpuAvgPct).padStart(6)} /${String(a.cpuMaxPct).padStart(6)}   ${a.maxLevel}`,
    );
  }
} else {
  console.log('（这个时间窗内没有汇总点：可能监控刚开，或还没跑满一个 60s 窗口）');
}

// ---- 警戒提示事件 ----
const evFile = path.join(guardDir, 'events.jsonl');
const events = existsSync(evFile) ? readLines(evFile).filter((e) => e.at >= since) : [];
console.log(`\n# 警戒提示事件：${events.length} 条（展示最后 ${eventLimit} 条）`);
for (const e of events.slice(-eventLimit)) {
  console.log(`\n[${new Date(e.at).toISOString()}] 原因=${(e.reasons || []).join('+')} ` +
    `内存=${e.sample?.memMB}MB CPU=${e.sample?.cpuPct}%`);
  console.log(`  阈值：内存 ${e.thresholds?.memHealthMB}/${e.thresholds?.memWarnMB}MB · ` +
    `CPU ${e.thresholds?.cpuHealthPct}/${e.thresholds?.cpuWarnPct}%`);
  for (const [i, it] of (e.idleRanking || []).entries()) {
    const ago = Math.round((e.at - it.lastActiveAt) / 1000);
    console.log(`   ${i + 1}. wc=${it.wcId} agent=${it.agentId} ${it.driving ? '⚠️ 有未结束的任务' : '空闲'} ` +
      `最后使用 ${ago}s 前 :: ${it.title || it.url}`);
  }
}

// ---- 原始 5s 采样（可选；默认不落盘，只有 WB_RESOURCE_GUARD_RAW=1 时才有） ----
if (rawLimit > 0 && rawFiles.length) {
  const raw = rawFiles.flatMap((f) => readLines(path.join(guardDir, f))).filter((r) => r.at >= since);
  console.log(`\n# 原始采样（最后 ${rawLimit} 条，共 ${raw.length} 条）`);
  for (const r of raw.slice(-rawLimit)) {
    console.log(`${r.atIso}  内存 ${r.memMB}MB  CPU ${r.cpuPct}%（单核口径 ${r.cpuCorePct}% / ${r.logicalCores} 核）` +
      `  进程 ${r.procCount}  档位 ${r.level}${r.reasons?.length ? ' [' + r.reasons.join('+') + ']' : ''}`);
  }
}
