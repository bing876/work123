/**
 * Phase 3 · 分区目录快照（只读）
 *
 * 用法：node scripts/verify/partitions-snapshot.mjs <profile 目录> [输出 json 路径]
 *
 * 快照内容（只读，不改任何文件）：
 *   - <profile>/Partitions/ 下每个子目录：名字、归属类型（agent / project / 旧版全局 / 其它）、
 *     解析出的 id、体积、最后修改时间、内含条目数；
 *   - <profile>/browser-agents/ 与 browser-projects/ 下的下载目录树（文件数、体积、文件清单）；
 *   - 下载记录 browser-projects/_downloads.jsonl（若存在）逐行回读。
 *
 * 用途：Phase 3「登录态隔离粒度 从 agentId 改 projectId」的改造前后对照证据。
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const profile = process.argv[2];
if (!profile) {
  console.error('用法：node scripts/verify/partitions-snapshot.mjs <profile 目录> [输出 json]');
  process.exit(2);
}

/**
 * 分区目录名 → 归属解析。
 * ⚠️ 落盘的目录名**不带** `persist:` 前缀（Electron 会剥掉），所以前缀做成可选。
 */
function classify(rawName) {
  const name = rawName.replace(/^persist:/, '');
  let m = /^workbench-browser-project-(\d+|none)$/.exec(name);
  if (m) return { kind: 'project', id: m[1] === 'none' ? null : Number(m[1]), legacy: false };
  m = /^workbench-browser-agent-(\d+)$/.exec(name);
  if (m) return { kind: 'agent', id: Number(m[1]), legacy: true };
  if (name === 'workbench-browser') return { kind: 'global-legacy', id: null, legacy: true };
  return { kind: 'other', id: null, legacy: false };
}

/** 递归统计体积与条目数（深度封顶 6，避免异常目录拖死） */
function walk(dir, depth = 0) {
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  if (depth > 6) return { bytes, files, dirs };
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files, dirs };
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      dirs += 1;
      const sub = walk(p, depth + 1);
      bytes += sub.bytes;
      files += sub.files;
      dirs += sub.dirs;
    } else {
      files += 1;
      try {
        bytes += statSync(p).size;
      } catch {
        /* 忽略读不到的 */
      }
    }
  }
  return { bytes, files, dirs };
}

function mtimeOf(p) {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const p = join(dir, e.name);
      const isDir = e.isDirectory();
      const out = {
        name: e.name,
        isDir,
        mtime: mtimeOf(p),
        size: isDir ? null : statSync(p).size,
        ...(isDir ? walk(p) : {}),
      };
      return out;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const partitionsDir = join(profile, 'Partitions');
const partitions = existsSync(partitionsDir)
  ? readdirSync(partitionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = join(partitionsDir, e.name);
        const c = classify(e.name);
        return {
          dirName: e.name,
          kind: c.kind,
          id: c.id,
          legacy: c.legacy,
          mtime: mtimeOf(p),
          ...walk(p),
        };
      })
      .sort((a, b) => a.dirName.localeCompare(b.dirName))
  : [];

const downloadsLogPath = join(profile, 'browser-projects', '_downloads.jsonl');
let downloadRecords = [];
if (existsSync(downloadsLogPath)) {
  downloadRecords = readFileSync(downloadsLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

const snapshot = {
  profile,
  takenAt: new Date().toISOString(),
  partitionsDirExists: existsSync(partitionsDir),
  partitions,
  /** 旧命名（按智能体）的下载目录 */
  browserAgentsDir: listDir(join(profile, 'browser-agents')),
  /** 新命名（按项目）的下载目录 */
  browserProjectsDir: listDir(join(profile, 'browser-projects')),
  downloadRecords,
  summary: {
    total: partitions.length,
    byKind: partitions.reduce((acc, p) => {
      acc[p.kind] = (acc[p.kind] ?? 0) + 1;
      return acc;
    }, {}),
    agentPartitionIds: partitions.filter((p) => p.kind === 'agent').map((p) => p.id).sort((a, b) => a - b),
    projectPartitionIds: partitions.filter((p) => p.kind === 'project').map((p) => p.id).sort((a, b) => a - b),
  },
};

const text = JSON.stringify(snapshot, null, 2);
const out = process.argv[3];
if (out) {
  writeFileSync(out, text + '\n', 'utf8');
  console.log(`已写入 ${out}`);
} else {
  console.log(text);
}
