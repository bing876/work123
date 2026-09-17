/**
 * 子阶段 A 服务端侧验收：改造点 2（状态按 wcId 分片）+ 改造点 3（advance 重入保护）。
 * 零依赖；token 从临时文件读，不打印。
 *
 * 用法：node server-tests.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = 'C:/Users/bing/workbuddy-ai/work123';
/**
 * 直连数据库读 conversations 的**原始列**。
 * 为什么要它：`GET /chat/state` 现在带「读侧兜底合并」（会话级为空时用页级补），
 * 不能再拿它当「conversations 有没有被覆写」的原始证据 —— 那会自证自话。
 * 密钥只进内存，绝不打印。
 */
function envOf() {
  const txt = readFileSync(`${ROOT}/apps/server/.env`, 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const requireRoot = createRequire(`${ROOT}/`);
const { Pool } = requireRoot('pg');
const rawPool = new Pool({ connectionString: envOf().DATABASE_URL });
async function rawConv(id) {
  const r = await rawPool.query(
    'SELECT current_task, latest_user_intent, last_page_summary, browser_confirmed, keepalive FROM conversations WHERE id = $1',
    [id],
  );
  return r.rows[0] ?? null;
}

const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const TOKEN = readFileSync('C:/Users/bing/AppData/Local/Temp/subA/token.txt', 'utf8').trim();
const OUT = 'C:/Users/bing/AppData/Local/Temp/subA/server-tests.json';

const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    // 没有 body 就别带 content-type：Fastify 对「声明 json 却是空 body」会直接 400
    headers: body === undefined ? { authorization: `Bearer ${TOKEN}` } : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

const snapshot = (url, title, loginLike = false) => ({
  url,
  title,
  buttons: ['普通按钮'],
  links: [],
  inputs: ['[普通输入框]'],
  texts: ['这是子阶段 A 验收用的本地测试页。'],
  loginLike,
  overlay: false,
});

const result = { startedAt: new Date().toISOString(), checks: [] };
function record(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${JSON.stringify(detail)}`);
}
function skip(name, why) {
  result.checks.push({ name, ok: null, skipped: why });
  console.log(`SKIP  ${name} :: ${why}`);
}

/** 库不在（Docker Desktop 没起）时，依赖 conversations 的断言没法验 —— 明确标 SKIP，不冒充通过 */
const health0 = await req('GET', '/health');
const DB_UP = health0.json?.db === 'up';
console.log('DB =', health0.json?.db, DB_UP ? '' : '（依赖数据库的断言本次会标 SKIP）');

// ---------------------------------------------------------------------------
// 找一个属于自己的智能体（两路循环用同一个，验证「同一智能体多任务」）
// ---------------------------------------------------------------------------
const agents = await req('GET', '/agents');
const agentList = agents.json?.agents ?? agents.json ?? [];
const agentId = DB_UP && Array.isArray(agentList) && agentList.length ? Number(agentList[0].id) : null;
console.log('agentId =', agentId, '（取列表第一个；库不在时为 null，走不查库的那条路）');

// ---------------------------------------------------------------------------
// 验收 7：advance() 重入保护 —— 同一条 loopId 并发两次 next
// ---------------------------------------------------------------------------
const s7 = await req('POST', '/agent/loop/start', { agentId, goal: '重入保护验收：同一条循环并发推进', wcId: 70001 });
const loopId = s7.json?.loopId;
console.log('loopId =', loopId, 'status', s7.status);

const first = req('POST', '/agent/loop/next', { loopId, agentId, wcId: 70001 });
await new Promise((r) => setTimeout(r, 250)); // 第一次请求此刻正挂在模型调用上（假模型固定延迟 1200ms）
const second = req('POST', '/agent/loop/next', { loopId, agentId, wcId: 70001 });
const [r1, r2] = await Promise.all([first, second]);
const busy = [r1, r2].filter((x) => x.status === 409);
const okOnes = [r1, r2].filter((x) => x.status === 200);
record('7.1 并发两次 next：恰好一次成功', okOnes.length === 1 && busy.length === 1, {
  statuses: [r1.status, r2.status],
});
record('7.2 被拒的那次是 409 + code=loop_busy + 明确话术', busy.length === 1 && busy[0].json?.code === 'loop_busy' && /正在推进中/.test(busy[0].json?.error ?? ''), {
  code: busy[0]?.json?.code,
  error: busy[0]?.json?.error,
});
// 被拒之后循环仍然可用（说明拒绝没有把循环弄坏）
const after = await req('POST', '/agent/loop/next', { loopId, agentId, wcId: 70001 });
record('7.3 被拒后循环仍可正常推进（没被拒绝搞坏）', after.status === 200 && typeof after.json?.decision?.kind === 'string', {
  status: after.status,
  kind: after.json?.decision?.kind,
});

// ---------------------------------------------------------------------------
// 验收 4：状态隔离 —— 两个并发任务（同一智能体、两张页）各自的 current_task /
//         last_page_summary 不互相覆盖
// ---------------------------------------------------------------------------
const a = await req('POST', '/agent/loop/start', { agentId, goal: '甲任务：在 A 页上找报价', wcId: 70011 });
const b = await req('POST', '/agent/loop/start', { agentId, goal: '乙任务：在 B 页上找联系方式', wcId: 70012 });
console.log('loopA =', a.json?.loopId, 'loopB =', b.json?.loopId);

// 两个循环并发推进，各喂各的页面快照（模拟桌面各自那张页的回执）
const [pa, pb] = await Promise.all([
  req('POST', '/agent/loop/next', {
    loopId: a.json?.loopId,
    agentId,
    wcId: 70011,
    result: { ok: true, detail: '读当前页', page: snapshot('http://127.0.0.1:8899/page-a', '验收页 PAGE-A') },
  }),
  req('POST', '/agent/loop/next', {
    loopId: b.json?.loopId,
    agentId,
    wcId: 70012,
    result: { ok: true, detail: '读当前页', page: snapshot('http://127.0.0.1:8899/page-b', '验收页 PAGE-B') },
  }),
]);
record('4.0 两路并发推进都成功', pa.status === 200 && pb.status === 200, { statuses: [pa.status, pb.status] });

const stA = await req('GET', '/agent/loop/state?wcId=70011');
const stB = await req('GET', '/agent/loop/state?wcId=70012');
const list = await req('GET', '/agent/loop/state');
const A = stA.json?.state;
const B = stB.json?.state;
record('4.1 两张页各自有独立的分片记录', Boolean(A) && Boolean(B) && A.wcId === 70011 && B.wcId === 70012, {
  wcIds: [A?.wcId, B?.wcId],
});
record('4.2 current_task 不串位', A?.current_task === '甲任务：在 A 页上找报价' && B?.current_task === '乙任务：在 B 页上找联系方式', {
  A: A?.current_task,
  B: B?.current_task,
});
record(
  '4.3 last_page_summary 不串位（各是自己那张页）',
  /page-a/.test(A?.last_page_summary ?? '') && /page-b/.test(B?.last_page_summary ?? '') && A?.last_page_summary !== B?.last_page_summary,
  { A: A?.last_page_summary, B: B?.last_page_summary },
);
record('4.4 分片表里确实有这两条（诊断接口可读）', (list.json?.count ?? 0) >= 2, { count: list.json?.count, pages: (list.json?.pages ?? []).map((p) => p.wcId) });

// 再各自推进一步（换一张页），证明「页级状态跟着自己那张页走」
await Promise.all([
  req('POST', '/agent/loop/next', {
    loopId: a.json?.loopId,
    agentId,
    wcId: 70011,
    result: { ok: true, detail: '读当前页', page: snapshot('http://127.0.0.1:8899/page-a?p=2', '验收页 PAGE-A 第二屏') },
  }),
  req('POST', '/agent/loop/next', {
    loopId: b.json?.loopId,
    agentId,
    wcId: 70012,
    result: { ok: true, detail: '读当前页', page: snapshot('http://127.0.0.1:8899/page-b?p=2', '验收页 PAGE-B 第二屏') },
  }),
]);
const stA2 = await req('GET', '/agent/loop/state?wcId=70011');
const stB2 = await req('GET', '/agent/loop/state?wcId=70012');
record(
  '4.5 各自推进后仍各写各的（无交叉覆写）',
  /page-a\?p=2/.test(stA2.json?.state?.last_page_summary ?? '') && /page-b\?p=2/.test(stB2.json?.state?.last_page_summary ?? ''),
  { A: stA2.json?.state?.last_page_summary, B: stB2.json?.state?.last_page_summary },
);

// 归属隔离：别人的 wcId 读不到
const alien = await req('GET', '/agent/loop/state?wcId=70099');
record('4.6 没在册的页 → 404（不泄漏）', alien.status === 404, { status: alien.status, error: alien.json?.error });

const health = await req('GET', '/health');
record('4.7 /health 暴露 pageStates 计数', typeof health.json?.pageStates === 'number' && health.json.pageStates >= 2, {
  pageStates: health.json?.pageStates,
});

// ---------------------------------------------------------------------------
// 验收 2 补充：任务轮**不再覆写 conversations**（改造点 2 的核心断言）
// ---------------------------------------------------------------------------
if (!DB_UP) {
  skip('2.0-2.5 任务轮不再覆写 conversations', '数据库不在（Docker Desktop 未运行），这几条要读 conversations 才能对照');
} else {
/**
 * 用一个**全新的临时智能体**做实验：它的会话是新建的，`current_task` 一定是空的，
 * 这样「会话级为空 → 读侧用页级补上」这条断言才有意义（拿老会话验会被旧值掩盖）。
 * 验完即删。
 */
const mk = await req('POST', '/agents', {});
const tmpAgent = Number(mk.json?.agent?.id);
const convId = Number(mk.json?.agent?.conversationId);
record('2.0 建一个临时智能体（会话全新、状态为空）', Number.isInteger(tmpAgent) && Number.isInteger(convId), {
  agentId: tmpAgent,
  convId,
});
const rawBefore = await rawConv(convId);
record('2.0b 新会话的任务态列确实是空的', !rawBefore.current_task && !rawBefore.latest_user_intent && !rawBefore.last_page_summary, {
  raw_before: rawBefore,
});
/** 每次跑用**全新的 wcId**：分片键是按页存的，复用旧键会读到上一轮留下的条目 */
const wcTask = 70021 + (Date.now() % 1000);
// 走**真实的**任务轮入口（/chat/stream + taskMode + wcId）——一次模型都不调，只建循环。
// browserOpened 与桌面真实调用一致（桌面开好页才会发任务轮）。
const chatRes = await fetch(`${BASE}/chat/stream`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    conversationId: convId,
    agentId: tmpAgent,
    message: '任务轮分片断言：去 A 页把报价抄下来',
    taskMode: true,
    pageUrl: 'http://127.0.0.1:8899/page-a',
    browserOpened: 'http://127.0.0.1:8899/page-a',
    wcId: wcTask,
  }),
});
const sseText = await chatRes.text();
record('2.1 任务轮返回 200 且带 loopId', chatRes.status === 200 && /"loopId"/.test(sseText), {
  status: chatRes.status,
  hasLoopId: /"loopId"/.test(sseText),
});
const ps = await req('GET', `/agent/loop/state?wcId=${wcTask}`);
const afterConv = await req('GET', `/chat/state?agentId=${tmpAgent}`);
record('2.2 任务态写进了**按 wcId 分片**的存储', ps.status === 200 && ps.json?.state?.current_task === '任务轮分片断言：去 A 页把报价抄下来', {
  status: ps.status,
  current_task: ps.json?.state?.current_task,
  latest_user_intent: ps.json?.state?.latest_user_intent,
  last_page_summary: ps.json?.state?.last_page_summary,
});
const rawAfter = await rawConv(convId);
record(
  '2.3 【直连数据库】conversations 的任务态列一行都没被覆写（仍是空）',
  rawAfter.current_task === rawBefore.current_task &&
    rawAfter.latest_user_intent === rawBefore.latest_user_intent &&
    rawAfter.last_page_summary === rawBefore.last_page_summary,
  {
    before: { current_task: rawBefore.current_task, latest_user_intent: rawBefore.latest_user_intent, last_page_summary: rawBefore.last_page_summary },
    after: { current_task: rawAfter.current_task, latest_user_intent: rawAfter.latest_user_intent, last_page_summary: rawAfter.last_page_summary },
  },
);
record('2.4 conversations 上仍保留了 agent 级聚合标志 browser_confirmed', rawAfter.browser_confirmed === true, {
  raw_browser_confirmed: rawAfter.browser_confirmed,
  keepalive: rawAfter.keepalive,
});
record(
  '2.5 【读侧兜底】GET /chat/state 会话级为空时用页级补上当前任务（桌面那一行不断档）',
  afterConv.json?.state?.current_task === '任务轮分片断言：去 A 页把报价抄下来' &&
    !rawAfter.current_task,
  {
    raw_conversations_current_task: rawAfter.current_task,
    api_chat_state_current_task: afterConv.json?.state?.current_task,
    api_last_page_summary: afterConv.json?.state?.last_page_summary,
  },
);
// 收尾：临时智能体删掉（会话/消息/记忆级联），不留垃圾
const del = await req('DELETE', `/agents/${tmpAgent}`);
record('2.6 临时智能体已删除（不留垃圾数据）', del.status === 200 && del.json?.ok === true, { status: del.status });
// 收尾：任务轮建的那个循环也要停掉（它没人驱动，会以 running 挂在内存里占 liveLoops 计数）
const taskLoopId = (sseText.match(/"loopId":"([^"]+)"/) ?? [])[1];
if (taskLoopId) {
  const st = await req('POST', '/agent/loop/stop', { loopId: taskLoopId, reason: 'acceptance_cleanup' });
  record('2.7 任务轮建的服务端循环已停止（不留 running 记账）', st.status === 200, { loopId: taskLoopId, stopped: st.json?.stopped });
}
}

// ---------------------------------------------------------------------------
// 跨智能体硬闸回归：A 的循环带 B 的 agentId / 别的 wcId 推进 → 409
// ---------------------------------------------------------------------------
if (!DB_UP) {
  skip('8.1/8.2 跨智能体硬闸回归', '数据库不在：/agent/loop/start 带 agentId 要查归属（ownsAgent）');
} else {
const x1 = await req('POST', '/agent/loop/start', { agentId: 1, goal: '跨智能体硬闸回归', wcId: 70031 });
const mismatchAgent = await req('POST', '/agent/loop/next', { loopId: x1.json?.loopId, agentId: 8, wcId: 70031 });
const mismatchPage = await req('POST', '/agent/loop/next', { loopId: x1.json?.loopId, agentId: 1, wcId: 70032 });
record('8.1 带别的智能体号推进 → 409 agent_mismatch', mismatchAgent.status === 409 && mismatchAgent.json?.code === 'agent_mismatch', {
  status: mismatchAgent.status,
  code: mismatchAgent.json?.code,
  error: mismatchAgent.json?.error,
});
record('8.2 带别的页号推进 → 409 page_mismatch', mismatchPage.status === 409 && mismatchPage.json?.code === 'page_mismatch', {
  status: mismatchPage.status,
  code: mismatchPage.json?.code,
  error: mismatchPage.json?.error,
});
await req('POST', '/agent/loop/stop', { loopId: x1.json?.loopId, reason: 'acceptance_cleanup' });
}

// 清理：把这几路循环停掉
for (const id of [loopId, a.json?.loopId, b.json?.loopId]) {
  if (id) await req('POST', '/agent/loop/stop', { loopId: id, reason: 'acceptance_cleanup' });
}

result.finishedAt = new Date().toISOString();
result.dbUp = DB_UP;
result.pass = result.checks.every((c) => c.ok !== false);
result.skipped = result.checks.filter((c) => c.ok === null).map((c) => c.name);
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n== 服务端侧验收：${result.pass ? '已跑的断言全部通过' : '有失败项'} ==  跳过：${result.skipped.length ? result.skipped.join(' / ') : '无'}`);
process.exit(result.pass ? 0 : 1);
