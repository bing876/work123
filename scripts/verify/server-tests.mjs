/**
 * 子阶段 A 服务端侧验收：改造点 2（状态按 wcId 分片）+ 改造点 3（advance 重入保护）。
 * 零依赖；token 从临时文件读，不打印。
 *
 * 用法：node server-tests.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const TOKEN = readFileSync('C:/Users/bing/AppData/Local/Temp/subA/token.txt', 'utf8').trim();
const OUT = 'C:/Users/bing/AppData/Local/Temp/subA/server-tests.json';

const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
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

// ---------------------------------------------------------------------------
// 找一个属于自己的智能体（两路循环用同一个，验证「同一智能体多任务」）
// ---------------------------------------------------------------------------
const agents = await req('GET', '/agents');
const agentList = agents.json?.agents ?? agents.json ?? [];
const agentId = Array.isArray(agentList) && agentList.length ? Number(agentList[0].id) : null;
console.log('agentId =', agentId, '（取列表第一个）');

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

// 清理：把这几路循环停掉
for (const id of [loopId, a.json?.loopId, b.json?.loopId]) {
  if (id) await req('POST', '/agent/loop/stop', { loopId: id, reason: 'acceptance_cleanup' });
}

result.finishedAt = new Date().toISOString();
result.pass = result.checks.every((c) => c.ok);
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n== 服务端侧验收：${result.pass ? '全部通过' : '有失败项'} ==`);
process.exit(result.pass ? 0 : 1);
