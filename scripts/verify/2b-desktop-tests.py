"""子阶段 2-B 真机验收：**项目层接进前端之后，在真 Electron 窗口里真点真敲**。

它自己起一整套环境（假模型 + 假页面 + 验收后端 + vite + 真 Electron 窗口），跑完自己收干净：
自己的端口一律另起（8799 / 8899 / 5273 / 9333），**用户自己的 8787 / 5173 一律不动**。

四条验收标准（== 总控给的原文）：
  1. 「＋ 添加」按钮修复后正常工作，新建智能体归属正确；
  2. 创建 2 个项目并来回切换，智能体列表互不串；
  3. 【最关键】在项目 A 的某智能体里启动一个耗时浏览器任务，切到项目 B，
     过一段时间再切回项目 A —— 该任务全程没被打断，一直在后台正常执行；
  4. 知识库文件上传后正确关联当前项目，不同项目数据互相隔离。

取证手段（都是客观量，不靠嘴说）：
  · **渲染层 fetch 记录器**：在页面里包一层 window.fetch，把 App **真实发出的**请求记下来 ——
    「POST /agents 的 body 里到底带了哪个 asAgentId」这类事实只能这么看（服务端 logger 是关的）；
  · **假模型 JSONL 时间戳**：每次模型调用记 req/res 的毫秒时间戳。整条任务只有桌面主进程在驱动
    （渲染层不直连 CDP、也不发 /agent/loop/next），所以「切换窗口内模型调用还在连续发生」
    就是「桌面那一路驾驶没断」的硬证据；真模型的延迟抖动会掩盖这件事，所以用固定延迟假模型。
  · **主进程任务状态**（`workbench.getTaskState(wcId)` 走 IPC）：司机权威状态在**主进程**，
    在项目 B 的界面上采样它，就能证明「人不在 A 的那段时间里，A 那一路还在推进」；
  · **内嵌页自己的 JS 计数器**：往测试页注入 setInterval 计数 + 记 performance.timeOrigin，
    切回来读一次 —— 计数涨了、timeOrigin 没变 ⇒ 那张页**从没被重载、一直在跑**；
  · **直连库读原始行**（scripts/verify/dbq.mjs）：智能体/资料归属以库为准；
  · 截图为辅，不作判据。

用法：
  ~/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/verify/2b-desktop-tests.py
可覆盖环境变量：API_PORT / FAKE_PORT / VITE_PORT / CDP_PORT / FAKE_DELAY_MS / FAKE_STEPS。
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'substage-2b')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb2b')
PROFILE = os.path.join(TMP, 'profile')

API_PORT = int(os.environ.get('API_PORT', '8799'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8899'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5273'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9333'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
PAGE_URL = '%s/page-a' % FAKE
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)

# 耗时任务：每步模型延迟 2.5s × 9 次调用 ⇒ 整条任务 ~25s，
# 足够「切走 → 在别的项目里待一会儿 → 切回来」，也让时间戳证据有分辨力。
FAKE_DELAY_MS = int(os.environ.get('FAKE_DELAY_MS', '2500'))
FAKE_STEPS = int(os.environ.get('FAKE_STEPS', '8'))
MARK = 'SPAN-2B-PA'

TEST_PHONE = '18600002201'

os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

NODE = shutil.which('node') or r'C:\Users\bing\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'

procs = {}
results = []
evidence = {
    'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'ports': {'api': API_PORT, 'fake': FAKE_PORT, 'vite': VITE_PORT, 'cdp': CDP_PORT},
    'fakeModel': {'delayMs': FAKE_DELAY_MS, 'steps': FAKE_STEPS, 'pageUrl': PAGE_URL},
    'results': [],
}
test_user = None


# --------------------------------------------------------------------- 基础工具
def check(name, ok, detail=''):
    line = {'name': name, 'ok': bool(ok), 'detail': str(detail)[:700]}
    results.append(line)
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, (' :: ' + line['detail']) if detail else ''))
    return bool(ok)


def section(title):
    print('\n───── %s ─────' % title)


def now_ms():
    return int(time.time() * 1000)


def http_json(path, method='GET', token=None, body=None, base=API, timeout=30):
    data = None
    headers = {}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw[:1] in ('{', '[') else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except Exception:  # noqa: BLE001
            return e.code, raw


def dbq(sql, params=None):
    """直连库读原始行（只读工具，只放 SELECT / WITH）。"""
    cmd = [NODE, os.path.join(HERE, 'dbq.mjs'), sql]
    if params is not None:
        cmd.append(json.dumps(params, ensure_ascii=False))
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise RuntimeError('dbq 失败：%s' % ((r.stderr or r.stdout or '')[:400]))
    return json.loads(r.stdout or '[]')


def port_busy(port):
    out = subprocess.run(['netstat', '-ano'], capture_output=True, text=True,
                         encoding='utf-8', errors='replace').stdout
    return any((':%d ' % port) in line and 'LISTENING' in line for line in out.splitlines())


def spawn(name, cmd, cwd, env=None, log=None):
    e = dict(os.environ)
    e.pop('ELECTRON_RUN_AS_NODE', None)  # TOOLING：带着它 Electron 当 Node 跑，0 秒崩
    if env:
        e.update(env)
    f = open(log, 'wb') if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f,
                         stderr=(subprocess.STDOUT if log else subprocess.DEVNULL))
    procs[name] = {'p': p, 'f': f if log else None}
    print('[spawn] %-8s pid=%d %s' % (name, p.pid, ' '.join(cmd[:4])))
    return p


def kill_all():
    for name, rec in list(procs.items()):
        p = rec['p']
        if p.poll() is None:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
        if rec['f']:
            rec['f'].close()
        procs.pop(name, None)


def wait_health(base, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            st, j = http_json('/health', base=base, timeout=5)
            if st == 200:
                return j
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.4)
    raise RuntimeError('服务 90 秒没起来：%s' % base)


# ------------------------------------------------------------------ CDP 便捷封装
def ev(expr):
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        c.ws.close()


def evf(expr):
    c = P.Cdp()
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


def click(sel, settle=0.6):
    c = P.Cdp()
    try:
        out = c.click_rect(sel)
    finally:
        c.ws.close()
    time.sleep(settle)
    return out


HIT_JS = r"""
(() => {
  const e = document.querySelector(%s);
  if (!e) return { found: false };
  e.scrollIntoView({ block: 'center' });
  const b = e.getBoundingClientRect();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const sb = document.querySelector('.sidebar');
  const al = document.querySelector('.agentList');
  return {
    found: true, text: (e.textContent || '').slice(0, 40),
    x: Math.round(cx), y: Math.round(cy), w: Math.round(b.width), h: Math.round(b.height),
    inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
    topTag: top ? top.tagName : null, topCls: top ? String(top.className) : null,
    isSelf: Boolean(top) && (top === e || e.contains(top)),
    win: { w: innerWidth, h: innerHeight },
    sidebar: sb ? { sh: sb.scrollHeight, ch: sb.clientHeight, scrollTop: Math.round(sb.scrollTop) } : null,
    agentList: al ? { sh: al.scrollHeight, ch: al.clientHeight, top: Math.round(al.getBoundingClientRect().y) } : null,
  };
})()
"""


def hit_test(sel):
    return ev(HIT_JS % json.dumps(sel))


def click_checked(sel, settle=0.8):
    """真鼠标点击前先做一次命中自检：连按钮都够不着的话，要让证据说清是「点不到」而不是「功能坏了」。"""
    h = hit_test(sel)
    if not h or not h.get('found'):
        return False, {'found': False}
    ok = bool(h.get('isSelf') and h.get('inViewport'))
    if ok:
        click(sel, settle=settle)
    return ok, h


def expect(ok, msg, detail=''):
    """前提不成立就当场停：后面每一步都建立在它之上，硬撑只会产出一串假的 FAIL。"""
    check(msg, ok, detail)
    if not ok:
        raise RuntimeError('%s —— 前提不成立，后续步骤无法继续' % msg)


def iid(v):
    """pg 的 bigint 回来是字符串，跟 Python 的 int 比会假失败（这一版就踩到了）。"""
    return None if v is None else int(v)


def type_into(sel, text):
    c = P.Cdp()
    try:
        return c.type_text(text, sel)
    finally:
        c.ws.close()


def shot(name):
    path = os.path.join(OUTDIR, name)
    c = P.Cdp()
    try:
        c.shot(path)
    finally:
        c.ws.close()
    return path


def set_file(sel, path):
    """把本地文件塞进 <input type=file>（等价于用户在文件选择器里选了它）。"""
    c = P.Cdp()
    try:
        c.send('DOM.enable')
        doc = c.send('DOM.getDocument', depth=-1, pierce=True)
        node = c.send('DOM.querySelector', nodeId=doc['root']['nodeId'], selector=sel)
        if not node.get('nodeId'):
            raise RuntimeError('找不到文件输入框 ' + sel)
        c.send('DOM.setFileInputFiles', files=[path], nodeId=node['nodeId'])
    finally:
        c.ws.close()
    time.sleep(1.0)
    return path


UI_JS = r"""
(() => {
  const rows = [...document.querySelectorAll('.agentList .contact')];
  const projCur = document.querySelector('.projectBox__cur');
  const projRows = [...document.querySelectorAll('.projectBox__row')].map((b) => ({
    id: Number(b.getAttribute('data-project-id')),
    name: (b.querySelector('.contact__name') || {}).textContent || '',
    on: b.className.includes('contact--on'),
  }));
  const on = document.querySelector('.agentList .contact--on');
  const kb = document.querySelector('.knowledgePanel__toggle');
  return {
    names: rows.map((b) => ((b.querySelector('.contact__name') || {}).textContent || '')),
    ids: rows.map((b) => Number(b.getAttribute('data-agent-id'))),
    projCur: projCur ? projCur.textContent : null,
    projRows,
    selected: on ? (on.querySelector('.contact__name') || {}).textContent : null,
    kbButton: kb ? kb.textContent : null,
    kbOpen: Boolean(document.querySelector('.knowledgePanel__file')),
    note: (() => { const n = document.querySelector('.knowledgePanel__note'); return n ? n.textContent : ''; })(),
    agentNote: (() => { const n = document.querySelector('.agentList__note'); return n ? n.textContent : ''; })(),
  };
})()
"""


def ui():
    return ev(UI_JS)


def wait_until(fn, timeout=20.0, interval=0.35):
    """轮询到 fn() 为真；返回 (ok, 最后一次实测, 耗时ms)"""
    t0 = time.time()
    last = None
    while (time.time() - t0) < timeout:
        try:
            last = fn()
            if last:
                return True, last, int((time.time() - t0) * 1000)
        except Exception as e:  # noqa: BLE001
            last = {'__error': str(e)}
        time.sleep(interval)
    return False, last, int((time.time() - t0) * 1000)


def ensure_projects_open():
    if not ev("document.querySelectorAll('.projectBox__row').length"):
        click('.projectBox__toggle', settle=0.7)


def click_project(pid):
    ensure_projects_open()
    return click('.projectBox__row[data-project-id="%d"]' % pid, settle=0.3)


def ensure_knowledge_open():
    if not ev("document.querySelectorAll('.knowledgePanel__file').length"):
        click('.knowledgePanel__toggle', settle=0.8)


def select_agent_by_name(name):
    return ev("""(() => {
      const rows = [...document.querySelectorAll('.agentList .contact')];
      const hit = rows.find(b => ((b.querySelector('.contact__name')||{}).textContent||'') === %s);
      if (!hit) return 'NO_ROW';
      hit.click();
      return 'clicked';
    })()""" % json.dumps(name))


def req_log(since=0):
    return ev("(() => (window.__wbReqLog||[]).filter(r => r.at >= %d))()" % since)


def all_reqs():
    return ev("window.__wbReqLog||[]") or []


RECORDER_JS = r"""
(() => {
  if (window.__wbReqLog) return 'already';
  window.__wbReqLog = [];
  const orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = (typeof input === 'string') ? input : ((input && input.url) || '');
      const m = (init && init.method) || (input && input.method) || 'GET';
      let body = init && init.body;
      if (typeof body === 'string') body = body.slice(0, 400);
      else if (body instanceof FormData) body = '[FormData]';
      else if (body) body = String(body);
      window.__wbReqLog.push({ at: Date.now(), m: String(m).toUpperCase(), url,
                               body: (body === undefined ? null : body) });
    } catch (e) { /* 记录失败绝不影响原请求 */ }
    return orig.apply(this, arguments);
  };
  return 'installed';
})()
"""


def webviews():
    return ev(P.WEBVIEWS_JS)['list']


def guest_target(url_part):
    for t in P._http('/json/list'):
        if url_part in (t.get('url') or ''):
            return t
    return None


GUEST_PROBE = ("return JSON.stringify({ n: window.__t ? window.__t.n : -1,"
               " t0: performance.timeOrigin, href: location.href,"
               " title: document.title });")


def guest_eval(expr):
    t = guest_target(PAGE_URL)
    if not t:
        return {'__error': 'no guest target'}
    c = P.Cdp(t)
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


def driver_state(wc):
    """主进程（司机权威状态）里这一路的状态。"""
    try:
        return evf("const s = await window.workbench.getTaskState(%d); return JSON.stringify(s);" % wc)
    except Exception as e:  # noqa: BLE001
        return json.dumps({'__error': str(e)})


def llm_events():
    try:
        with open(FAKE_LOG, encoding='utf-8') as f:
            return [json.loads(x) for x in f if x.strip()]
    except FileNotFoundError:
        return []


def server_log_text():
    try:
        return open(SERVER_LOG, encoding='utf-8', errors='replace').read()
    except FileNotFoundError:
        return ''


def find_sms_code(since_bytes):
    deadline = time.time() + 25
    while time.time() < deadline:
        for m in re.finditer(r'验证码 (\d{6})', server_log_text()[since_bytes:]):
            return m.group(1)
        time.sleep(0.25)
    raise RuntimeError('没在服务端日志里等到验证码')


# ---------------------------------------------------------------------------
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)

    section('0. 环境自检')
    for port in (8787, 5173):
        if port_busy(port):
            print('[note] %d 上有东西在听（用户自己的实例）—— 不动它，我们只用 8799/5273' % port)
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('验收要用的四个端口（8799/8899/5273/9333）都空着', not busy, 'busy=%s' % busy)
    if busy:
        raise SystemExit('先关掉残留实例再跑')
    check('构建产物齐全（desktop/dist-electron/main.js + server/dist/index.js）',
          os.path.exists(os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js'))
          and os.path.exists(os.path.join(REPO, 'apps', 'server', 'dist', 'index.js')))

    TABLES = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks',
              'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks']
    live_before = {}
    for t in TABLES:
        live_before[t] = [str(r['id']) for r in dbq('SELECT id FROM %s ORDER BY id' % t)]
    evidence['liveBefore'] = {k: len(v) for k, v in live_before.items()}
    print('[live] 跑前活库行数：%s' % json.dumps(evidence['liveBefore'], ensure_ascii=False))

    try:
        # ---------------------------------------------------------- 1. 起环境
        section('1. 起环境：假模型+假页面 / 验收后端 / vite / 真 Electron 窗口')
        spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], HERE,
              env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(FAKE_DELAY_MS),
                   'FAKE_STEPS': str(FAKE_STEPS), 'FAKE_LOG': FAKE_LOG})
        h = None
        for _ in range(40):
            try:
                st, j = http_json('/health', base=FAKE, timeout=3)
                if st == 200:
                    h = j
                    break
            except Exception:  # noqa: BLE001
                time.sleep(0.25)
        check('假模型 / 假页面站已起来', bool(h), json.dumps(h, ensure_ascii=False))

        spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(API_PORT),
                   'DEEPSEEK_BASE_URL': '%s/v1' % FAKE,
                   'DEEPSEEK_API_KEY': 'fake-key-2b-verify',
                   'DEEPSEEK_MODEL': 'fake-2b'},
              log=SERVER_LOG)
        health = wait_health(API)
        evidence['health0'] = health
        check('验收后端起来了，库在线', health.get('db') == 'up', json.dumps(health, ensure_ascii=False))
        check('模型已配置（指向假模型，不烧 token、不依赖外网）', health.get('llm') == 'configured', health.get('llm'))

        # ---------------------------------------------------------- 2. 测试账号
        section('2. 本次新建的测试账号（跑完整体删除）')
        size0 = len(server_log_text())
        st, send = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        check('验证码已下发（mock：只进服务端日志）', st == 200, 'status=%s %s' % (st, send))
        code = find_sms_code(size0)
        st, login = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
        if st != 200 or not isinstance(login, dict) or 'token' not in login:
            raise RuntimeError('测试账号登录失败：%s' % login)
        token = login['token']
        global test_user
        test_user = login['user']['id']
        default_proj = login['project']['id']
        evidence['testUser'] = {'id': test_user, 'xyz': login['user']['xyz_id'],
                                'phone': TEST_PHONE[:3] + '****' + TEST_PHONE[-4:]}
        check('测试账号登录成功（拿到 JWT + 默认项目）', True, 'user=%s project=%s' % (test_user, json.dumps(login['project'], ensure_ascii=False)))
        n_proj = dbq('SELECT count(*)::int AS n FROM projects WHERE user_id = $1', [test_user])[0]['n']
        n_kd = dbq('SELECT count(*)::int AS n FROM knowledge_documents WHERE owner_id = $1', [test_user])[0]['n']
        check('测试账号是干净的（只有 1 个默认项目、0 份资料 —— 没有上轮残留）',
              n_proj == 1 and n_kd == 0, 'projects=%s knowledge=%s' % (n_proj, n_kd))

        spawn('vite', [NODE, os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                       '--port', str(VITE_PORT), '--strictPort'],
              os.path.join(REPO, 'apps', 'desktop'))
        for _ in range(80):
            if port_busy(VITE_PORT):
                break
            time.sleep(0.4)
        check('vite dev server 起来了（%d）' % VITE_PORT, port_busy(VITE_PORT))

        spawn('electron', [NODE, 'scripts/start-electron.mjs',
                           '--user-data-dir=%s' % PROFILE,
                           '--remote-debugging-port=%d' % CDP_PORT],
              os.path.join(REPO, 'apps', 'desktop'),
              env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT})
        ok, _, _ = wait_until(lambda: any(
            t.get('type') == 'page' and ('localhost:%d' % VITE_PORT) in (t.get('url') or '')
            for t in P._http('/json/list')), timeout=90, interval=0.6)
        check('真 Electron 窗口起来了，渲染进程可调试', ok)
        if not ok:
            raise RuntimeError('Electron 没起来')
        pages = [t for t in P._http('/json/list') if t.get('type') == 'page']
        app_pages = [t for t in pages if not (t.get('url') or '').startswith('devtools://')]
        dev_pages = [t for t in pages if (t.get('url') or '').startswith('devtools://')]
        # dev 模式下主进程会故意 `openDevTools({mode:'detach'})`（见 MEMORY），所以「多出来的一个调试目标」
        # 是正常的 —— 真正要证的是「没有第二个应用窗口」。
        check('**应用窗口只有一个**（没有多开 BrowserWindow）', len(app_pages) == 1,
              json.dumps([t.get('url') for t in pages], ensure_ascii=False))
        check('另一个调试目标就是 dev 模式故意开的 DevTools（不是第二个应用窗口）',
              len(dev_pages) == len(pages) - len(app_pages),
              'devtools=%d app=%d' % (len(dev_pages), len(app_pages)))

        c = P.Cdp()
        try:
            c.js("localStorage.setItem('workbench.token', %s); localStorage.setItem('workbench.apiBase', %s); 'ok'"
                 % (json.dumps(token), json.dumps(API)))
            c.send('Page.reload')
        finally:
            c.ws.close()
        time.sleep(9)
        cur_proj_name = [p['name'] for p in http_json('/projects', token=token)[1]['projects']
                         if p['id'] == default_proj][0]
        ok, _, dt = wait_until(lambda: (lambda u: bool(u['names']) and u['projCur'] == '当前项目：' + cur_proj_name)(ui()),
                               timeout=30)
        u = ui()
        check('刷新后自动进工作台，左栏「当前项目」= 默认项目、名单已按项目拉回', ok,
              'projCur=%s names=%s waited=%dms' % (u['projCur'], u['names'], dt))
        check('安装渲染层 fetch 记录器（看清 App 真实发了什么请求）', ev(RECORDER_JS) in ('installed', 'already'))
        shot('01-logged-in.png')

        # ---------------------------------------------------------- 3. 验收 1
        section('3. 验收 1：「＋ 添加」自动推断调用者 + 归属正确')
        t_mark = now_ms()
        d0_agents = http_json('/agents?projectId=%d' % default_proj, token=token)[1]['agents']
        xiaozhu = [a for a in d0_agents if a['kind'] == 'assistant'][0]
        check('默认项目里自带小助，且有建智能体权限（canCreateAgents=true）',
              xiaozhu['canCreateAgents'] is True, json.dumps(xiaozhu, ensure_ascii=False))
        before_ids = [a['id'] for a in d0_agents]
        check('点之前，左栏就是默认项目的名单', ui()['names'] == [a['name'] for a in d0_agents],
              json.dumps(ui()['names'], ensure_ascii=False))
        hit, geom = click_checked('.agentList__add', settle=3.0)
        evidence['addAgentDefaultProject'] = {'hit': geom, 'beforeIds': before_ids}
        check('「＋ 添加」按钮真的点得到（命中自检：鼠标落点就是它本人、且在视口内）', hit,
              json.dumps(geom, ensure_ascii=False))
        after_ui = ui()
        recs = [r for r in req_log(t_mark) if r['url'].endswith('/agents') and r['m'] == 'POST']
        evidence['addAgentDefaultProject'].update({'req': recs, 'domNames': after_ui['names'],
                                                  'agentNote': after_ui['agentNote']})
        expect(len(recs) == 1, 'App 真的发了一次 POST /agents', json.dumps(recs, ensure_ascii=False))
        body = json.loads(recs[0]['body']) if recs and recs[0]['body'] else {}
        check('**body 里带了 asAgentId（不再是空 body）**', 'asAgentId' in body,
              json.dumps(recs[0]['body'] if recs else None, ensure_ascii=False))
        check('**自动推断的调用者 = 当前项目里 canCreateAgents=true 的那个（默认项目 = 小助）**',
              body.get('asAgentId') == xiaozhu['id'],
              'asAgentId=%s 小助=%s' % (body.get('asAgentId'), xiaozhu['id']))
        now_agents = http_json('/agents?projectId=%d' % default_proj, token=token)[1]['agents']
        new_ids = [a['id'] for a in now_agents if a['id'] not in before_ids]
        expect(len(new_ids) == 1, '服务端真的建出来了（名单多了一个）', 'new=%s' % new_ids)
        d1 = [a for a in now_agents if a['id'] in new_ids][0]
        dbrow = dbq('SELECT id, project_id, kind, can_create_agents FROM agents WHERE id = $1', [d1['id']])[0]
        check('**归属正确：落在当前项目（默认项目）**',
              iid(dbrow['project_id']) == default_proj and d1['projectId'] == default_proj,
              'db=%s api=%s 期望=%s' % (dbrow['project_id'], d1['projectId'], default_proj))
        check('新智能体默认没有建智能体的权限（can_create_agents=false）',
              dbrow['can_create_agents'] is False and d1['canCreateAgents'] is False, json.dumps(dbrow, ensure_ascii=False))
        check('左栏立刻能看到它（不用手动刷新）', d1['name'] in after_ui['names'],
              json.dumps(after_ui['names'], ensure_ascii=False))
        check('这一路没有报错提示', not after_ui['agentNote'], 'agentNote=%r' % after_ui['agentNote'])
        evidence['agentD1'] = d1
        shot('02-add-agent-in-default-project.png')

        # ---------------------------------------------------------- 4. 验收 2
        section('4. 验收 2：建 2 个项目 + 来回切换，智能体列表互不串')
        ensure_projects_open()
        type_into('.projectBox__name', '项目A-2B')
        click('.projectBox__create', settle=4.0)
        u = ui()
        pa = [p for p in u['projRows'] if p['name'] == '项目A-2B']
        check('界面上「新建项目」建出了项目 A', len(pa) == 1, json.dumps(u['projRows'], ensure_ascii=False))
        pa_id = pa[0]['id'] if pa else None
        ok, _, dt = wait_until(lambda: any(r['id'] == pa_id and r['on'] for r in ui()['projRows']), timeout=15)
        u = ui()
        check('建完自动切到项目 A 且左栏只有它自带的母鸡', ok and u['names'] == ['项目管家'],
              'names=%s' % json.dumps(u['names'], ensure_ascii=False))
        hen_rows = dbq('SELECT id, kind, can_create_agents, project_id FROM agents WHERE project_id = $1 ORDER BY id', [pa_id])
        check('建项目连带建母鸡（直连库：kind=hen、can_create_agents=true）',
              len(hen_rows) == 1 and hen_rows[0]['kind'] == 'hen' and hen_rows[0]['can_create_agents'] is True,
              json.dumps(hen_rows, ensure_ascii=False))
        hen_a = hen_rows[0]

        t_mark = now_ms()
        hit_a, geom_a = click_checked('.agentList__add', settle=3.5)
        evidence['addAgentProjectA'] = {'hit': geom_a}
        check('项目 A 里「＋ 添加」也点得到（命中自检）', hit_a, json.dumps(geom_a, ensure_ascii=False))
        recs = [r for r in req_log(t_mark) if r['url'].endswith('/agents') and r['m'] == 'POST']
        evidence['addAgentProjectA']['req'] = recs
        expect(len(recs) == 1, '项目 A 里也真的发了一次 POST /agents', json.dumps(recs, ensure_ascii=False))
        abody = json.loads(recs[0]['body']) if recs[0]['body'] else {}
        check('**项目 A 里「＋ 添加」自动推断的调用者是这只母鸡（不是小助）**',
              iid(abody.get('asAgentId')) == iid(hen_a['id']),
              'asAgentId=%s 母鸡=%s 小助=%s' % (abody.get('asAgentId'), hen_a['id'], xiaozhu['id']))
        a_agents = http_json('/agents?projectId=%d' % pa_id, token=token)[1]['agents']
        customs = [a for a in a_agents if a['kind'] == 'custom']
        expect(len(customs) == 1, '项目 A 里确实建出了新智能体', json.dumps(a_agents, ensure_ascii=False))
        a1 = customs[0]
        check('新智能体落在项目 A（直连库核对）',
              iid(dbq('SELECT project_id FROM agents WHERE id = $1', [a1['id']])[0]['project_id']) == iid(pa_id),
              'agent=%s' % a1['id'])
        evidence['projectA'] = {'id': pa_id, 'hen': hen_a, 'agent': a1}
        check('项目 A 的名单 = [母鸡, 新智能体]', ui()['names'] == [a['name'] for a in a_agents],
              json.dumps(ui()['names'], ensure_ascii=False))
        shot('03-project-a.png')

        ensure_projects_open()
        type_into('.projectBox__name', '项目B-2B')
        click('.projectBox__create', settle=4.0)
        u = ui()
        pb = [p for p in u['projRows'] if p['name'] == '项目B-2B']
        check('界面上建出了项目 B', len(pb) == 1, json.dumps(u['projRows'], ensure_ascii=False))
        pb_id = pb[0]['id'] if pb else None
        ok, _, dt = wait_until(lambda: any(r['id'] == pb_id and r['on'] for r in ui()['projRows']), timeout=15)
        check('建完自动切到项目 B', ok, 'projCur=%s' % ui()['projCur'])
        hen_b = dbq('SELECT id, kind, can_create_agents FROM agents WHERE project_id = $1 ORDER BY id', [pb_id])[0]
        hit_b, geom_b = click_checked('.agentList__add', settle=3.5)
        check('项目 B 里「＋ 添加」也点得到（命中自检）', hit_b, json.dumps(geom_b, ensure_ascii=False))
        b_agents = http_json('/agents?projectId=%d' % pb_id, token=token)[1]['agents']
        customs_b = [a for a in b_agents if a['kind'] == 'custom']
        expect(len(customs_b) == 1, '项目 B 里确实建出了新智能体', json.dumps(b_agents, ensure_ascii=False))
        b1 = customs_b[0]
        check('**项目 B 的新智能体也落在项目 B（不是上一个项目）**',
              iid(dbq('SELECT project_id FROM agents WHERE id = $1', [b1['id']])[0]['project_id']) == iid(pb_id),
              'agent=%s project=%s' % (b1['id'], pb_id))
        evidence['projectB'] = {'id': pb_id, 'hen': hen_b, 'agent': b1}
        check('项目 B 也有自己的母鸡 + 一个新智能体', len(b_agents) == 2,
              json.dumps([a['name'] for a in b_agents], ensure_ascii=False))

        d_agents = http_json('/agents?projectId=%d' % default_proj, token=token)[1]['agents']
        exp_default = [a['name'] for a in d_agents]
        exp_a = [a['name'] for a in a_agents]
        exp_b = [a['name'] for a in b_agents]
        # 前提：三个项目的名单必须**两两不同**，否则「串没串」验不出来。
        # 注意默认名是重名的（两个项目各有一只母鸡「项目管家」、各有一个「新智能体」），
        # 所以「互不相同」只能按 **id** 判，不能按名字判 —— 第一版按名字判，这条前提直接假失败。
        # 后面六次切换也一律比对 id（按名字比会在 A/B 之间失真：换了也没人看得出来）。
        exp_id_default = [iid(a['id']) for a in d_agents]
        exp_id_a = [iid(a['id']) for a in a_agents]
        exp_id_b = [iid(a['id']) for a in b_agents]
        check('三个项目的名单互不相同（前提成立，「串没串」才有意义）',
              len({tuple(exp_id_a), tuple(exp_id_b), tuple(exp_id_default)}) == 3,
              '默认id=%s A_id=%s B_id=%s（名字：默认=%s A=%s B=%s）'
              % (exp_id_default, exp_id_a, exp_id_b, exp_default, exp_a, exp_b))
        evidence['expected'] = {'default': exp_default, 'A': exp_a, 'B': exp_b,
                                'defaultIds': exp_id_default, 'AIds': exp_id_a, 'BIds': exp_id_b}

        hops = [(pa_id, exp_id_a, 'A'), (pb_id, exp_id_b, 'B'), (pa_id, exp_id_a, 'A'),
                (pb_id, exp_id_b, 'B'), (default_proj, exp_id_default, '默认'), (pa_id, exp_id_a, 'A')]
        hop_ev = []
        for pid, exp_ids, label in hops:
            t_click = now_ms()
            click_project(pid)
            ok, _, dt = wait_until(lambda: ui()['ids'] == exp_ids, timeout=20)
            u = ui()
            hop_ev.append({'to': pid, 'label': label, 'expectedIds': exp_ids, 'actualIds': u['ids'],
                           'expected': u['names'], 'projCur': u['projCur'], 'ok': ok, 'ms': dt, 'clickAt': t_click})
            check('切到「项目 %s」后左栏 = 该项目的智能体 id 名单（%dms）' % (label, dt), ok,
                  'expectedIds=%s actualIds=%s' % (exp_ids, u['ids']))
        evidence['switchHops'] = hop_ev
        others_all = set(exp_id_a) | set(exp_id_b) | set(exp_id_default)
        leaked = []
        for h in hop_ev:
            for aid in (h['actualIds'] or []):
                if aid in others_all and aid not in h['expectedIds']:
                    leaked.append({'when': h['label'], 'agentId': aid})
        check('**六次切换全程没有一次混进别的项目的智能体**', not leaked, json.dumps(leaked, ensure_ascii=False))
        get_agents_reqs = [r for r in all_reqs()
                           if r['m'] == 'GET' and re.search(r'/agents(\?|$)', r['url'])]
        got_pids = sorted({int(m.group(1)) for r in get_agents_reqs
                           for m in [re.search(r'projectId=(\d+)', r['url'])] if m})
        no_pid = [r['url'] for r in get_agents_reqs if 'projectId=' not in r['url']]
        evidence['agentsReqUrls'] = sorted({r['url'] for r in get_agents_reqs})
        check('**每次换项目都按 projectId 拉名单（三个项目都出现过）**',
              set([pa_id, pb_id, default_proj]).issubset(set(got_pids)),
              'got=%s' % got_pids)
        check('没有出现过「不带 projectId」的 GET /agents（名单请求一律带项目）',
              not no_pid, json.dumps(no_pid, ensure_ascii=False))
        shot('04-project-b-list.png')

        # ---------------------------------------------------------- 5. 验收 3（最关键）
        section('5. 验收 3【最关键】：项目 A 的长任务，跨项目切换全程不被打断')
        click_project(pa_id)
        ok, _, dt = wait_until(lambda: ui()['ids'] == exp_id_a, timeout=20)
        check('先回到项目 A', ok, json.dumps(ui()['names'], ensure_ascii=False))
        check('选中 A1（在项目 A 里）', select_agent_by_name(a1['name']) == 'clicked', a1['name'])
        time.sleep(1.5)
        check('左栏高亮的确实是 A1', ui()['selected'] == a1['name'], 'selected=%s' % ui()['selected'])

        goal = '打开 %s 把整页读完，最后给我一份 %s 结论' % (PAGE_URL, MARK)
        h_before = http_json('/health')[1]
        t_send = now_ms()
        type_into('.inputBar input', goal)
        click('.inputBar button', settle=1.2)
        evidence['task'] = {'goal': goal, 'sentAt': t_send,
                            'llmCallsBefore': h_before.get('llmCalls'), 'liveLoopsBefore': h_before.get('liveLoops')}
        ok, _, _ = wait_until(lambda: any((x.get('url') or '').startswith(PAGE_URL) for x in webviews()),
                              timeout=60, interval=0.6)
        wl = [x for x in webviews() if (x.get('url') or '').startswith(PAGE_URL)]
        check('项目 A 的智能体把测试页开出来了（内嵌页真的存在）', ok and bool(wl),
              json.dumps([{k: x[k] for k in ('wcId', 'partition', 'url')} for x in wl], ensure_ascii=False))
        if not wl:
            raise RuntimeError('测试页没开出来')
        wc = wl[0]['wcId']
        evidence['task']['wcId'] = wc
        evidence['task']['partition'] = wl[0]['partition']
        # 【已随 Phase 3 更新】Phase 3 已把分区规则从"按智能体"改成"按项目"
        # （`persist:workbench-browser-agent-<agentId>` → `persist:workbench-browser-project-<projectId>`，
        #  并已在 Phase 3 验收里证明老规则不再写任何新目录）。
        # 这条断言原先钉的是老规则，Phase 3 之后必然红 —— 属于**被取代的期望值**，不是回归。
        # 语义（同一项目内复用同一套登录态 / 分区不是全局混用）保持不变，只把规则换成现行规则。
        check('这张页的分区按**项目**隔离（persist:workbench-browser-project-<项目A>）'
              '—— Phase 3 起规则由"按智能体"改为"按项目"',
              wl[0]['partition'] == 'persist:workbench-browser-project-%d' % pa_id,
              'partition=%s 期望=persist:workbench-browser-project-%d' % (wl[0]['partition'], pa_id))

        ok, _, _ = wait_until(lambda: (lambda h: h.get('llmCalls', 0) >= 1 and h.get('liveLoops', 0) >= 1)(http_json('/health')[1]),
                              timeout=40, interval=0.6)
        h_now = http_json('/health')[1]
        check('服务端工具循环真的起来了（llmCalls≥1 且 liveLoops≥1）', ok,
              json.dumps({k: h_now.get(k) for k in ('llmCalls', 'liveLoops', 'pageStates')}, ensure_ascii=False))
        # 往被驾驶的那张页里埋「我还活着」的计数器
        guest_eval("window.__t = window.__t || { n: 0 };"
                   "if (!window.__t.timer) { window.__t.timer = setInterval(() => { window.__t.n += 1; }, 200); }"
                   "return JSON.stringify({ n: window.__t.n, t0: performance.timeOrigin, href: location.href });")
        g0 = json.loads(guest_eval(GUEST_PROBE))
        st0 = http_json('/agent/loop/state?wcId=%d' % wc, token=token)[1].get('state') or {}
        drv0 = json.loads(driver_state(wc))
        check('切走前：这张页在跑、循环有步数、主进程司机状态存在',
              bool(st0) and drv0.get('phase') is not None,
              'serverStep=%s driver=%s' % (st0.get('step'), json.dumps(drv0, ensure_ascii=False)))
        evidence['task']['beforeSwitch'] = {'guest': g0, 'serverStep': st0.get('step'),
                                            'serverTouchedAt': st0.get('touchedAt'), 'driver': drv0}
        shot('05-task-running-in-project-a.png')

        # ---- 切到项目 B，待一会儿 ----
        t_sw = now_ms()
        click_project(pb_id)
        ok, _, dt = wait_until(lambda: ui()['ids'] == exp_id_b, timeout=20)
        t_arrived_b = now_ms()
        check('任务在跑的过程中切到了项目 B（左栏立刻换成 B 的名单）', ok, json.dumps(ui()['names'], ensure_ascii=False))
        wl_b = [x for x in webviews() if x['wcId'] == wc]
        check('**切到 B 后 A 那张页仍挂在 DOM 里、尺寸没塌、只是 --off 不露脸**',
              bool(wl_b) and wl_b[0]['w'] > 100 and wl_b[0]['h'] > 100 and '--off' in (wl_b[0]['cls'] or ''),
              json.dumps(wl_b[0] if wl_b else None, ensure_ascii=False))
        shot('06-in-project-b-while-task-runs.png')
        mid = []
        for _ in range(3):
            time.sleep(4)
            h = http_json('/health')[1]
            s = http_json('/agent/loop/state?wcId=%d' % wc, token=token)[1].get('state') or {}
            mid.append({'at': now_ms(), 'llmCalls': h.get('llmCalls'), 'liveLoops': h.get('liveLoops'),
                        'serverStep': s.get('step'), 'serverTouchedAt': s.get('touchedAt'),
                        'driver': json.loads(driver_state(wc)), 'projCur': (ui()['projCur'] or '')})
            print('[B 里观测] %s' % json.dumps(mid[-1], ensure_ascii=False))
        evidence['task']['inProjectB'] = mid
        check('**人在项目 B 期间：服务端这一路的步数还在涨**',
              (mid[-1]['serverStep'] or 0) > (st0.get('step') or 0),
              'serverStep %s -> %s' % (st0.get('step'), mid[-1]['serverStep']))
        # 「桌面那一路没断」的正面证据怎么取：
        # 协议上循环是**主进程拉**的（`main.ts` 的 runToolLoop：/agent/loop/start → 执行 → /agent/loop/next → …），
        # 所以「服务端步数在涨」本身就等价于「主进程一直在拉」，就是上面那条。
        # 这里再补一条桌面自己的状态：主进程司机三次采样必须始终 running、blocked=false（没被拆掉/暂停）。
        # 注意别拿 `driver.step` 当参照 —— 主进程只负责「要工具→执行→喂回执」，步数由服务端记，
        # 这条链路里它**恒为 0**；第一版就是这么假失败的（0 -> 0）。
        d_samples = [(m['driver'].get('phase'), bool(m['driver'].get('blocked'))) for m in mid]
        check('**人在项目 B 期间：主进程司机始终 running、没被暂停/拆掉（桌面这一路没断）**',
              all(p == 'running' and not b for p, b in d_samples),
              'phase/blocked 三次采样=%s' % json.dumps(d_samples, ensure_ascii=False))
        check('**人在项目 B 期间：llmCalls 一直在涨（模型调用没停过）**',
              (mid[-1]['llmCalls'] or 0) > (mid[0]['llmCalls'] or 0),
              'llmCalls %s -> %s' % (mid[0]['llmCalls'], mid[-1]['llmCalls']))

        # ---- 切回项目 A ----
        t_back = now_ms()
        click_project(pa_id)
        ok, _, dt = wait_until(lambda: ui()['ids'] == exp_id_a, timeout=20)
        check('切回项目 A，名单又是 A 的（这几次切换本身没串）', ok, json.dumps(ui()['names'], ensure_ascii=False))
        wl2 = [x for x in webviews() if x['wcId'] == wc]
        check('**切回来后还是同一张页（wcId 一致，没有被重建）**',
              bool(wl2) and wl2[0]['wcId'] == wc,
              'before=%s after=%s' % (wc, wl2[0]['wcId'] if wl2 else None))
        g1 = json.loads(guest_eval(GUEST_PROBE))
        evidence['task']['guestBefore'] = g0
        evidence['task']['guestAfter'] = g1
        check('**这张页从没被重载过（performance.timeOrigin 一模一样）**',
              g0['t0'] == g1['t0'], 'timeOrigin %s -> %s' % (g0['t0'], g1['t0']))
        check('**人不在场的那段时间里，这张页的 JS 一直在跑（计数器涨了）**',
              g1['n'] > g0['n'], 'counter %s -> %s' % (g0['n'], g1['n']))

        ok, _, _ = wait_until(lambda: (http_json('/agent/loop/state?wcId=%d' % wc, token=token)[1].get('state') or {}).get('step', 0) >= FAKE_STEPS,
                              timeout=90, interval=1.0)
        time.sleep(4)
        h_end = http_json('/health')[1]
        st_end = http_json('/agent/loop/state?wcId=%d' % wc, token=token)[1].get('state') or {}
        evs = llm_events()
        mine = [e for e in evs if e['ev'] == 'req' and MARK in (e.get('goal') or '')]
        stops = [e for e in evs if e['ev'] == 'res' and MARK in (e.get('goal') or '') and e.get('kind') == 'stop']
        # 带这句 goal 的模型调用**不止循环那几步**：收尾的 `agent/task/finish` 与
        # `memories/extract:task_end` 也带同一句 goal（服务端日志里 tag 分别是
        # agent/loop#N / agent/task/finish / memories/extract:task_end）。
        # 假模型对这两种非循环请求没有 step 标记，会按默认值记成 step=1/read_page ——
        # 第一版直接数总数，于是把「循环 9 次 + 收尾 2 次 = 11」误判成「多跑了 2 步」。
        # 这里改成：按 step 严格递增取**循环前缀**（1..FAKE_STEPS+1），剩下的才算收尾，并跟服务端日志对账。
        loop_evs = []
        for e in mine:
            if e.get('step') == len(loop_evs) + 1:
                loop_evs.append(e)
            else:
                break
        tail_evs = mine[len(loop_evs):]
        loop_kinds = [e.get('kind') for e in loop_evs]
        slog = server_log_text()
        srv_loop_n = len(re.findall(r'tag=agent/loop#\d+', slog))
        srv_finish_n = len(re.findall(r'tag=agent/task/finish', slog))
        srv_mem_n = len(re.findall(r'tag=memories/extract:task_end', slog))
        evidence['task']['afterDone'] = {'serverStep': st_end.get('step'), 'health': h_end,
                                         'lastPageSummary': st_end.get('last_page_summary'),
                                         'llmReqCount': len(mine), 'loopReqCount': len(loop_evs),
                                         'tailReqCount': len(tail_evs), 'stopEvents': len(stops),
                                         'serverLog': {'loopCalls': srv_loop_n, 'finish': srv_finish_n,
                                                       'memExtract': srv_mem_n},
                                         'loopKinds': loop_kinds,
                                         'tail': [{'iso': e['iso'], 'at': e['at'], 'step': e['step'],
                                                   'kind': e.get('kind')} for e in tail_evs],
                                         'llmTimeline': [{'iso': e['iso'], 'at': e['at'], 'step': e['step'], 'kind': e['kind']} for e in mine]}
        check('**任务走完了全程（服务端步数到 %d、最后一步是 stop 决策）**' % FAKE_STEPS,
              ok and len(stops) >= 1, 'serverStep=%s stops=%s' % (st_end.get('step'), len(stops)))
        check('**循环的模型调用一步不丢、也不重跑：%d 步严格按 1..%d 递增，最后一步是 stop**'
              % (FAKE_STEPS + 1, FAKE_STEPS + 1),
              loop_kinds == ['read_page'] * FAKE_STEPS + ['stop'],
              'loopSteps=%s kinds=%s' % ([e['step'] for e in loop_evs], loop_kinds))
        check('服务端日志里的循环调用次数 = %d（与循环前缀一致，互相印证）' % (FAKE_STEPS + 1),
              srv_loop_n == FAKE_STEPS + 1, 'serverLog agent/loop# = %s' % srv_loop_n)
        check('**stop 之后没有第二条循环起来（多出的 %d 次是收尾调用，全部晚于 stop）**' % len(tail_evs),
              all(e['at'] >= loop_evs[-1]['at'] for e in tail_evs) and 0 <= len(tail_evs) <= 3,
              'tail=%s' % json.dumps([{'at': e['at'], 'step': e['step'], 'kind': e.get('kind')} for e in tail_evs],
                                     ensure_ascii=False))
        check('收尾后循环不再活着（liveLoops 归零，不是挂着 running）',
              (h_end.get('liveLoops') or 0) == 0, 'liveLoops=%s' % h_end.get('liveLoops'))
        in_window = [e for e in mine if t_arrived_b <= e['at'] <= t_back]
        gaps = [mine[i + 1]['at'] - mine[i]['at'] for i in range(len(mine) - 1)]
        worst = max(gaps) if gaps else -1
        evidence['task']['window'] = {'switchAt': t_sw, 'arrivedB': t_arrived_b, 'backAt': t_back,
                                      'eventsInWindow': len(in_window), 'gapsMs': gaps}
        check('**「人在项目 B」那段窗口内模型调用还在继续**', len(in_window) >= 1,
              'window=[%d,%d] events=%d' % (t_arrived_b, t_back, len(in_window)))
        check('**相邻两次模型调用的最大间隔 %dms < 8s（没有出现被挂起的长空档）**' % worst,
              0 <= worst < 8000, 'gaps=%s' % gaps)
        check('时间线横跨整个切换：第一次在切走之前、最后一次在切回之后',
              bool(mine) and mine[0]['at'] < t_sw and mine[-1]['at'] > t_back,
              'first=%s switch=%s back=%s last=%s' % (mine[0]['at'], t_sw, t_back, mine[-1]['at']) if mine else 'no events')

        select_agent_by_name(a1['name'])
        time.sleep(1.5)
        chat = ev("(() => { const c=document.querySelector('.chat'); return c ? c.innerText : ''; })()") or ''
        evidence['task']['chatText'] = chat[-900:]
        check('**A1 的聊天里出现了这条任务的结论（✅ 任务完成）**',
              '任务完成' in chat, chat[-200:].replace('\n', ' | '))
        shot('07-back-in-project-a-task-done.png')

        # ---------------------------------------------------------- 6. 验收 4
        section('6. 验收 4：知识库上传按当前项目归属、两个项目互相看不到')
        f_a = os.path.join(TMP, 'projA-knowledge.txt')
        f_b = os.path.join(TMP, 'projB-knowledge.txt')
        open(f_a, 'w', encoding='utf-8').write('项目 A 的资料：SPAN-2B-KB-A\n' + '卡布换娃 A 专属正文。' * 40)
        open(f_b, 'w', encoding='utf-8').write('项目 B 的资料：SPAN-2B-KB-B\n' + '卡布换娃 B 专属正文。' * 40)

        # 当前在项目 A
        ensure_knowledge_open()
        note0 = ui()['note']
        set_file('.knowledgePanel__file', f_a)
        ok, _, _ = wait_until(lambda: ('已入库' in ui()['note'] and 'projA-knowledge.txt' in ui()['note']
                                       and ui()['note'] != note0), timeout=60, interval=0.6)
        check('项目 A 里上传成功（界面提示带这份文件名）', ok, ui()['note'])
        a_docs = http_json('/knowledge?projectId=%d' % pa_id, token=token)[1]['documents']
        check('项目 A 的资料列表里有它', [d['filename'] for d in a_docs] == ['projA-knowledge.txt'],
              json.dumps([d['filename'] for d in a_docs], ensure_ascii=False))
        doc_a = a_docs[0]
        row = dbq('SELECT project_id, chunk_count FROM knowledge_documents WHERE id = $1', [doc_a['id']])[0]
        check('**直连库：这份资料的 project_id = 项目 A**', iid(row['project_id']) == iid(pa_id),
              json.dumps(row, ensure_ascii=False))
        chunk_rows = dbq('SELECT DISTINCT project_id FROM knowledge_chunks WHERE document_id = $1', [doc_a['id']])
        check('切块也一并归属项目 A（不是 NULL、也不是别的项目）',
              [iid(r['project_id']) for r in chunk_rows] == [iid(pa_id)], json.dumps(chunk_rows, ensure_ascii=False))
        kb_btn_a = ui()['kbButton']
        check('左栏知识库计数跟着当前项目（A：1 份）', kb_btn_a and '知识库（1）' in kb_btn_a, 'button=%s' % kb_btn_a)

        click_project(pb_id)
        ok, _, _ = wait_until(lambda: ui()['ids'] == exp_id_b, timeout=20)
        b_docs0 = http_json('/knowledge?projectId=%d' % pb_id, token=token)[1]['documents']
        check('**切到项目 B：项目 A 刚传的那份资料在这里看不见**',
              not any(d['filename'] == 'projA-knowledge.txt' for d in b_docs0),
              json.dumps([d['filename'] for d in b_docs0], ensure_ascii=False))
        check('项目 B 的界面计数也是 0 份（不是拿 A 的数字）',
              ui()['kbButton'] and '知识库（0）' in ui()['kbButton'], 'button=%s' % ui()['kbButton'])
        ensure_knowledge_open()
        note0 = ui()['note']
        set_file('.knowledgePanel__file', f_b)
        ok, _, _ = wait_until(lambda: ('已入库' in ui()['note'] and 'projB-knowledge.txt' in ui()['note']
                                       and ui()['note'] != note0), timeout=60, interval=0.6)
        check('项目 B 里上传成功', ok, ui()['note'])
        b_docs = http_json('/knowledge?projectId=%d' % pb_id, token=token)[1]['documents']
        check('项目 B 的资料列表只有它自己那份', [d['filename'] for d in b_docs] == ['projB-knowledge.txt'],
              json.dumps([d['filename'] for d in b_docs], ensure_ascii=False))
        row_b = dbq('SELECT project_id FROM knowledge_documents WHERE id = $1', [b_docs[0]['id']])[0]
        check('**直连库：B 那份的 project_id = 项目 B**', iid(row_b['project_id']) == iid(pb_id),
              json.dumps(row_b, ensure_ascii=False))

        click_project(pa_id)
        ok, _, _ = wait_until(lambda: ui()['ids'] == exp_id_a, timeout=20)
        a_docs2 = http_json('/knowledge?projectId=%d' % pa_id, token=token)[1]['documents']
        check('**切回项目 A：只看得见 A 那份（B 那份不出现）**',
              [d['filename'] for d in a_docs2] == ['projA-knowledge.txt'],
              json.dumps([d['filename'] for d in a_docs2], ensure_ascii=False))
        check('A 的界面计数回到 1 份', ui()['kbButton'] and '知识库（1）' in ui()['kbButton'], 'button=%s' % ui()['kbButton'])
        evidence['knowledge'] = {'A': [d['filename'] for d in a_docs2], 'B': [d['filename'] for d in b_docs],
                                 'docA': doc_a, 'docB': b_docs[0], 'kbButtonA': kb_btn_a,
                                 'chunksAllProjectA': chunk_rows}
        shot('08-knowledge-per-project.png')

    finally:
        # ---------------------------------------------------------- 7. 收尾
        section('7. 收尾：测试账号整体删除 + 活库零污染 + 端口释放')
        if test_user:
            r = subprocess.run([NODE, os.path.join(HERE, '2b-cleanup.mjs'), str(test_user)],
                               cwd=REPO, capture_output=True, text=True, encoding='utf-8')
            if r.returncode == 0:
                cl = json.loads(r.stdout)
                evidence['cleanup'] = cl
                check('测试账号已整体删除（users 级联带走项目/智能体/会话/资料）',
                      cl['deleted']['users'] == 1, json.dumps(cl['deleted'], ensure_ascii=False))
                # 对照基准 = **本次跑之前**的活库指纹（不是删除脚本自己拍的「删除前」——
                # 那份里还含着测试账号，拿它比等于「有测试账号 vs 没测试账号」，必然不等）。
                evidence['liveAfter'] = cl['after']['counts']
                check('**活库零污染：11 张表行数完全回到跑前**',
                      cl['after']['counts'] == evidence['liveBefore'],
                      'before(跑前)=%s after(删完)=%s' % (json.dumps(evidence['liveBefore']),
                                                        json.dumps(cl['after']['counts'])))
                back = live_before
                diff_ids = [t for t in back if cl['after']['ids'][t] != ','.join(back[t])]
                evidence['idSetDiff'] = diff_ids
                check('**活库零污染：逐表 id 集合与跑前完全一致（老数据一行没动）**', not diff_ids,
                      'diff=%s' % diff_ids)
            else:
                check('测试账号删除脚本执行成功', False, (r.stderr or r.stdout)[:300])
        # 关窗口 + 杀进程
        try:
            import websocket as _ws
            ver = P._http('/json/version')
            sock = _ws.create_connection(ver['webSocketDebuggerUrl'], timeout=20, suppress_origin=True)
            sock.send(json.dumps({'id': 1, 'method': 'Browser.close', 'params': {}}))
            sock.close()
            time.sleep(2)
        except Exception:  # noqa: BLE001
            pass
        kill_all()
        time.sleep(1.5)
        free = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if not port_busy(p)]
        check('验收用的四个端口全部释放', len(free) == 4, 'free=%s' % free)
        shutil.rmtree(PROFILE, ignore_errors=True)
        check('验收临时 profile 已删（%s）' % PROFILE, not os.path.exists(PROFILE))

        evidence['results'] = results
        evidence['endedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        evidence['failed'] = [r['name'] for r in results if not r['ok']]
        with open(os.path.join(OUTDIR, 'desktop-tests.json'), 'w', encoding='utf-8') as f:
            json.dump(evidence, f, ensure_ascii=False, indent=2)
        print('\n证据：%s' % os.path.join(OUTDIR, 'desktop-tests.json'))
        print('===== 结果 =====\n%s' % ('全部通过（%d 条断言）' % len(results)
                                        if not evidence['failed'] else
                                        '%d 条失败（共 %d 条）' % (len(evidence['failed']), len(results))))
        for nm in evidence['failed']:
            print('  FAIL %s' % nm)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print('\n[FATAL] %s' % exc)
        raise
