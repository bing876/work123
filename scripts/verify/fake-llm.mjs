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
/** Phase 3：登录态测试站的**服务端原始请求日志**（JSONL，带每个请求实际带的 Cookie） */
const SITE_LOG = process.env.SITE_LOG || '';

if (LOG) writeFileSync(LOG, '');
if (SITE_LOG) writeFileSync(SITE_LOG, '');

/** Phase 3：站点侧逐请求记录 —— 「哪个分区（= 哪个项目）带着谁的 cookie 来」以这里为准 */
function logSite(rec) {
  const line = JSON.stringify({ at: Date.now(), iso: new Date().toISOString(), ...rec });
  if (SITE_LOG) {
    try {
      appendFileSync(SITE_LOG, `${line}\n`);
    } catch {
      /* 记不上不影响验收本身 */
    }
  }
  console.log(line);
}

/** 从 Cookie 头里抠出验证站点用的那个 sid */
function sidOf(cookieHeader) {
  const m = /(?:^|;\s*)wbsid=([^;]+)/.exec(cookieHeader || '');
  return m ? m[1] : '';
}

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

/* ===========================================================================
 * Phase 3 · 登录态测试站（**纯增量**：下面这些都是新路由，上面 2a/2b/desk 用到的
 *   /page-* / /form / /health / chat-completions 一律没动）
 *
 * 它存在的理由：验证「登录态隔离粒度」不能靠猜，得有一个**真站点**：
 *   - /sid?name=X   —— 真的下发一个 `Set-Cookie: wbsid=X`，并在页面里写 localStorage
 *   - /whoami?name=X —— 一个**只读**页面：把「服务端看到的 cookie」和「页面读到的
 *     cookie / localStorage」都渲染出来，还会挂一个真下载链接
 *   - /dl?name=X    —— 真的回一个 Content-Disposition: attachment，触发 Electron 的下载落盘
 *
 * 每个请求都写进 SITE_LOG：**服务端收到的那份 cookie 是原始证据**
 * —— 「同项目的 B 打开就是登录态」「跨项目的 B 打开是游客」都不用听界面说，看这里。
 * ========================================================================= */

/** 测试站点页：把当前会话状态渲染出来 + 一个真下载链接 */
function sitePage(name) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录态测试站</title></head>
<body>
  <h1 id="h1">登录态测试站</h1>
  <p id="state">…</p>
  <p>本页身份标记：<b id="who">${name}</b></p>
  <p><a id="dl" href="/dl/${name}">下载一个归属测试文件</a></p>
  <button id="relogin" type="button">以「${name}」身份登录（写 cookie + localStorage）</button>
  <script>
    var NAME = ${JSON.stringify(name)};
    function render() {
      var cookie = document.cookie || '';
      var local = localStorage.getItem('wbwho') || '';
      var sid = (cookie.match(/(?:^|;\\s*)wbsid=([^;]+)/) || [])[1] || '';
      document.getElementById('state').textContent =
        (sid ? 'LOGGED-IN sid=' + sid : 'GUEST sid=') + ' | local=' + (local || '(空)');
      window.__site = { name: NAME, cookie: cookie, local: local, sid: sid,
                        href: location.href, at: Date.now() };
    }
    document.getElementById('relogin').addEventListener('click', function () {
      localStorage.setItem('wbwho', NAME);
      fetch('/sid/' + encodeURIComponent(NAME), { credentials: 'include' })
        .then(function () {
          // 登录后**重新走一次这个地址**（而不是只 render）：这样站点侧会再收到一条
          // 带新 cookie 的 /whoami 请求，「服务端看到的是谁」与页面侧才是同一次事实。
          location.reload();
        });
    });
    render();
  </script>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const cookieHeader = req.headers.cookie || '';
  /**
   * Phase 3：站点的身份标记走**路径**（/whoami/<name>）而不是 query ——
   * 渲染层「打开 <地址>」的识别正则不含 `?`，带 query 的地址会被截断。
   * 两种写法都认，路径优先。
   */
  const argName = url.pathname.split('/').filter(Boolean)[1] || url.searchParams.get('name') || 'anon';
  const route = url.pathname.startsWith('/sid') ? '/sid'
    : url.pathname.startsWith('/whoami') ? '/whoami'
      : url.pathname.startsWith('/dl') ? '/dl' : '';

  // ---- Phase 3 登录站：所有请求先落一条原始日志（带服务端实际收到的 cookie）----
  if (route) {
    logSite({
      path: route,
      routePath: url.pathname,
      name: argName,
      cookie: cookieHeader,
      sid: sidOf(cookieHeader),
      ua: String(req.headers['user-agent'] || '').slice(0, 60),
    });
  }

  /** 登录：真的下发 cookie（非 HttpOnly，页面自己也读得到，两条证据能对上） */
  if (req.method === 'GET' && route === '/sid') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': `wbsid=${encodeURIComponent(argName)}; Path=/; Max-Age=3600`,
    });
    res.end(`sid=${argName}`);
    return;
  }

  /** 只读的「我是谁」页：cookie / localStorage / 服务端视角三样都摆出来 */
  if (req.method === 'GET' && route === '/whoami') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(sitePage(argName));
    return;
  }

  /** 下载：回 attachment，触发 Electron 的 will-download（落盘归属在那边算） */
  if (req.method === 'GET' && route === '/dl') {
    const body = `Phase 3 归属测试文件\n触发者标记：${argName}\n服务端看到的 sid：${sidOf(cookieHeader) || '(无)'}\n`;
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="wb3-${argName}.txt"`,
    });
    res.end(body);
    return;
  }

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
