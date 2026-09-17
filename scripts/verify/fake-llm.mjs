/**
 * 子阶段 A 的**验收用假模型 + 测试页**（零依赖，只用 node:http）。
 *
 * 为什么要它（而不是真调 DeepSeek）：
 *   1. **可复现的并发时间线** —— 真模型的响应时间抖动很大，两路循环到底有没有真的重叠，
 *      会被「谁先谁后」的运气掩盖。这里每次响应固定延迟 `FAKE_DELAY_MS`，
 *      并发是否真发生由**请求日志的进入/离开时间戳**直接看出来。
 *   2. **不烧 token、不依赖外网**；
 *   3. **状态可分辨** —— 每个目标回一句带目标前缀的结论，用来证明两路任务的状态没有串位。
 *
 * 它同时是个静态站：`/page-a`、`/page-b`、`/form`（含密码/验证码/支付按钮，供安全红线复验）。
 *
 * 用法：
 *   node scripts/verify/fake-llm.mjs            # 监听 8899
 *   FAKE_PORT=8899 FAKE_DELAY_MS=1200 FAKE_STEPS=8 FAKE_LOG=<path> node scripts/verify/fake-llm.mjs
 *
 * 日志（JSONL，每行一次模型请求，带毫秒时间戳）：
 *   {"ev":"req","at":<ms>,"iso":"...","goal":"...","step":1,"kind":"read_page"}
 *   {"ev":"res","at":<ms>,"iso":"...","goal":"...","step":1,"kind":"read_page","dur":1203}
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.FAKE_PORT || 8899);
/** 每次模型响应的固定延迟（毫秒）—— 并发时间线靠它撑开 */
const DELAY_MS = Number(process.env.FAKE_DELAY_MS || 1200);
/** 每条循环在 stop(done) 之前先走几步 read_page */
const STEPS = Number(process.env.FAKE_STEPS || 4);
const LOG = process.env.FAKE_LOG || '';

if (LOG) writeFileSync(LOG, '');

function log(obj) {
  const line = JSON.stringify({ at: Date.now(), iso: new Date().toISOString(), ...obj });
  if (LOG) {
    try {
      appendFileSync(LOG, `${line}\n`);
    } catch {
      /* 记不上不影响验收本身 */
    }
  }
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从循环的第一条用户消息里抠出任务目标 */
function goalOf(messages) {
  for (const m of messages) {
    if (m && m.role === 'user' && typeof m.content === 'string') {
      const hit = m.content.match(/任务目标：(.+)/);
      if (hit) return hit[1].trim().slice(0, 80);
    }
  }
  return '(无目标)';
}

/** 已经执行过几步（历史里有几条 tool 回执） */
function stepsDone(messages) {
  return messages.filter((m) => m && m.role === 'tool').length;
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 决定这一步回什么（同一套规则，纯函数，方便复算） */
function decide(messages) {
  const goal = goalOf(messages);
  const done = stepsDone(messages);
  const step = done + 1;
  if (done < STEPS) {
    return { goal, step, kind: 'read_page', message: { role: 'assistant', content: `第 ${step} 步：先读当前页。`, tool_calls: [toolCall(`call_${Date.now()}_${step}`, 'read_page', {})] } };
  }
  // 结论里带上**目标前缀**：两路任务的结论因此可分辨，用来证明状态没串位
  return {
    goal,
    step,
    kind: 'stop',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        toolCall(`call_${Date.now()}_${step}`, 'stop', {
          reason: 'done',
          summary: `【假模型结论】目标=${goal} 已走完 ${done} 步`,
          document_title: `验收记录 ${goal.slice(0, 20)}`,
          document_outline: [`目标：${goal}`, `步数：${done}`],
        }),
      ],
    },
  };
}

const PAGE = (title, extra = '') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <p>这是子阶段 A 验收用的本地测试页。</p>
  <input id="q1" type="text" placeholder="普通输入框">
  <button id="btn1">普通按钮</button>
  ${extra}
</body></html>`;

const FORM_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>敏感闸复验页</title></head>
<body>
  <h1>敏感闸复验页</h1>
  <label>账号 <input id="u1" type="text" placeholder="账号"></label>
  <label>密码 <input id="pw1" type="password" placeholder="密码"></label>
  <label>短信验证码 <input id="otp1" type="text" placeholder="短信验证码"></label>
  <label>普通框 <input id="q1" type="text" placeholder="普通输入框"></label>
  <button id="pay1">立即支付</button>
  <button id="ok1">普通按钮</button>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(raw));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  // ---- 测试页 ----
  if (req.method === 'GET' && url.pathname.startsWith('/page-')) {
    const name = url.pathname.slice(1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE(`验收页 ${name.toUpperCase()}`));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/form') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FORM_PAGE);
    return;
  }

  // ---- 模型接口 ----
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 解析不了就当空 */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const plan = decide(messages);
    const entered = Date.now();
    log({ ev: 'req', goal: plan.goal, step: plan.step, kind: plan.kind });
    await sleep(DELAY_MS);
    log({ ev: 'res', goal: plan.goal, step: plan.step, kind: plan.kind, dur: Date.now() - entered });

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const payload = { choices: [{ delta: { content: plan.message.content || '' }, index: 0 }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: body.model || 'fake', choices: [{ index: 0, message: plan.message, finish_reason: 'tool_calls' }] }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fake: true, delayMs: DELAY_MS, steps: STEPS }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-llm] http://127.0.0.1:${PORT} delay=${DELAY_MS}ms steps=${STEPS} log=${LOG || '(无)'}`);
});
