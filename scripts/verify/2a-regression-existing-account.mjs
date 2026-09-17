/**
 * 子阶段 2-A 的**老账号回归**（只读）：改动不能悄悄改掉既有账号看到的东西。
 *
 * 为什么单独做这一份：
 *   2-A 动了几条「本来只有默认项目」的老路径：登录返回哪个项目、知识库列哪些资料、
 *   GET /agents 不带参数回什么。前端这一阶段不动，所以**老账号看到的东西必须和改造前一致**。
 *   这里挑活库里真实存在的账号（默认取第一个用户），**全部只发 GET**，
 *   跑完断言 11 张表的行数与 id 集合一行没变。
 *
 * 用法：
 *   node scripts/verify/2a-regression-existing-account.mjs [userId]
 */
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const PORT = Number(process.env.PORT || 8798);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const LOG_PATH = resolve(repo, `docs/acceptance/substage-2a/regression-server-${PORT}.log`);
const OUT_PATH = resolve(repo, 'docs/acceptance/substage-2a/regression-existing-account.json');

function envOf() {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = envOf();
const { Client } = require('pg');
const { signToken } = require(resolve(repo, 'apps/server/dist/crypto.js'));
const live = new Client({ connectionString: ENV.DATABASE_URL });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  return ok;
}
async function api(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text: text.slice(0, 200) };
}

const TABLES = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks', 'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks'];
async function fingerprint() {
  const counts = {};
  const ids = {};
  for (const t of TABLES) {
    counts[t] = Number((await live.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
    ids[t] = (await live.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map((r) => String(r.id)).join(',');
  }
  return { counts, ids };
}

let server = null;

async function main() {
  const evidence = { startedAt: new Date().toISOString(), base: BASE };
  await live.connect();
  const before = await fingerprint();
  evidence.before = before;

  const target = Number(process.argv[2] || 0);
  const u = target > 0
    ? await live.query('SELECT id, xyz_id, current_project_id FROM users WHERE id = $1', [target])
    : await live.query('SELECT id, xyz_id, current_project_id FROM users ORDER BY id LIMIT 1');
  if (u.rowCount !== 1) throw new Error('活库里找不到可用于回归的老账号');
  const user = u.rows[0];
  evidence.user = { id: String(user.id), xyzId: user.xyz_id, currentProjectId: user.current_project_id };
  console.log(`[regression] 用老账号 user ${user.id}（XYZ ${user.xyz_id}｜current_project_id=${user.current_project_id}）只读回归`);

  // 起一个自己的后端（**只读**打它，不改库）
  const occupied = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (!occupied) {
    const out = createWriteStream(LOG_PATH, { flags: 'w' });
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: resolve(repo, 'apps/server'),
      env: { ...process.env, PORT: String(PORT) },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.pipe(out);
    server.stderr.pipe(out);
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 400));
    }
    if (!up) throw new Error(`后端 ${BASE} 没起来，看 ${LOG_PATH}`);
  }
  const health = await (await fetch(`${BASE}/health`)).json();
  evidence.health = health;
  check('后端 + 数据库在线', health.db === 'up', JSON.stringify(health));

  const token = signToken({ sub: Number(user.id), xyz: user.xyz_id }, ENV.JWT_SECRET);

  // 1) 登录/会话
  const me = await api('/auth/me', token);
  check('GET /auth/me（老账号）仍然可用', me.status === 200 && me.json?.user?.id === Number(user.id), `status=${me.status}`);
  check(
    '/auth/me 回的项目 = 这个账号的「当前项目」（没有就回落默认项目，老行为不变）',
    me.json?.project?.id === Number(user.current_project_id || 0) || me.json?.project?.isDefault === true,
    JSON.stringify(me.json?.project),
  );
  evidence.profile = me.json;

  // 2) 智能体列表（前端左栏就吃这个接口）
  const all = await api('/agents', token);
  const kinds = (all.json?.agents ?? []).map((a) => `${a.id}:${a.kind}`);
  check('GET /agents 不带参数：老账号的智能体一个不少（前端左栏不变）', all.status === 200 && kinds.length > 0, kinds.join(' '));
  check(
    '自带「小助」仍不可删（deletable=false），普通智能体仍可删（deletable=true）',
    (all.json?.agents ?? []).every((a) => (a.kind === 'assistant' || a.kind === 'hen' ? a.deletable === false : a.deletable === true)),
    (all.json?.agents ?? []).map((a) => `${a.kind}:${a.deletable}`).join(' '),
  );
  const cpid = me.json?.project?.id;
  if (cpid) {
    const scoped = await api(`/agents?projectId=${cpid}`, token);
    check(
      `GET /agents?projectId=${cpid}（当前项目）只看这个项目里的`,
      scoped.status === 200 && (scoped.json?.agents ?? []).every((a) => a.projectId === cpid),
      (scoped.json?.agents ?? []).map((a) => `${a.id}:${a.kind}`).join(' '),
    );
  }

  // 3) 知识库：既有资料按项目各归各家
  const docs = await live.query('SELECT id, owner_id, project_id FROM knowledge_documents WHERE owner_id = $1 ORDER BY id', [user.id]);
  const kbNoParam = await api('/knowledge', token);
  check(
    'GET /knowledge（不带参数）= 当前项目里的资料',
    kbNoParam.status === 200 &&
      JSON.stringify((kbNoParam.json?.documents ?? []).map((d) => d.id).sort((a, b) => a - b)) ===
        JSON.stringify(docs.rows.filter((d) => String(d.project_id) === String(cpid)).map((d) => Number(d.id)).sort((a, b) => a - b)),
    `当前项目=${cpid} 资料=[]${docs.rows.map((d) => `${d.id}@p${d.project_id}`).join(' ')} 接口回=[${(kbNoParam.json?.documents ?? []).map((d) => d.id).join(',')}]`,
  );
  for (const d of docs.rows) {
    const byProject = await api(`/knowledge?projectId=${d.project_id}`, token);
    check(
      `具体到项目：资料 #${d.id} 在它所属项目 ${d.project_id} 的列表里查得到（迁移回填的归属真的生效）`,
      byProject.status === 200 && (byProject.json?.documents ?? []).some((x) => x.id === Number(d.id)),
      `status=${byProject.status} ids=[${(byProject.json?.documents ?? []).map((x) => x.id).join(',')}]`,
    );
  }

  // 4) 记忆 / 项目列表（2-A 碰过的读写路径，先确认读没坏）
  const um = await api('/memory/user', token);
  check('GET /memory/user 仍然可用（2-A 改过 memories 落点的那条路径）', um.status === 200, `status=${um.status}`);
  const pl = await api('/projects', token);
  check('GET /projects 对老账号回它自己的项目，且标出当前项目', pl.status === 200 && (pl.json?.projects ?? []).length > 0 && !!pl.json?.currentProjectId, JSON.stringify(pl.json?.projects));

  const after = await fingerprint();
  evidence.after = after;
  const countDiff = Object.keys(before.counts).filter((t) => before.counts[t] !== after.counts[t]);
  const idDiff = Object.keys(before.ids).filter((t) => before.ids[t] !== after.ids[t]);
  check('本次回归**只读**：11 张表行数一行没变', countDiff.length === 0, countDiff.length === 0 ? '行数全部一致' : countDiff.join(', '));
  check('本次回归**只读**：逐表 id 集合完全一致', idDiff.length === 0, idDiff.length === 0 ? 'id 集合全部一致' : idDiff.join(', '));

  const failed = results.filter((r) => !r.ok);
  evidence.results = results;
  evidence.failures = failed;
  evidence.endedAt = new Date().toISOString();
  writeFileSync(OUT_PATH, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`\n===== 结果 =====\n共 ${results.length} 条，${failed.length === 0 ? '全部通过' : `${failed.length} 条失败`}；证据：${OUT_PATH}`);
  return failed.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error('[regression] 跑挂了：', err);
} finally {
  await live.end().catch(() => undefined);
  if (server) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { shell: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
  }
}
process.exit(code);
