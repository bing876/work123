/**
 * 子阶段 2-A 取证用：**只读**数据库快照（迁移前后对照用）。
 *
 * 干三件事，全是 SELECT，不写库、不改结构：
 *   1) 把「项目层相关」的表行数列出来（含 knowledge_documents / knowledge_chunks 的归属分布）；
 *   2) 报告迁移目标列**当前是否已经存在**（users.current_project_id / agents.can_create_agents /
 *      knowledge_documents.project_id / knowledge_chunks.project_id）—— 用来证明快照确实取自
 *      「迁移前」而不是「已经跑过一遍之后」；
 *   3) 输出每张表里 project_id 为 NULL 的条数（迁移要消灭的就是这些）。
 *
 * 用法：
 *   node scripts/verify/db-snapshot.mjs <out.json>      # 写文件
 *   node scripts/verify/db-snapshot.mjs                 # 打到 stdout
 *
 * 连接串手工解析 apps/server/.env（不依赖 dotenv），密钥只进内存、绝不打印。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

function envValue(key) {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const { Client } = require('pg');
const client = new Client({ connectionString: envValue('DATABASE_URL') });

const TABLES = [
  'users',
  'projects',
  'agents',
  'conversations',
  'messages',
  'tasks',
  'memories',
  'user_memories',
  'agent_memories',
  'knowledge_documents',
  'knowledge_chunks',
];

/** 想探测「列存不存在」的表 → 列名 */
const COLUMNS = {
  users: ['current_project_id'],
  agents: ['can_create_agents'],
  knowledge_documents: ['project_id'],
  knowledge_chunks: ['project_id'],
};

async function scalar(sql, params = []) {
  const r = await client.query(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

async function main() {
  await client.connect();
  const out = { takenAt: new Date().toISOString(), tables: {}, columns: {}, nullProjectId: {}, projects: [], agents: [] };

  for (const t of TABLES) out.tables[t] = await scalar(`SELECT count(*)::int AS n FROM ${t}`);

  for (const [table, cols] of Object.entries(COLUMNS)) {
    out.columns[table] = {};
    for (const col of cols) {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, col],
      );
      out.columns[table][col] = Number(r.rows[0].n) > 0;
    }
  }

  // project_id 空值分布（列不存在时记 -1，明确区分「0 条空值」和「还没这列」）
  for (const table of ['knowledge_documents', 'knowledge_chunks']) {
    if (!out.columns[table].project_id) {
      out.nullProjectId[table] = -1;
      continue;
    }
    out.nullProjectId[table] = await scalar(`SELECT count(*)::int AS n FROM ${table} WHERE project_id IS NULL`);
  }

  out.nullProjectId['users.current_project_id'] = out.columns.users.current_project_id
    ? await scalar('SELECT count(*)::int AS n FROM users WHERE current_project_id IS NULL')
    : -1;

  const p = await client.query(
    'SELECT id, user_id, name, is_default FROM projects ORDER BY id',
  );
  out.projects = p.rows;

  const a = await client.query(
    out.columns.agents.can_create_agents
      ? 'SELECT id, project_id, name, kind, can_create_agents FROM agents ORDER BY id'
      : 'SELECT id, project_id, name, kind FROM agents ORDER BY id',
  );
  out.agents = a.rows;

  // 知识库归属分布（列在时才有意义）
  if (out.columns.knowledge_documents.project_id) {
    const d = await client.query(
      `SELECT owner_id, project_id, count(*)::int AS n FROM knowledge_documents GROUP BY owner_id, project_id ORDER BY owner_id, project_id`,
    );
    out.knowledgeByOwnerProject = d.rows;
  }

  await client.end();

  const text = JSON.stringify(out, null, 2);
  const target = process.argv[2];
  if (target) {
    writeFileSync(target, text + '\n', 'utf8');
    console.log(`[snapshot] 已写入 ${target}`);
  } else {
    console.log(text);
  }

  console.log(
    `[snapshot] 表行数 ${Object.entries(out.tables)
      .map(([k, v]) => `${k}=${v}`)
      .join(' / ')}`,
  );
  console.log(
    `[snapshot] 迁移列存在性 ${Object.entries(out.columns)
      .map(([t, cols]) => Object.entries(cols).map(([c, ok]) => `${t}.${c}=${ok}`).join(','))
      .join(' / ')}`,
  );
}

main().catch((err) => {
  console.error('[snapshot] 失败：', err.message);
  process.exit(1);
});
