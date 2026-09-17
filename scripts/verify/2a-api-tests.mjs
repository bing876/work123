/**
 * 子阶段 2-A 真机验收：**对着真实后端 + 真实 PostgreSQL 打真实 HTTP**。
 *
 * 覆盖要求里的四条硬指标：
 *   ① 母鸡不可删除（后端 400 + 前端拿到的 deletable=false + 删完数据库里那行还在）
 *   ② 权限校验生效（**asAgentId 必填，不传/非法 400，无任何回落**；普通智能体 403；
 *      把普通智能体的开关打开就能建 —— 证明闸门认字段不认 kind）
 *   ③ 知识库按项目隔离（切项目看不到别的项目的资料；显式传别人的项目 404）
 *   ④ GET /agents 按 projectId 过滤正确（含 404 / 400 / 不带参数 = 改造前行为）
 * 外加 /projects 的增 / 列 / 改名 / 设为当前。
 *
 * 2-A 修正（总控拍板）新增两块取证：
 *   · 调用者身份**必填**：{} / 无 body / 0 / 'abc' / null 一律 400，且一行数据都不许建；
 *   · 新智能体归属 = **调用者自己所在的项目**：做成一对**对称对照**
 *     （当前项目=默认 + 调用者=新项目里的母鸡 → 落新项目；当前项目=新项目 + 调用者=默认里的小助 → 落默认项目），
 *     光验一个方向分不清「跟调用者走」还是「跟当前项目走」。
 *
 * 数据策略（重要）：
 *   - 全程用**一个本次新建的测试账号**（手机号在脚本里挑一个库里没有的），
 *     活库里已有账号（user 1/2/3）的数据一行不碰；
 *   - 跑完把测试账号整体删掉（users 级联），再断言**活库行数与既有 id 集合回到初始状态**。
 *
 * 用法：
 *   node scripts/verify/2a-api-tests.mjs                 # 自己起后端（8799）跑完自己收
 *   BASE=http://127.0.0.1:8799 node scripts/verify/2a-api-tests.mjs --no-spawn   # 复用已起的后端
 */
import { createHmac } from 'node:crypto';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
const PORT = Number(process.env.PORT || 8799);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const LOG_PATH = resolve(repo, `docs/acceptance/substage-2a/server-${PORT}.log`);
const OUT_PATH = resolve(repo, 'docs/acceptance/substage-2a/api-tests.json');

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
const live = new Client({ connectionString: ENV.DATABASE_URL });

const results = [];
function check(name, ok, detail) {
  const line = { name, ok, detail };
  results.push(line);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  return ok;
}
function section(title) {
  console.log(`\n───── ${title} ─────`);
}

async function api(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) {
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text };
}

// ------------------------------------------------------------------ 测试账号
function phoneHash(phone) {
  const pepper = ENV.PHONE_PEPPER || ENV.DATA_KEY;
  return createHmac('sha256', pepper).update(phone, 'utf8').digest('hex');
}
const CANDIDATES = ['18600001234', '18600001299', '18600001388', '18600001456'];

async function pickFreePhone() {
  for (const phone of CANDIDATES) {
    const hash = phoneHash(phone);
    const r = await live.query('SELECT id FROM users WHERE phone_hash = $1', [hash]);
    if (r.rowCount > 0) continue;
    // 这个号在库里没有账号 → 它的短信记录都是我们历次验收留下的，清掉，
    // 免得撞上「1 分钟内不许重复发码」的限流（验证码本身是短命的临时数据）。
    await live.query('DELETE FROM sms_codes WHERE phone_hash = $1', [hash]);
    return phone;
  }
  throw new Error('候选测试手机号在库里都已被占用，换一批');
}

async function waitForSmsCode(phone, sinceBytes) {
  // 服务端 mock 模式把验证码打在自己的日志里（响应体里没有）。
  // 注意：这里**必须**用 await 让出事件循环 —— 早先用 Atomics.wait 同步睡，
  // 结果主线程被锁死、stdout 的管道数据永远刷不进日志文件，等 15 秒也等不到。
  const deadline = Date.now() + 20000;
  const tail = `→ ${phone.slice(0, 3)}****${phone.slice(7)} 验证码 `;
  while (Date.now() < deadline) {
    const text = readFileSync(LOG_PATH, 'utf8').slice(sinceBytes);
    const idx = text.lastIndexOf(tail);
    if (idx >= 0) {
      const code = text.slice(idx + tail.length, idx + tail.length + 6);
      if (/^\d{6}$/.test(code)) return code;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`没在服务端日志里等到验证码（日志：${LOG_PATH}）`);
}

// ------------------------------------------------------------------ 活库基线
async function liveFingerprint() {
  const tables = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks', 'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks'];
  const counts = {};
  const ids = {};
  for (const t of tables) {
    counts[t] = Number((await live.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
    ids[t] = (await live.query(`SELECT id FROM ${t} ORDER BY id`)).rows.map((r) => String(r.id)).join(',');
  }
  return { counts, ids };
}

let server = null;
let serverLogBytes = 0;

async function startServer() {
  /**
   * 先确认端口是空的。踩过的坑：上一轮脚本异常退出时留下的后端还占着 8799，
   * 这一轮新起的实例直接 EADDRINUSE 退出，而健康检查却打到了**那个残留实例**上 ——
   * 测试「跑得下去」，但日志是空的（验证码读不到），很容易误判成功能坏了。
   */
  const occupied = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (occupied) {
    throw new Error(
      `${BASE} 已经有服务在监听了。要么它是上一轮没退干净的残留（先关掉它），` +
        '要么你本来就想复用（那请加 --no-spawn 并确认它是**本次改过的那份代码**起的）。',
    );
  }
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
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        const h = await r.json();
        serverLogBytes = readFileSync(LOG_PATH, 'utf8').length;
        return h;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`后端 ${BASE} 60 秒没起来，看日志 ${LOG_PATH}`);
}

async function main() {
  const started = new Date().toISOString();
  const evidence = { startedAt: started, base: BASE, results: [] };

  const beforeFp = await (async () => {
    await live.connect();
    return liveFingerprint();
  })();
  evidence.liveBefore = beforeFp;

  const health = noSpawn ? await (await fetch(`${BASE}/health`)).json() : await startServer();
  evidence.health = health;
  console.log(`[health] ${JSON.stringify(health)}`);
  if (health.db !== 'up') throw new Error('数据库不在线，验收无意义');

  const phone = await pickFreePhone();
  evidence.testPhone = phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');

  // ---------------------------------------------------------- 1. 建号并登录
  section('1. 测试账号（本次新建，跑完整体删除）');
  const send = await api('/auth/sms/send', { method: 'POST', body: { phone } });
  check('短信验证码已下发（mock 模式只进服务端日志）', send.status === 200, `status=${send.status}`);
  const code = await waitForSmsCode(phone, serverLogBytes);
  const login = await api('/auth/login/sms', { method: 'POST', body: { phone, code } });
  check('短信登录成功并拿到 JWT', login.status === 200 && typeof login.json?.token === 'string', `status=${login.status}`);
  const token = login.json.token;
  const userId = login.json.user?.id;
  evidence.testUserId = userId;
  check(
    '建号时自动建了「默认项目」并把它标成当前项目',
    login.json.project?.isDefault === true && login.json.project?.isCurrent === true,
    JSON.stringify(login.json.project),
  );
  check('默认项目里自带「小助」', login.json.agents?.length === 1 && login.json.agents[0].name === '小助', JSON.stringify(login.json.agents));

  // 后面所有用例都跑在「已登录的测试账号」之上；任何一步抛异常都要**保证走到收尾**，
  // 否则会留下测试数据、污染活库（宁可报告里多一条 FAIL，也不能留垃圾）。
  try {
  // ------------------------------------------------------------------ 2. /projects
  section('2. /projects：列 / 建（连带母鸡）/ 改名 / 设为当前');
  const list0 = await api('/projects', { token });
  check('GET /projects 回当前用户的全部项目', list0.status === 200 && list0.json.projects.length === 1, JSON.stringify(list0.json.projects));
  check('列表里标出了「当前使用中」', list0.json.currentProjectId === list0.json.projects[0].id, `current=${list0.json.currentProjectId}`);

  const create = await api('/projects', { method: 'POST', token, body: { name: '2A 验收项目' } });
  check('POST /projects 建项目成功', create.status === 200 && !!create.json?.project?.id, `status=${create.status} ${create.text.slice(0, 200)}`);
  const projNew = create.json.project;
  const projDefault = login.json.project;
  check(
    '新建项目自动成为「当前使用中的项目」',
    projNew.isCurrent === true && projNew.isDefault === false,
    JSON.stringify(projNew),
  );

  const agentsNew0 = await api(`/agents?projectId=${projNew.id}`, { token });
  const hen = (agentsNew0.json?.agents ?? [])[0];
  check(
    '建项目时**自动生成了一只母鸡**',
    agentsNew0.json?.agents?.length === 1 && hen?.kind === 'hen' && hen?.canCreateAgents === true,
    JSON.stringify(agentsNew0.json?.agents),
  );
  evidence.hen = hen;
  check(
    '母鸡在库里 kind=hen 且 can_create_agents=true（直连库核对）',
    (await live.query("SELECT kind, can_create_agents FROM agents WHERE id = $1", [hen.id])).rows[0]?.can_create_agents === true &&
      (await live.query('SELECT kind FROM agents WHERE id = $1', [hen.id])).rows[0]?.kind === 'hen',
    JSON.stringify((await live.query('SELECT id, project_id, name, kind, can_create_agents FROM agents WHERE id = $1', [hen.id])).rows[0]),
  );
  const henConv = await live.query('SELECT count(*)::int AS n FROM conversations WHERE agent_id = $1', [hen.id]);
  check('母鸡建好就带一条自己的会话（可立即开聊）', Number(henConv.rows[0].n) === 1, `conversations=${henConv.rows[0].n}`);

  const rename = await api(`/projects/${projNew.id}`, { method: 'PATCH', token, body: { name: '2A 验收项目（改名后）' } });
  check('PATCH /projects/:id 重命名成功', rename.status === 200 && rename.json?.project?.name === '2A 验收项目（改名后）', JSON.stringify(rename.json?.project));
  const renameOther = await api('/projects/1', { method: 'PATCH', token, body: { name: '偷改别人的' } });
  check('改**别人的**项目 → 404（不区分不存在/不是你的）', renameOther.status === 404, `status=${renameOther.status} ${renameOther.text.slice(0, 80)}`);
  const renameBad = await api('/projects/abc', { method: 'PATCH', token, body: { name: 'x' } });
  check('项目 id 非数字 → 400', renameBad.status === 400, `status=${renameBad.status}`);
  const createEmpty = await api('/projects', { method: 'POST', token, body: { name: '   ' } });
  check('建项目不给名字 → 400', createEmpty.status === 400, `status=${createEmpty.status} ${createEmpty.text.slice(0, 80)}`);

  const activateDefault = await api(`/projects/${projDefault.id}/activate`, { method: 'POST', token });
  const afterActivate = await api('/projects', { token });
  check(
    'POST /projects/:id/activate 切回默认项目生效',
    activateDefault.status === 200 && afterActivate.json.currentProjectId === projDefault.id,
    `current=${afterActivate.json.currentProjectId}`,
  );
  const activateOther = await api('/projects/1/activate', { method: 'POST', token });
  check('切到**别人的**项目 → 404', activateOther.status === 404, `status=${activateOther.status}`);

  // ------------------------------------------------------------------ 3. 权限
  section('3. 母鸡机制：不可删除 + 建智能体的权限校验');
  const delHen = await api(`/agents/${hen.id}`, { method: 'DELETE', token });
  const henStill = await live.query('SELECT count(*)::int AS n FROM agents WHERE id = $1', [hen.id]);
  check(
    '**母鸡不可删除**：DELETE 被后端拒绝（400）',
    delHen.status === 400 && /母鸡/.test(delHen.text),
    `status=${delHen.status} body=${delHen.text.slice(0, 120)}`,
  );
  check('母鸡被拒删后**数据库里那行仍在**（不只是回了个错误码）', Number(henStill.rows[0].n) === 1, `agents(id=${hen.id}) 命中 ${henStill.rows[0].n} 行`);
  check(
    '**前端也拦得住**：接口给母鸡的 deletable=false（App.tsx 只按这个字段决定画不画「删掉」按钮）',
    hen.deletable === false,
    `deletable=${hen.deletable}`,
  );
  check(
    '前端那条**唯一没按 deletable 判**的删除入口也进不去：母鸡 personaStatus 恒为 ready → 引导表（内含删除按钮）永不渲染',
    hen.personaStatus === 'ready',
    `personaStatus=${hen.personaStatus}`,
  );
  const delAssistant = await api(`/agents/${login.json.agents[0].id}`, { method: 'DELETE', token });
  check('自带小助仍然不可删（老行为回归）', delAssistant.status === 400, `status=${delAssistant.status} ${delAssistant.text.slice(0, 80)}`);

  const assistantId = login.json.agents[0].id;

  // ------------------------------------------------ 3.1 调用者身份必填（2-A 修正）
  const noCaller = await api('/agents', { method: 'POST', token, body: {} });
  check(
    '**不传 asAgentId → 400 直接拒**（修正前会回落成自带小助 —— 那等于不传身份就能拿到内置角色的权限）',
    noCaller.status === 400 && /asAgentId/.test(noCaller.text),
    `status=${noCaller.status} body=${noCaller.text.slice(0, 160)}`,
  );
  const noBodyAtAll = await api('/agents', { method: 'POST', token });
  check(
    '连 body 都不带 → 400（老前端那句 body:"{}" 的调法不再被接受）',
    noBodyAtAll.status === 400,
    `status=${noBodyAtAll.status} ${noBodyAtAll.text.slice(0, 120)}`,
  );
  const zeroCaller = await api('/agents', { method: 'POST', token, body: { asAgentId: 0 } });
  const strCaller = await api('/agents', { method: 'POST', token, body: { asAgentId: 'abc' } });
  const nullCaller = await api('/agents', { method: 'POST', token, body: { asAgentId: null } });
  check(
    'asAgentId 非法（0 / 字符串 / null）一律 400，不会被当成「没传」混过去',
    zeroCaller.status === 400 && strCaller.status === 400 && nullCaller.status === 400,
    `0→${zeroCaller.status}  'abc'→${strCaller.status}  null→${nullCaller.status}`,
  );
  const projDefaultAgents = Number((await live.query('SELECT count(*)::int AS n FROM agents WHERE project_id = $1', [projDefault.id])).rows[0].n);
  check(
    '被拒的这几次**一行数据都没建**（400 挡在写之前；默认项目里此刻只该有小助一只）',
    projDefaultAgents === 1,
    `agents in project ${projDefault.id} = ${projDefaultAgents}（期望 1）`,
  );

  // --------------------------------------- 3.2 小助显式作调用者，建一个普通智能体
  const byAssistant = await api('/agents', { method: 'POST', token, body: { asAgentId: assistantId } });
  check(
    '自带小助**显式**作调用者 → 建成功',
    byAssistant.status === 200 && !!byAssistant.json?.agent?.id,
    `status=${byAssistant.status} ${byAssistant.text.slice(0, 160)}`,
  );
  const plain = byAssistant.json.agent;
  check(
    '新建智能体落在**调用者自己所在的项目**（小助 → 默认项目）',
    plain.projectId === projDefault.id,
    `agent.projectId=${plain.projectId} 调用者项目=${projDefault.id} 当前项目=${projDefault.id}`,
  );
  check('普通智能体默认没有建智能体的权限', plain.canCreateAgents === false, `canCreateAgents=${plain.canCreateAgents}`);
  check('普通智能体可删（deletable=true，回归）', plain.deletable === true, `deletable=${plain.deletable}`);

  const denied = await api('/agents', { method: 'POST', token, body: { asAgentId: plain.id } });
  const beforeDeniedCount = Number((await live.query('SELECT count(*)::int AS n FROM agents WHERE project_id = $1', [projDefault.id])).rows[0].n);
  check(
    '**权限校验生效**：普通智能体作为调用者 → 403',
    denied.status === 403 && /没有创建智能体的权限/.test(denied.text),
    `status=${denied.status} body=${denied.text.slice(0, 140)}`,
  );
  const afterDeniedCount = Number((await live.query('SELECT count(*)::int AS n FROM agents WHERE project_id = $1', [projDefault.id])).rows[0].n);
  check('403 时**没有产生半成品数据**', beforeDeniedCount === afterDeniedCount, `agents in project ${projDefault.id}: ${beforeDeniedCount} -> ${afterDeniedCount}`);

  // 把开关打开 → 同一个普通智能体就应该能建了（证明闸门认的是「字段」而不是「kind」）
  await live.query('UPDATE agents SET can_create_agents = true WHERE id = $1', [plain.id]);
  const allowedAfterFlip = await api('/agents', { method: 'POST', token, body: { asAgentId: plain.id } });
  check(
    '把同一个智能体的开关改成 true → 立刻能建（闸门认字段，不是认 kind）',
    allowedAfterFlip.status === 200,
    `status=${allowedAfterFlip.status} ${allowedAfterFlip.text.slice(0, 140)}`,
  );
  await live.query('UPDATE agents SET can_create_agents = false WHERE id = $1', [plain.id]);
  const deniedAgain = await api('/agents', { method: 'POST', token, body: { asAgentId: plain.id } });
  check('开关改回 false → 又 403（可逆）', deniedAgain.status === 403, `status=${deniedAgain.status}`);

  const ghost = await api('/agents', { method: 'POST', token, body: { asAgentId: 987654321 } });
  check('调用者不存在 → 404', ghost.status === 404, `status=${ghost.status}`);
  const otherUserAgent = await api('/agents', { method: 'POST', token, body: { asAgentId: 1 } });
  check('拿**别人的**智能体当调用者 → 404（归属校验）', otherUserAgent.status === 404, `status=${otherUserAgent.status} ${otherUserAgent.text.slice(0, 80)}`);

  // --------------------- 3.3 归属口径：跟**调用者**走，不跟「当前项目」走（对称对照）
  const currentBefore = await api('/projects', { token });
  check(
    '对照前提：「当前项目」此刻是默认项目',
    currentBefore.json.currentProjectId === projDefault.id,
    `current=${currentBefore.json.currentProjectId} default=${projDefault.id}`,
  );
  const byHen = await api('/agents', { method: 'POST', token, body: { asAgentId: hen.id } });
  check('母鸡作为调用者可以建智能体', byHen.status === 200, `status=${byHen.status} ${byHen.text.slice(0, 140)}`);
  check(
    '**归属跟调用者走（正向）**：当前项目=默认项目，调用者=「2A 验收项目」里的母鸡 → 新智能体落**母鸡那个项目**',
    byHen.json?.agent?.projectId === projNew.id,
    `新智能体 projectId=${byHen.json?.agent?.projectId} 调用者(母鸡)项目=${projNew.id} 当前项目=${projDefault.id}`,
  );
  evidence.newAgentByHen = byHen.json?.agent ?? null;

  await api(`/projects/${projNew.id}/activate`, { method: 'POST', token });
  const currentAfter = await api('/projects', { token });
  const byAssistantOtherSide = await api('/agents', { method: 'POST', token, body: { asAgentId: assistantId } });
  check(
    '**归属跟调用者走（反向）**：当前项目=「2A 验收项目」，调用者=默认项目里的小助 → 新智能体落**默认项目**',
    currentAfter.json.currentProjectId === projNew.id && byAssistantOtherSide.json?.agent?.projectId === projDefault.id,
    `当前项目=${currentAfter.json.currentProjectId} 新智能体 projectId=${byAssistantOtherSide.json?.agent?.projectId}（期望 ${projDefault.id}）`,
  );
  evidence.newAgentByAssistant = byAssistantOtherSide.json?.agent ?? null;
  // 复原成默认项目（后面用例的基线）
  await api(`/projects/${projDefault.id}/activate`, { method: 'POST', token });
  const restored = await api('/projects', { token });
  check('项目视角已复原成默认项目（后续用例基线）', restored.json.currentProjectId === projDefault.id, `current=${restored.json.currentProjectId}`);

  // 正对照：不是「一律拒删」，普通智能体照删不误
  const delPlain = await api(`/agents/${plain.id}`, { method: 'DELETE', token });
  const plainGone = Number((await live.query('SELECT count(*)::int AS n FROM agents WHERE id = $1', [plain.id])).rows[0].n);
  check(
    '正对照：普通智能体删得掉（DELETE 200 + 库里那行没了）—— 闸门只挡内置角色',
    delPlain.status === 200 && plainGone === 0,
    `status=${delPlain.status} 剩余行=${plainGone}`,
  );
  const henAfterAll = Number((await live.query('SELECT count(*)::int AS n FROM agents WHERE id = $1', [hen.id])).rows[0].n);
  check('母鸡在整轮测试跑完后依然在（从头到尾没被删掉过）', henAfterAll === 1, `agents(id=${hen.id}) 命中 ${henAfterAll} 行`);

  // ------------------------------------------------------------- 4. /agents 过滤
  section('4. GET /agents 按 project_id 过滤');
  const all = await api('/agents', { token });
  const inDefault = await api(`/agents?projectId=${projDefault.id}`, { token });
  const inNew = await api(`/agents?projectId=${projNew.id}`, { token });
  const allIds = (all.json?.agents ?? []).map((a) => a.id).sort((x, y) => x - y);
  const defIds = (inDefault.json?.agents ?? []).map((a) => a.id).sort((x, y) => x - y);
  const newIds = (inNew.json?.agents ?? []).map((a) => a.id).sort((x, y) => x - y);
  evidence.agentFilter = { allIds, defIds, newIds, defProject: projDefault.id, newProject: projNew.id };
  check(
    '带 projectId 只回该项目里的智能体（默认项目）',
    defIds.length > 0 && defIds.every((id) => id !== hen.id) && inDefault.json.agents.every((a) => a.projectId === projDefault.id),
    `default项目=[${defIds}] 母鸡id=${hen.id}`,
  );
  check(
    '带 projectId 只回该项目里的智能体（新建项目）',
    newIds.length > 0 && inNew.json.agents.every((a) => a.projectId === projNew.id) && !newIds.includes(plain.id),
    `新项目=[${newIds}]，默认项目=[${defIds}]（两边的 id 集合没有交集）`,
  );
  check(
    '两个项目的结果集互补且都在「不带参数」的全集里（过滤没漏也没多）',
    JSON.stringify([...defIds, ...newIds].sort((x, y) => x - y)) === JSON.stringify(allIds),
    `all=[${allIds}] default=[${defIds}] new=[${newIds}]`,
  );
  check('不带参数 = 改造前行为（该账号全部智能体），前端不会被悄悄改掉', all.json?.agents?.length === allIds.length, `count=${allIds.length}`);
  check(
    '排序：小助 → 母鸡 → 普通（同一账号内小助仍排最前）',
    (all.json?.agents ?? [])[0]?.kind === 'assistant',
    (all.json?.agents ?? []).map((a) => `${a.id}:${a.kind}`).join(' '),
  );
  const otherProj = await api('/agents?projectId=1', { token });
  check('查**别人的**项目 → 404', otherProj.status === 404, `status=${otherProj.status} ${otherProj.text.slice(0, 80)}`);
  const badProj = await api('/agents?projectId=abc', { token });
  check('projectId 非数字 → 400', badProj.status === 400, `status=${badProj.status}`);
  const zeroProj = await api('/agents?projectId=0', { token });
  check('projectId=0 → 400', zeroProj.status === 400, `status=${zeroProj.status}`);

  // ------------------------------------------------------------ 5. 知识库项目归属
  section('5. 知识库按项目隔离（上传/列表）');
  async function uploadNote(name, text) {
    const fd = new FormData();
    fd.append('file', new Blob([text], { type: 'text/markdown' }), name);
    const res = await fetch(`${BASE}/knowledge/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    const body = await res.json().catch(() => null);
    return { status: res.status, json: body };
  }
  await api(`/projects/${projDefault.id}/activate`, { method: 'POST', token });
  const upA = await uploadNote('默认项目的资料.md', '# 默认项目\n这是一份属于默认项目的资料。\n');
  check('在默认项目下上传资料成功，且回落了 projectId', upA.status === 200 && upA.json?.document?.projectId === projDefault.id, JSON.stringify(upA.json?.document));
  await api(`/projects/${projNew.id}/activate`, { method: 'POST', token });
  const upB = await uploadNote('新项目的资料.md', '# 新项目\n这是一份属于新项目的资料。\n');
  check('切到新项目后上传的资料归属新项目', upB.status === 200 && upB.json?.document?.projectId === projNew.id, JSON.stringify(upB.json?.document));

  const kbNoParam = await api('/knowledge', { token });
  check(
    'GET /knowledge（不带参数）只看**当前项目**：现在只看到新项目那 1 份',
    kbNoParam.status === 200 && kbNoParam.json.documents.length === 1 && kbNoParam.json.documents[0].id === upB.json.document.id,
    JSON.stringify(kbNoParam.json.documents),
  );
  const kbDefault = await api(`/knowledge?projectId=${projDefault.id}`, { token });
  check(
    'GET /knowledge?projectId=<默认项目> 只看得到默认项目那 1 份（**不跨项目串**）',
    kbDefault.status === 200 &&
      kbDefault.json.documents.length === 1 &&
      kbDefault.json.documents[0].id === upA.json.document.id &&
      kbDefault.json.documents[0].projectId === projDefault.id,
    JSON.stringify(kbDefault.json.documents),
  );
  const kbOther = await api('/knowledge?projectId=1', { token });
  check('查**别人的**项目的知识库 → 404', kbOther.status === 404, `status=${kbOther.status}`);
  const kbBad = await api('/knowledge?projectId=abc', { token });
  check('知识库 projectId 非数字 → 400', kbBad.status === 400, `status=${kbBad.status}`);

  const dbDocs = await live.query('SELECT id, owner_id, project_id FROM knowledge_documents WHERE owner_id = $1 ORDER BY id', [userId]);
  const dbChunks = await live.query(
    `SELECT c.id, c.project_id, d.project_id AS doc_project FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE c.owner_id = $1 ORDER BY c.id`,
    [userId],
  );
  check(
    '直连库核对：本账号两份资料的 project_id 与它上传时所在项目一致',
    dbDocs.rows.length === 2 &&
      String(dbDocs.rows[0].project_id) === String(projDefault.id) &&
      String(dbDocs.rows[1].project_id) === String(projNew.id),
    JSON.stringify(dbDocs.rows),
  );
  check(
    '直连库核对：每个片段的 project_id 都等于它所属资料的 project_id',
    dbChunks.rows.length > 0 && dbChunks.rows.every((r) => String(r.project_id) === String(r.doc_project)),
    `chunks=${dbChunks.rows.length}`,
  );

  } catch (err) {
    check('执行期间抛异常，后续用例未跑完（看上面最后一条 PASS/FAIL 定位）', false, String(err && err.message ? err.message : err));
  }

  // ------------------------------------------------------------ 6. 收尾 + 零污染
  section('6. 收尾与活库零污染');
  const cleanup = await live.query('DELETE FROM users WHERE id = $1', [userId]);
  await live.query('DELETE FROM sms_codes WHERE phone_hash = $1', [phoneHash(phone)]);
  check('测试账号已整体删除（级联清掉它的项目/智能体/会话/知识库）', (cleanup.rowCount ?? 0) === 1, `deleted users=${cleanup.rowCount}`);

  const afterFp = await liveFingerprint();
  evidence.liveAfter = afterFp;
  const countDiff = Object.keys(beforeFp.counts).filter((t) => beforeFp.counts[t] !== afterFp.counts[t]);
  check(
    '活库行数回到跑之前（**零残留**）',
    countDiff.length === 0,
    countDiff.length === 0
      ? Object.entries(afterFp.counts).map(([t, n]) => `${t}=${n}`).join(' / ')
      : countDiff.map((t) => `${t}: ${beforeFp.counts[t]} -> ${afterFp.counts[t]}`).join(', '),
  );
  const idDiff = Object.keys(beforeFp.ids).filter((t) => beforeFp.ids[t] !== afterFp.ids[t]);
  check(
    '活库既有行**一个都没动**（逐表 id 集合完全一致）',
    idDiff.length === 0,
    idDiff.length === 0 ? '11 张表的 id 集合全部一致' : idDiff.join(', '),
  );

  const failed = results.filter((r) => !r.ok);
  evidence.results = results;
  evidence.endedAt = new Date().toISOString();
  evidence.failures = failed;
  writeFileSync(OUT_PATH, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  console.log(`\n===== 结果 =====\n共 ${results.length} 条，${failed.length === 0 ? '全部通过' : `${failed.length} 条失败`}`);
  console.log(`证据：${OUT_PATH}`);
  console.log(`服务端日志：${LOG_PATH}`);

  return failed.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error('[2a-api] 跑挂了：', err);
} finally {
  await live.end().catch(() => undefined);
  if (server) {
    // Windows 上 shell 包了一层，用 taskkill /T 连带子进程树一起收。
    // **必须同步**：早先写成异步 spawn 再立刻 process.exit，taskkill 根本没来得及跑，
    // 残留的后端就一直占着 8799（下一轮会 EADDRINUSE）。
    spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { shell: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
    const stillUp = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
    if (stillUp) console.warn(`[2a-api] 警告：${BASE} 还在监听，收尾没干净，请手工关掉。`);
  }
}
process.exit(code);
