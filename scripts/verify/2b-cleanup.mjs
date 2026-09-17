/**
 * 子阶段 2-B 验收的**收尾**：把本次新建的测试账号整体删掉，并复拍活库指纹。
 *
 * 为什么单独一个文件：`dbq.mjs` 是**只读**工具（验收里「直连库核对」用的），
 * 写操作不往里塞，各管各的。
 *
 * 用法：node scripts/verify/2b-cleanup.mjs <userId>
 * 输出（JSON）：
 *   { userId, phoneHashTail, before:{counts,ids}, deleted:{smsCodes,users}, after:{counts,ids} }
 *
 * 删除方式沿用历次验收：`DELETE FROM users WHERE id = $1`（外键级联带走
 * projects / agents / conversations / messages / knowledge_* …）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const userId = Number(process.argv[2]);
if (!Number.isInteger(userId) || userId <= 0) {
  console.error('用法：node scripts/verify/2b-cleanup.mjs <userId>');
  process.exit(2);
}

function envOf() {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const TABLES = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks',
  'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks'];

const { Client } = require('pg');
const client = new Client({ connectionString: envOf().DATABASE_URL });

async function fingerprint() {
  const counts = {};
  const ids = {};
  for (const t of TABLES) {
    counts[t] = Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
    ids[t] = (await client.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map((r) => String(r.id)).join(',');
  }
  return { counts, ids };
}

await client.connect();
try {
  const u = await client.query('SELECT id, phone_hash FROM users WHERE id = $1', [userId]);
  const before = await fingerprint();
  let deletedSms = 0;
  let deletedUsers = 0;
  if (u.rowCount === 1) {
    const phoneHash = u.rows[0].phone_hash;
    deletedSms = (await client.query('DELETE FROM sms_codes WHERE phone_hash = $1', [phoneHash])).rowCount ?? 0;
    deletedUsers = (await client.query('DELETE FROM users WHERE id = $1', [userId])).rowCount ?? 0;
  }
  const after = await fingerprint();
  console.log(JSON.stringify({
    userId,
    found: u.rowCount === 1,
    phoneHashTail: u.rowCount === 1 ? String(u.rows[0].phone_hash).slice(-8) : null,
    deleted: { smsCodes: deletedSms, users: deletedUsers },
    before,
    after,
  }, null, 1));
} finally {
  await client.end();
}
