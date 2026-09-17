/**
 * 验收用的**只读**取数小工具：一条 SQL → JSON。
 *
 * 为什么要有它：验收要「直连库读原始行」才算证据（接口一旦带兜底/合并就不能当原始证据），
 * 而本机 `docker` CLI 被拦、Python 侧没有 pg 驱动 —— 那就让 Node 去读，Python 只管调它。
 *
 * 用法：
 *   node scripts/verify/dbq.mjs "SELECT id, project_id FROM agents WHERE id = $1" '["12"]'
 *
 * 安全：**只放 SELECT / WITH**，写操作一律当场拒绝（这个文件不是数据修改工具）。
 * 连库串从 `apps/server/.env` 里读，密钥只进内存、绝不打印。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const sql = String(process.argv[2] ?? '').trim();
if (!sql) {
  console.error('用法：node scripts/verify/dbq.mjs "<SELECT …>" \'[params]\'');
  process.exit(2);
}
if (!/^(select|with)\b/i.test(sql)) {
  console.error('dbq 只允许 SELECT / WITH（只读取证工具）');
  process.exit(2);
}
const params = process.argv[3] ? JSON.parse(process.argv[3]) : [];

function envOf() {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const { Client } = require('pg');
const client = new Client({ connectionString: envOf().DATABASE_URL });
await client.connect();
try {
  const r = await client.query(sql, params);
  console.log(JSON.stringify(r.rows, null, 1));
} finally {
  await client.end();
}
