/**
 * 子阶段 2-A 取证：**知识库 project_id 数据迁移的「迁移前 / 迁移后」对照**。
 *
 * 为什么要单独造一个库跑：
 *   活库（workbench）在开发过程中**已经跑过一次**本迁移（列早就存在、也已经有项目归属了），
 *   直接拿活库对比等于「迁移后 vs 迁移后」，证明不了什么。所以这里：
 *     1) 新建一个**只在验收期存在**的库 `workbench_2a_check`；
 *     2) 用 **「加新列之前那个提交」的真实 DDL** 建出「迁移前」的结构（没有 can_create_agents /
 *        current_project_id 这几列）—— 这是从 git 里取出来的原文，不是手写的近似版。
 *        ⚠️ 不能再写死 `HEAD`：2-A 一旦提交进历史，`HEAD` 就变成「改动后」了，
 *        「迁移前」结构会天然带着新列 → 对照退化成「迁移后 vs 迁移后」。
 *        现在是**自动回溯**（从 HEAD 往回找第一个 db.ts 里不含新列的提交），可用
 *        `MIGRATE_BASE_COMMIT=<sha>` 覆盖；脚本会把选中的提交写进证据 JSON；
 *     3) 把**活库的真实数据**按旧结构整表搬进去（列清单里天然不含新列 = 迁移前的真实状态）；
 *     4) 记录「迁移前」行数与内容摘要 → 调**构建产物 dist/db.js 里真正的 migrate()** → 记录「迁移后」；
 *     5) 对照：行数一致、内容摘要一致（正文一个字节没动）、每条都拿到归属、NOT NULL 收紧、二次执行零改动。
 *
 * 用法：
 *   node scripts/verify/2a-migrate-replay.mjs                    # 跑完删掉验收库
 *   node scripts/verify/2a-migrate-replay.mjs --keep             # 保留验收库（排查用）
 *   node scripts/verify/2a-migrate-replay.mjs --out <file.json>  # 另存证据 JSON
 *
 * 只读活库（只有 SELECT），活库不会被写：所有写操作都发生在 workbench_2a_check 里。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const CHECK_DB = 'workbench_2a_check';
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : resolve(repo, 'docs/acceptance/substage-2a/db-migration-replay.json');

function envValue(key) {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const LIVE_URL = envValue('DATABASE_URL');
const CHECK_URL = LIVE_URL.replace(/\/([^/?]+)(\?|$)/, `/${CHECK_DB}$2`);

const { Client } = require('pg');
const { migrate } = require(resolve(repo, 'apps/server/dist/db.js'));

/** 旧结构（HEAD）的表 + 列清单。列清单里**故意不含** 2-A 新增的列。 */
const TABLES = {
  users: ['id', 'xyz_id', 'phone_hash', 'phone_enc', 'password_hash', 'wechat_openid', 'wechat_unionid', 'created_at'],
  projects: ['id', 'user_id', 'name', 'is_default', 'created_at'],
  agents: ['id', 'project_id', 'name', 'kind', 'created_at', 'persona', 'persona_status'],
  conversations: ['id', 'project_id', 'agent_id', 'title', 'created_at'],
  messages: ['id', 'conversation_id', 'role', 'content_enc', 'created_at'],
  tasks: ['id', 'project_id', 'status', 'title', 'payload', 'unread', 'result_enc', 'created_at', 'updated_at'],
  memories: ['id', 'project_id', 'agent_id', 'mem_key', 'value_enc', 'owner_id', 'type', 'content_encrypted', 'source', 'status', 'needs_confirm', 'updated_at', 'created_at'],
  user_memories: ['id', 'owner_id', 'mem_key', 'content_enc', 'source', 'created_at', 'updated_at'],
  agent_memories: ['id', 'owner_id', 'agent_id', 'mem_key', 'content_enc', 'source', 'created_at', 'updated_at'],
  knowledge_documents: ['id', 'owner_id', 'filename_enc', 'file_kind', 'byte_size', 'chunk_count', 'created_at'],
  knowledge_chunks: ['id', 'document_id', 'owner_id', 'chunk_index', 'content_enc', 'created_at'],
};

/** conversations 的会话状态列（第 16 步补的），旧结构里也有，一并搬 */
const CONV_EXTRA = ['current_task', 'latest_user_intent', 'browser_confirmed', 'login_required', 'sensitive_action', 'last_page_summary', 'already_told_user_login_themselves', 'keepalive', 'state_updated_at'];
TABLES.conversations.push(...CONV_EXTRA);

const NEW_COLUMNS = {
  users: ['current_project_id'],
  agents: ['can_create_agents'],
  knowledge_documents: ['project_id'],
  knowledge_chunks: ['project_id'],
};

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function connect(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function counts(client) {
  const out = {};
  for (const t of Object.keys(TABLES)) {
    out[t] = Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  }
  return out;
}

async function columnPresence(client) {
  const out = {};
  for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
    out[table] = {};
    for (const col of cols) {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
        [table, col],
      );
      out[table][col] = Number(r.rows[0].n) > 0;
    }
  }
  return out;
}

async function nullability(client, table, col) {
  const r = await client.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, col],
  );
  return r.rowCount === 1 ? r.rows[0].is_nullable : null;
}

/**
 * 知识库「内容摘要」：把两表里**除 project_id 之外**的全部内容按 id 排序拼起来做哈希。
 * 迁移前后哈希一致 = 正文/文件名/段序一条都没被动过（不只是行数没变）。
 */
/**
 * 内容指纹。**故意不含 `created_at`**：那是「往一次性验收库里插入的时刻」，每轮都不一样，
 * 带上它摘要就跨轮不可复现（同一个库内容相同、摘要却变），没法当「内容没动」的跨轮证据。
 * 写入时刻是否被迁移改动，另外用 `rowStampDigest()` 做**同一轮内**的前后对比。
 */
async function contentDigest(client) {
  const d = await client.query(
    `SELECT id, owner_id, filename_enc, file_kind, byte_size, chunk_count
       FROM knowledge_documents ORDER BY id`,
  );
  const c = await client.query(
    `SELECT id, document_id, owner_id, chunk_index, content_enc
       FROM knowledge_chunks ORDER BY id`,
  );
  const docText = d.rows.map((r) => JSON.stringify(r)).join('\n');
  const chunkText = c.rows.map((r) => JSON.stringify(r)).join('\n');
  return {
    documents: d.rows.length,
    chunks: c.rows.length,
    documentDigest: sha256(docText),
    chunkDigest: sha256(chunkText),
    contentBytesEnc: chunkText.length,
  };
}

/** 整数时间戳 + id 的「行戳」，只用于**同一轮内**前后对比（值本身每轮不同，别跨轮比）。 */
async function rowStampDigest(client) {
  const d = await client.query(`SELECT id, created_at::text AS ts FROM knowledge_documents ORDER BY id`);
  const c = await client.query(`SELECT id, created_at::text AS ts FROM knowledge_chunks ORDER BY id`);
  return {
    documents: sha256(d.rows.map((r) => `${r.id}:${r.ts}`).join('\n')),
    chunks: sha256(c.rows.map((r) => `${r.id}:${r.ts}`).join('\n')),
  };
}

/** 迁移的**预期结果**：每条资料/片段应该挂到它 owner 的默认项目 */
async function expectedAssignment(live) {
  const r = await live.query(
    `SELECT DISTINCT ON (user_id) user_id, id FROM projects ORDER BY user_id, is_default DESC, id ASC`,
  );
  const map = {};
  for (const row of r.rows) map[String(row.user_id)] = String(row.id);
  return map;
}

/** 按 owner 分组统计资料 / 片段（迁移前后都要一致） */
async function byOwner(client) {
  const d = await client.query('SELECT owner_id, count(*)::int AS n FROM knowledge_documents GROUP BY owner_id ORDER BY owner_id');
  const c = await client.query('SELECT owner_id, count(*)::int AS n FROM knowledge_chunks GROUP BY owner_id ORDER BY owner_id');
  return {
    documents: d.rows.map((r) => ({ ownerId: String(r.owner_id), n: Number(r.n) })),
    chunks: c.rows.map((r) => ({ ownerId: String(r.owner_id), n: Number(r.n) })),
  };
}

async function assignmentReport(client, expected) {
  const docs = await client.query('SELECT id, owner_id, project_id FROM knowledge_documents ORDER BY id');
  const chunks = await client.query('SELECT id, document_id, owner_id, project_id FROM knowledge_chunks ORDER BY id');
  const docMap = {};
  for (const d of docs.rows) docMap[String(d.id)] = String(d.project_id);
  const bad = [];
  for (const d of docs.rows) {
    if (String(d.project_id) !== expected[String(d.owner_id)]) {
      bad.push({ kind: 'document', id: String(d.id), owner: String(d.owner_id), got: String(d.project_id), want: expected[String(d.owner_id)] });
    }
  }
  for (const c of chunks.rows) {
    const want = expected[String(c.owner_id)];
    if (String(c.project_id) !== want) bad.push({ kind: 'chunk', id: String(c.id), got: String(c.project_id), want });
    else if (docMap[String(c.document_id)] !== String(c.project_id)) {
      bad.push({ kind: 'chunk-doc-mismatch', id: String(c.id), got: String(c.project_id), want: docMap[String(c.document_id)] });
    }
  }
  return { documents: docs.rows.length, chunks: chunks.rows.length, mismatches: bad };
}

/** 把 migrate() 的日志截下来，作为「这一遍到底改了多少行」的原始输出 */
async function runMigrateWithLog(pool) {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(['log', a.join(' ')]);
  console.warn = (...a) => logs.push(['warn', a.join(' ')]);
  try {
    await migrate(pool);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return logs;
}

const failures = [];
/** 全部断言（含 PASS）—— 必须落进证据 JSON，否则报告里的 PASS 原文在证据里查不到。 */
const allChecks = [];
function check(name, ok, detail) {
  const line = { name, ok, detail };
  allChecks.push(line);
  if (!ok) failures.push(line);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
  return line;
}

/** 「加新列之前」的提交里 db.ts 一定不含这两个标记（2-A 才引入的列名，别的表没有同名字段）。 */
const PRE_MIGRATION_MARKERS = ['can_create_agents', 'current_project_id'];

/**
 * 从 HEAD 往回找**第一个** db.ts 里还没有 2-A 新列的提交 —— 那才是真正的「迁移前」。
 *
 * 为什么不能写死 `HEAD`：2-A 未提交时 HEAD 恰好 = 改动前，脚本于是「碰巧正确」；
 * 一旦 2-A 提交进历史，HEAD 就变成改动后，`git show HEAD:db.ts` 里的 DDL 自带新列 →
 * 验收库的「迁移前」结构其实已经是迁移后，整条对照静默失效。
 */
function findPreMigrationCommit() {
  const shas = execSync('git log --format=%H', { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const sha of shas) {
    let src = '';
    try {
      src = execSync(`git show ${sha}:apps/server/src/db.ts`, { cwd: repo, encoding: 'utf8' });
    } catch {
      continue; // 这个提交里还没有这个文件
    }
    if (!PRE_MIGRATION_MARKERS.some((m) => src.includes(m))) return sha;
  }
  throw new Error('翻遍历史都没找到「加新列之前」的提交，请用 MIGRATE_BASE_COMMIT=<sha> 指定');
}

async function main() {
  const evidence = { startedAt: new Date().toISOString(), checkDb: CHECK_DB, checks: [], failures: [] };
  const live = await connect(LIVE_URL);

  // ---------------------------------------------------------------- 1. 造验收库
  const admin = await connect(LIVE_URL);
  await admin.query(`DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)`).catch(async (err) => {
    if (!/WITH|syntax/i.test(err.message)) throw err;
    await admin.query(`DROP DATABASE IF EXISTS ${CHECK_DB}`);
  });
  await admin.query(`CREATE DATABASE ${CHECK_DB}`);
  await admin.end();
  evidence.step1 = { note: `已新建验收库 ${CHECK_DB}（活库只 SELECT）` };

  const checkDb = await connect(CHECK_URL);

  // ------------------------- 2. 用「加新列之前那个提交」的真实 DDL 建「迁移前」结构
  const baseCommit = process.env.MIGRATE_BASE_COMMIT || findPreMigrationCommit();
  const oldSrc = execSync(`git show ${baseCommit}:apps/server/src/db.ts`, { cwd: repo, encoding: 'utf8' });
  const from = oldSrc.indexOf('const DDL = `') + 'const DDL = `'.length;
  const to = oldSrc.indexOf('`;', from);
  const oldDdl = oldSrc.slice(from, to);
  if (!oldDdl.includes('CREATE TABLE IF NOT EXISTS knowledge_chunks')) throw new Error('旧 DDL 提取失败');
  await checkDb.query(oldDdl);

  const head = execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  evidence.step2 = {
    baseCommit: execSync(`git rev-parse --short ${baseCommit}`, { cwd: repo, encoding: 'utf8' }).trim(),
    baseCommitFull: baseCommit,
    headCommit: head,
    oldDdlLength: oldDdl.length,
    oldDdlSha256: sha256(oldDdl),
  };
  const preCols = await columnPresence(checkDb);
  check(
    `迁移前结构里确实没有 2-A 的新列（基线取自 ${evidence.step2.baseCommit}，${baseCommit === head ? '⚠️ 就是 HEAD' : '≠ HEAD'}）`,
    Object.values(preCols).every((cols) => Object.values(cols).every((v) => v === false)),
    JSON.stringify(preCols),
  );

  // ---------------------------------- 3. 把活库真实数据按旧结构搬进验收库
  const liveCounts = await counts(live);
  for (const [table, cols] of Object.entries(TABLES)) {
    const rows = await live.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY id`);
    for (const row of rows.rows) {
      const ph = cols.map((_, i) => `$${i + 1}`);
      await checkDb.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph.join(', ')})`, cols.map((c) => row[c]));
    }
    await checkDb
      .query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT max(id) FROM ${table}), 1))`)
      .catch(() => undefined);
  }
  await live.end();

  /**
   * 3b. **放大样本**（合成，明确标注）：活库里带资料的只有 1 个 owner（另两个 owner 一条都没有），
   *     光靠真实数据没法证明「多账号之间不会串号」。所以在**迁移前**的结构里，
   *     给每个 owner 都塞一批资料+片段，让它们和真实数据一起走迁移。
   *     这些是合成的，不进活库；它们的作用是验证「量大 + 多 owner 时也一条不丢、不串」。
   */
  const OWNERS = (await checkDb.query('SELECT id FROM users ORDER BY id')).rows.map((r) => Number(r.id));
  const DOCS_PER_OWNER = 30;
  const CHUNKS_PER_DOC = 8;
  const synthetic = { owners: OWNERS, docsPerOwner: DOCS_PER_OWNER, chunksPerDoc: CHUNKS_PER_DOC, docs: 0, chunks: 0 };
  for (const owner of OWNERS) {
    for (let i = 0; i < DOCS_PER_OWNER; i += 1) {
      const ins = await checkDb.query(
        `INSERT INTO knowledge_documents (owner_id, filename_enc, file_kind, byte_size, chunk_count)
         VALUES ($1, $2, 'md', $3, $4) RETURNING id`,
        [owner, `gcm$syn-${owner}-${i}$tag$payload`, 100 + i, CHUNKS_PER_DOC],
      );
      const docId = String(ins.rows[0].id);
      synthetic.docs += 1;
      for (let k = 0; k < CHUNKS_PER_DOC; k += 1) {
        await checkDb.query(
          `INSERT INTO knowledge_chunks (document_id, owner_id, chunk_index, content_enc) VALUES ($1, $2, $3, $4)`,
          [docId, owner, k, `gcm$syn-${owner}-${i}-${k}$tag$payload`],
        );
        synthetic.chunks += 1;
      }
    }
  }
  evidence.step3b = { note: '按 owner 放大样本（合成，仅存在于验收库）', ...synthetic };
  console.log(`[seed] 合成放大样本：${synthetic.docs} 份资料 / ${synthetic.chunks} 个片段（owners=${OWNERS.join(',')}）`);

  const beforeCounts = await counts(checkDb);
  const beforeDigest = await contentDigest(checkDb);
  const beforeStamp = await rowStampDigest(checkDb);
  const beforeByOwner = await byOwner(checkDb);
  // 「搬运是否完整」：除知识库两张表（多了合成样本）外，其余逐表必须与活库一致；
  // 知识库两张表则是「活库条数 + 合成条数」。
  const movedOk = Object.keys(liveCounts).every((t) => {
    if (t === 'knowledge_documents') return beforeCounts[t] === liveCounts[t] + synthetic.docs;
    if (t === 'knowledge_chunks') return beforeCounts[t] === liveCounts[t] + synthetic.chunks;
    return beforeCounts[t] === liveCounts[t];
  });
  check(
    '搬运完整：验收库行数 = 活库（知识库另加合成放大样本），迁移前基线可信',
    movedOk,
    `live=${JSON.stringify(liveCounts)} + synth(${synthetic.docs}/${synthetic.chunks}) => check=${JSON.stringify(beforeCounts)}`,
  );
  evidence.step3 = { liveCounts, beforeCounts, beforeDigest, beforeByOwner };

  // ------------------------------------------------------------ 4. 「迁移前」快照
  const before = {
    counts: beforeCounts,
    byOwner: beforeByOwner,
    columns: preCols,
    nullProjectId: {
      'users.current_project_id': 'n/a（列不存在）',
      'knowledge_documents.project_id': 'n/a（列不存在）',
      'knowledge_chunks.project_id': 'n/a（列不存在）',
    },
    nullability: {
      'knowledge_documents.project_id': await nullability(checkDb, 'knowledge_documents', 'project_id'),
      'knowledge_chunks.project_id': await nullability(checkDb, 'knowledge_chunks', 'project_id'),
    },
    digest: beforeDigest,
    rowStamp: beforeStamp,
  };
  evidence.before = before;
  console.log('\n===== 迁移前 =====');
  console.log(JSON.stringify(before, null, 2));

  const expected = await expectedAssignment(checkDb);

  // -------------------------------------------------- 5. 跑真正的 migrate()
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: CHECK_URL, max: 3 });
  const firstLogs = await runMigrateWithLog(pool);
  evidence.migrateLogs = firstLogs;

  const afterCounts = await counts(checkDb);
  const afterDigest = await contentDigest(checkDb);
  const afterStamp = await rowStampDigest(checkDb);
  const afterByOwner = await byOwner(checkDb);
  const afterCols = await columnPresence(checkDb);
  const assignment = await assignmentReport(checkDb, expected);
  const nullDocs = Number((await checkDb.query('SELECT count(*)::int AS n FROM knowledge_documents WHERE project_id IS NULL')).rows[0].n);
  const nullChunks = Number((await checkDb.query('SELECT count(*)::int AS n FROM knowledge_chunks WHERE project_id IS NULL')).rows[0].n);
  const nullUsers = Number((await checkDb.query('SELECT count(*)::int AS n FROM users WHERE current_project_id IS NULL')).rows[0].n);

  const after = {
    counts: afterCounts,
    byOwner: afterByOwner,
    columns: afterCols,
    nullProjectId: {
      'users.current_project_id': nullUsers,
      'knowledge_documents.project_id': nullDocs,
      'knowledge_chunks.project_id': nullChunks,
    },
    nullability: {
      'knowledge_documents.project_id': await nullability(checkDb, 'knowledge_documents', 'project_id'),
      'knowledge_chunks.project_id': await nullability(checkDb, 'knowledge_chunks', 'project_id'),
    },
    digest: afterDigest,
    rowStamp: afterStamp,
    assignment,
    expectedAssignment: expected,
  };
  evidence.after = after;
  console.log('\n===== 迁移后 =====');
  console.log(JSON.stringify(after, null, 2));

  // ------------------------------------------------------------- 6. 对照断言
  console.log('\n===== 对照 =====');
  const rowDiff = Object.keys(beforeCounts).filter((t) => beforeCounts[t] !== afterCounts[t]);
  check(
    '条数零丢失：迁移前后 11 张表行数逐表一致',
    rowDiff.length === 0,
    rowDiff.length === 0
      ? Object.entries(beforeCounts).map(([t, n]) => `${t}=${n}`).join(' / ')
      : rowDiff.map((t) => `${t}: ${beforeCounts[t]} -> ${afterCounts[t]}`).join(', '),
  );
  check(
    '按 owner 逐账号核对：每个人的资料/片段条数迁移前后不变（多账号不串）',
    JSON.stringify(beforeByOwner) === JSON.stringify(afterByOwner),
    JSON.stringify(afterByOwner),
  );
  check(
    '正文零改动：知识库内容摘要（sha256）逐表一致（内容指纹不含写入时刻，因此跨轮也可复现）',
    beforeDigest.documentDigest === afterDigest.documentDigest && beforeDigest.chunkDigest === afterDigest.chunkDigest,
    `docs ${beforeDigest.documentDigest.slice(0, 16)} -> ${afterDigest.documentDigest.slice(0, 16)} / ` +
      `chunks ${beforeDigest.chunkDigest.slice(0, 16)} -> ${afterDigest.chunkDigest.slice(0, 16)}`,
  );
  check(
    '迁移是「原地加列」：每一行的 created_at 都没被动过（同轮内 id+时间戳指纹一致）',
    beforeStamp.documents === afterStamp.documents && beforeStamp.chunks === afterStamp.chunks,
    `docs ${beforeStamp.documents.slice(0, 16)} -> ${afterStamp.documents.slice(0, 16)} / ` +
      `chunks ${beforeStamp.chunks.slice(0, 16)} -> ${afterStamp.chunks.slice(0, 16)}`,
  );
  check(
    '每条资料/片段都拿到了项目归属（按 owner 的默认项目，逐条核对）',
    assignment.mismatches.length === 0,
    `资料 ${assignment.documents} 条 / 片段 ${assignment.chunks} 条，不符 ${assignment.mismatches.length} 条` +
      (assignment.mismatches.length ? ` -> ${JSON.stringify(assignment.mismatches.slice(0, 5))}` : ''),
  );
  check('迁移后 project_id 无空值', nullDocs === 0 && nullChunks === 0, `documents=${nullDocs} chunks=${nullChunks}`);
  check(
    'project_id 已收紧为 NOT NULL',
    after.nullability['knowledge_documents.project_id'] === 'NO' && after.nullability['knowledge_chunks.project_id'] === 'NO',
    JSON.stringify(after.nullability),
  );
  check(
    '用户当前项目已补上（老账号 0 行为不变：= 自己的默认项目）',
    nullUsers === 0,
    `空值 ${nullUsers} 行`,
  );

  // ------------------------------------ 7. 幂等：再跑一遍必须「零改动」
  const secondLogs = await runMigrateWithLog(pool);
  const secondCounts = await counts(checkDb);
  const secondDigest = await contentDigest(checkDb);
  const secondMigrateLine = secondLogs.map((l) => l[1]).find((t) => t.includes('项目层迁移完成')) ?? '';
  evidence.idempotency = { logs: secondLogs, counts: secondCounts, digest: secondDigest, migrateLine: secondMigrateLine };
  check(
    '幂等：第二次执行迁移是空操作（行数与摘要不变）',
    JSON.stringify(secondCounts) === JSON.stringify(afterCounts) &&
      secondDigest.chunkDigest === afterDigest.chunkDigest,
    secondMigrateLine || '(无日志)',
  );
  check(
    '幂等：第二次执行上报 0 行改动',
    /补 0 行/.test(secondMigrateLine) && /回填 资料 0 条 \/ 片段 0 条/.test(secondMigrateLine),
    secondMigrateLine || '(没有拿到日志行)',
  );

  // ---------------------- 8. 「用户已选过的当前项目」不许被迁移覆盖
  const nonDefault = await checkDb.query(
    `SELECT p.id FROM projects p JOIN users u ON u.id = p.user_id WHERE p.is_default = false ORDER BY p.id LIMIT 1`,
  );
  if (nonDefault.rowCount === 1) {
    const pid = String(nonDefault.rows[0].id);
    const uid = String((await checkDb.query('SELECT user_id FROM projects WHERE id = $1', [pid])).rows[0].user_id);
    await checkDb.query('UPDATE users SET current_project_id = $2 WHERE id = $1', [uid, pid]);
    const thirdLogs = await runMigrateWithLog(pool);
    const kept = String((await checkDb.query('SELECT current_project_id FROM users WHERE id = $1', [uid])).rows[0].current_project_id);
    evidence.currentProjectPreserved = { userId: uid, projectId: pid, afterMigrate: kept, logs: thirdLogs };
    check(
      '用户已选过的当前项目不被迁移改写（只补空值）',
      kept === pid,
      `user ${uid}.current_project_id = ${kept}（期望 ${pid}）`,
    );
  } else {
    check('用户已选过的当前项目不被迁移改写（只补空值）', false, '验收库里的数据没有「非默认项目」，这条用例没跑到');
  }

  await pool.end();
  await checkDb.end();

  // --------------------------------------------------------- 9. 收尾
  const tail = await connect(LIVE_URL);
  if (!keep) await tail.query(`DROP DATABASE IF EXISTS ${CHECK_DB} WITH (FORCE)`);
  await tail.end();

  evidence.endedAt = new Date().toISOString();
  evidence.checks = allChecks;
  evidence.failures = failures;
  writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  console.log(
    `\n===== 结果 =====\n共 ${allChecks.length} 条，${failures.length === 0 ? '全部通过' : `${failures.length} 条失败`}；证据：${outFile}`,
  );
  if (!keep) console.log(`[cleanup] 已删除验收库 ${CHECK_DB}（活库 workbench 全程只读）`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[replay] 跑挂了：', err);
  process.exit(2);
});
