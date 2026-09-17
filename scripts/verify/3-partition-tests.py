"""Phase 3 真机验收：**浏览器登录态隔离粒度 从 agentId 改成 projectId**。

它自己起一整套环境（登录态测试站 + 假模型 + 验收后端 + vite + 真 Electron 窗口），
跑完自己收干净；自己的端口一律另起（8797 / 8897 / 5272 / 9332），
**用户自己的 8787 / 5173 一律不动**。

四条验收标准（== 总控给的原文）：
  1. 同项目内：智能体 A 登录某网站后，同项目智能体 B 打开同网站是登录状态；
  2. 跨项目隔离：项目 A 和项目 B 即使访问同一网站，登录状态互不共享
     （最容易改过头的一条，必须重点验）；
  3. 下载文件依然能追溯是哪个智能体触发的，即使物理目录已按项目存放；
  4. 回归：标签页归属、任务并发独立、暂停继续互不影响，Phase 1/2 验过的能力没被破坏。

取证手段（都是客观量，不靠嘴说）：
  · **服务端原始请求日志**（`site.jsonl`）：登录态测试站把**每个请求实际带的 Cookie** 记下来 ——
    「同项目 B 打开就是登录态」「跨项目 B 打开是游客」这两件事，以站点服务端收到的 cookie 为准，
    界面说啥都不算数；
  · **<webview> 的 partition 属性**（渲染层 DOM 直读）：新的粒度是不是真的生效，看它；
  · **guest 页自己的 `document.cookie` / `localStorage`**：客户端侧的同一事实，两侧互相印证；
  · **下载记录 `_downloads.jsonl` + 落盘目录**：物理目录按项目合并了，但记录里还认不认得出 agent；
  · **服务端循环步数 / 主进程司机状态 / 假模型时间戳**：任务并发、暂停继续、跨项目切换不打断；
  · **Partitions 目录快照**（scripts/verify/partitions-snapshot.mjs）：改造前 vs 改造后的目录对照；
  · 截图为辅，不作判据。

用法：
  ~/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/verify/3-partition-tests.py
可覆盖环境变量：API_PORT / FAKE_PORT / VITE_PORT / CDP_PORT / FAKE_DELAY_MS / FAKE_STEPS。
"""
import hashlib
import hmac
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
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'substage-3')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb3')
PROFILE = os.path.join(TMP, 'profile')
BEFORE_SNAPSHOT = os.path.join(OUTDIR, 'partitions-before.json')
AFTER_SNAPSHOT = os.path.join(OUTDIR, 'partitions-after.json')

API_PORT = int(os.environ.get('API_PORT', '8797'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8897'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5272'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9332'))
API = 'http://127.0.0.1:%d' % API_PORT
SITE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SITE_LOG = os.path.join(OUTDIR, 'site.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)

# 回归用的长任务：每步模型延迟 2s × 11 次调用 ⇒ 单条任务 ~22s，
# 够「两条并发 → 暂停一条 → 观察另一条 → 再恢复」，也让时间戳有分辨力。
FAKE_DELAY_MS = int(os.environ.get('FAKE_DELAY_MS', '2000'))
FAKE_STEPS = int(os.environ.get('FAKE_STEPS', '10'))
PAGE_A = '%s/page-a' % SITE
PAGE_B = '%s/page-b' % SITE

TEST_PHONE = '18600002301'

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
    'fakeModel': {'delayMs': FAKE_DELAY_MS, 'steps': FAKE_STEPS},
    'site': SITE,
    'results': [],
}
test_user = None
TOKEN = None


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
  return {
    found: true, text: (e.textContent || '').slice(0, 40),
    x: Math.round(cx), y: Math.round(cy), w: Math.round(b.width), h: Math.round(b.height),
    inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
    topTag: top ? top.tagName : null, topCls: top ? String(top.className) : null,
    isSelf: Boolean(top) && (top === e || e.contains(top)),
  };
})()
"""


def hit_test(sel):
    return ev(HIT_JS % json.dumps(sel))


def click_checked(sel, settle=0.8):
    h = hit_test(sel)
    if not h or not h.get('found'):
        return False, {'found': False}
    ok = bool(h.get('isSelf') and h.get('inViewport'))
    if ok:
        click(sel, settle=settle)
    return ok, h


def expect(ok, msg, detail=''):
    check(msg, ok, detail)
    if not ok:
        raise RuntimeError('%s —— 前提不成立，后续步骤无法继续' % msg)


def iid(v):
    """pg 的 bigint 回来是字符串，跟 Python 的 int 比会假失败。"""
    return None if v is None else int(v)


def type_into(sel, text):
    c = P.Cdp()
    try:
        return c.type_text(text, sel)
    finally:
        c.ws.close()


def shot(name):
    """
    截图是**辅助证据**，不参与任何断言，更不该拖垮整轮验收。

    ⚠️ `Page.captureScreenshot` 在页面多 / 页面忙时**会不回包**（CDP 侧已知抖动，见 README「注意」）。
    第一版这里没兜底：一次截图超时直接把后面 section 7~9（并发/暂停/对照/零污染）全打断，
    日志停在「68 条通过」看起来像功能坏了 —— 其实只是那一张图没拍到。现在失败只记录、不抛，并重试一次。
    """
    path = os.path.join(OUTDIR, name)
    last = ''
    time.sleep(0.8)  # 页面忙时先让一让，能明显降低 captureScreenshot 不回包的概率
    for attempt in (1, 2):
        try:
            c = P.Cdp()
            try:
                c.shot(path)
            finally:
                c.ws.close()
            evidence.setdefault('shots', []).append({'name': name, 'ok': True, 'attempt': attempt})
            return path
        except Exception as e:  # noqa: BLE001
            last = str(e)[:120]
            time.sleep(1.0)
    evidence.setdefault('shots', []).append({'name': name, 'ok': False, 'error': last})
    print('[shot] 跳过 %s（截图失败：%s）—— 辅助证据，不影响断言与结论' % (name, last))
    return None


def wait_input_ready(timeout=45):
    """输入框在 streaming 时是 disabled 的（React 的 disabled={streaming}）——
    不等它可用就打字，字会打在沙箱里，然后「发出去」的消息是空的。"""
    ok, _, dt = wait_until(
        lambda: not ev("(() => { const b = document.querySelector('.inputBar button');"
                       " return b ? b.disabled : true; })()"),
        timeout=timeout, interval=0.4)
    return ok, dt


def say(text, settle=1.4):
    """在聊天输入框里**真敲**一句话并点发送；返回实测值，证据里能看到到底发出去的是什么。"""
    ready, dt = wait_input_ready()
    typed = type_into('.inputBar input', text)
    hit, geom = click_checked_soft('.inputBar button', settle=settle)
    return {'ready': ready, 'readyMs': dt, 'typed': typed, 'typedOk': typed == text, 'sendHit': hit,
            'geom': geom}


def click_checked_soft(sel, settle=0.6):
    """点击前做命中自检，但**不**因为点不到就中止（把事实记进证据，由断言去判）。"""
    h = hit_test(sel)
    if not h or not h.get('found'):
        return False, {'found': False}
    ok = bool(h.get('isSelf') and h.get('inViewport'))
    if ok:
        click(sel, settle=settle)
    return ok, h


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
  return {
    names: rows.map((b) => ((b.querySelector('.contact__name') || {}).textContent || '')),
    ids: rows.map((b) => Number(b.getAttribute('data-agent-id'))),
    projCur: projCur ? projCur.textContent : null,
    projRows,
    selected: on ? (on.querySelector('.contact__name') || {}).textContent : null,
    selectedId: on ? Number(on.getAttribute('data-agent-id')) : null,
    note: (() => { const n = document.querySelector('.agentList__note'); return n ? n.textContent : ''; })(),
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


def select_agent_by_id(aid):
    """点某一行智能体（按 data-agent-id 精确点 —— 两个「新智能体」重名，按名字挑会点错）。"""
    return ev("""(() => {
      const rows = [...document.querySelectorAll('.agentList .contact')];
      const hit = rows.find(b => Number(b.getAttribute('data-agent-id')) === %d);
      if (!hit) return 'NO_ROW';
      hit.click();
      return 'clicked';
    })()""" % aid)


def req_log(since=0):
    return ev("(() => (window.__wbReqLog||[]).filter(r => r.at >= %d))()" % since)


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


# ------------------------------------------------------------------ 内嵌页（guest）
def webviews():
    return ev(P.WEBVIEWS_JS)['list']


def tabs_ui():
    return ev(P.TABS_JS)


def guest_target(url_part, exclude=()):
    """按 URL 片段找内嵌页调试目标（精确匹配优先，避免两个同名路径互相串）。"""
    for t in P._http('/json/list'):
        u = t.get('url') or ''
        if url_part in u and u not in exclude:
            return t
    return None


def guest_eval(url_part, expr, exclude=()):
    t = guest_target(url_part, exclude)
    if not t:
        return {'__error': 'no guest target for ' + url_part}
    c = P.Cdp(t)
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


def guest_click(url_part, sel, exclude=()):
    """在内嵌页里**真鼠标点击**（不是 JS click）。"""
    t = guest_target(url_part, exclude)
    if not t:
        return 'NO_TARGET ' + url_part
    c = P.Cdp(t)
    try:
        return c.click_rect(sel)
    finally:
        c.ws.close()


GUEST_STATE = ("return JSON.stringify({ site: window.__site || null,"
               " cookie: document.cookie || '', local: localStorage.getItem('wbwho') || '',"
               " href: location.href, t0: performance.timeOrigin });")


def guest_state(url_part, exclude=()):
    v = guest_eval(url_part, GUEST_STATE, exclude)
    if isinstance(v, dict) and '__error' in v:
        return v
    try:
        return json.loads(v)
    except Exception:  # noqa: BLE001
        return {'__raw': v}


def s_sid(s):
    """
    从 `guest_state()` 的结果里取页面认定的 sid。

    ⚠️ 别写成 `s.get('sid')` —— 这个结构里没有顶层 `sid`：
       它长这样 `{site: {name, cookie, local, sid, href, at}, cookie, local, href, t0}`，
       sid 在 `site` 底下。第一版就是读错层，7 处断言全变成「永远 None」：
       页面明明已经登录（coookie/服务端日志都能看到），断言却报「没登录」。
    取不到就回空串，语义等于「游客」，方便与「页面还没加载出来」（site 为 None）区分开。
    """
    site = (s or {}).get('site') or {}
    return site.get('sid') or ''


def driver_state(wc):
    """主进程（司机权威状态）里这一路的状态。"""
    try:
        return evf("const s = await window.workbench.getTaskState(%d); return JSON.stringify(s);" % wc)
    except Exception as e:  # noqa: BLE001
        return json.dumps({'__error': str(e)})


def lane_state(wc):
    """服务端这一路的循环状态（步数）—— 「这一路还在不在推进」的直接量。"""
    if not TOKEN:
        return {}
    st, j = http_json('/agent/loop/state?wcId=%d' % wc, token=TOKEN)
    return (j.get('state') or {}) if st == 200 else {}


# ---------------------------------------------------------------- 残留账号回收
def _dotenv(key):
    """从 apps/server/.env 取一个变量（只读进内存，**值绝不打印**）。"""
    try:
        with open(os.path.join(REPO, 'apps', 'server', '.env'), encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                if k.strip() == key:
                    return v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return ''


def phone_hash_of(phone):
    """
    算出这个手机号在库里的 `phone_hash`：`HMAC-SHA256(pepper, phone)` 的 hex
    （实现见 `apps/server/src/crypto.ts` 的 `phoneHash`；pepper 取 `PHONE_PEPPER`，没配就回落 `DATA_KEY`）。

    为什么要它：测试账号的手机号是**固定的**，而脚本中途抛异常时 section 9 的清理会被跳过
    （第三轮真踩到：异常 → 账号残留在活库 → 下一轮「干净账号」前提失败，整轮跑废）。
    有了它就能在**开跑前**按手机号把残留整体回收，让每轮都从干净状态开始。
    """
    pepper = _dotenv('PHONE_PEPPER') or _dotenv('DATA_KEY')
    if not pepper:
        return ''
    return hmac.new(pepper.encode(), phone.encode(), hashlib.sha256).hexdigest()


def purge_leftovers(phone):
    """把同号残留账号（连同项目/智能体/消息）整体删掉。**幂等**：没有残留就是空操作。返回删掉的 userId。"""
    h = phone_hash_of(phone)
    if not h:
        return []
    gone = []
    try:
        rows = dbq('SELECT id FROM users WHERE phone_hash = $1', [h])
    except Exception as e:  # noqa: BLE001
        print('[pre-clean] 查残留失败（跳过）：%s' % str(e)[:120])
        return []
    for r in rows:
        uid = int(r['id'])
        subprocess.run([NODE, os.path.join(HERE, '2b-cleanup.mjs'), str(uid)],
                       cwd=REPO, capture_output=True, text=True, encoding='utf-8')
        gone.append(uid)
    return gone


def llm_events():
    try:
        with open(FAKE_LOG, encoding='utf-8') as f:
            return [json.loads(x) for x in f if x.strip()]
    except FileNotFoundError:
        return []


def site_events():
    try:
        with open(SITE_LOG, encoding='utf-8') as f:
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


def snapshot_partitions(out_path):
    r = subprocess.run([NODE, os.path.join(HERE, 'partitions-snapshot.mjs'),
                        PROFILE.replace('\\', '/'), out_path.replace('\\', '/')],
                       cwd=REPO, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise RuntimeError('分区快照失败：%s' % ((r.stderr or r.stdout or '')[:400]))
    with open(out_path, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------------------
def main():
    global TOKEN, test_user
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    shutil.rmtree(PROFILE, ignore_errors=True)

    section('0. 环境自检 + 改造前对照基线')
    for port in (8787, 5173):
        if port_busy(port):
            print('[note] %d 上有东西在听（用户自己的实例）—— 不动它，我们只用 8797/5272' % port)
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('验收要用的四个端口（8797/8897/5272/9332）都空着', not busy, 'busy=%s' % busy)
    if busy:
        raise SystemExit('先关掉残留实例再跑')
    check('构建产物齐全（desktop/dist-electron/main.js + server/dist/index.js）',
          os.path.exists(os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js'))
          and os.path.exists(os.path.join(REPO, 'apps', 'server', 'dist', 'index.js')))

    main_js = open(os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js'),
                   encoding='utf-8', errors='replace').read()
    check('**主进程产物里已经是新规则（认 project 分区、不再认 agent 分区）**',
          'workbench-browser-project-' in main_js and 'workbench-browser-agent-' not in main_js,
          'project=%s agent=%s' % ('workbench-browser-project-' in main_js,
                                   'workbench-browser-agent-' in main_js))

    check('改造前的分区目录快照已备好（%s）' % os.path.basename(BEFORE_SNAPSHOT),
          os.path.exists(BEFORE_SNAPSHOT))
    before = json.load(open(BEFORE_SNAPSHOT, encoding='utf-8'))
    evidence['partitionsBefore'] = {'profile': before['profile'], 'takenAt': before['takenAt'],
                                    'summary': before['summary'],
                                    'dirs': [{'dir': p['dirName'], 'kind': p['kind'], 'id': p['id'],
                                              'files': p['files']} for p in before['partitions']]}
    check('改造前：目录名里确实是**按智能体**的老规则（否则对照没意义）',
          before['summary']['byKind'].get('agent', 0) >= 1
          or before['summary']['byKind'].get('global-legacy', 0) >= 1,
          json.dumps(before['summary'], ensure_ascii=False))
    print('[before] %s' % json.dumps(evidence['partitionsBefore'], ensure_ascii=False)[:400])

    TABLES = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks',
              'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks']
    live_before = {}
    for t in TABLES:
        live_before[t] = [str(r['id']) for r in dbq('SELECT id FROM %s ORDER BY id' % t)]
    evidence['liveBefore'] = {k: len(v) for k, v in live_before.items()}
    print('[live] 跑前活库行数：%s' % json.dumps(evidence['liveBefore'], ensure_ascii=False))

    try:
        # ---------------------------------------------------------- 1. 起环境
        section('1. 起环境：登录态测试站+假模型 / 验收后端 / vite / 真 Electron 窗口')
        spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], HERE,
              env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(FAKE_DELAY_MS),
                   'FAKE_STEPS': str(FAKE_STEPS), 'FAKE_LOG': FAKE_LOG, 'SITE_LOG': SITE_LOG})
        h = None
        for _ in range(40):
            try:
                st, j = http_json('/health', base=SITE, timeout=3)
                if st == 200:
                    h = j
                    break
            except Exception:  # noqa: BLE001
                time.sleep(0.25)
        check('假模型 + 登录态测试站已起来', bool(h), json.dumps(h, ensure_ascii=False))
        st, body = http_json('/whoami/selftest', base=SITE)
        check('测试站 /whoami 可用（真站点，不是假的判定）', st == 200 and 'relogin' in str(body),
              'status=%s' % st)

        spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(API_PORT),
                   'DEEPSEEK_BASE_URL': '%s/v1' % SITE,
                   'DEEPSEEK_API_KEY': 'fake-key-p3-verify',
                   'DEEPSEEK_MODEL': 'fake-3'},
              log=SERVER_LOG)
        health = wait_health(API)
        evidence['health0'] = health
        check('验收后端起来了，库在线', health.get('db') == 'up', json.dumps(health, ensure_ascii=False))
        check('模型已配置（指向假模型，不烧 token、不依赖外网）', health.get('llm') == 'configured', health.get('llm'))

        # ---------------------------------------------------------- 2. 测试账号
        section('2. 本次新建的测试账号（跑完整体删除）')
        # 先回收上一轮可能残留的同号账号：中途异常会跳过 section 9 的清理，
        # 残留会让下面的「干净账号」前提失败并把整轮跑废（第三轮真踩到）。回收是幂等的。
        gone = purge_leftovers(TEST_PHONE)
        evidence['preClean'] = gone
        if gone:
            print('[pre-clean] 回收上一轮的残留账号：%s' % gone)
        size0 = len(server_log_text())
        st, send = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        check('验证码已下发（mock：只进服务端日志）', st == 200, 'status=%s %s' % (st, send))
        code = find_sms_code(size0)
        st, login = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
        if st != 200 or not isinstance(login, dict) or 'token' not in login:
            raise RuntimeError('测试账号登录失败：%s' % login)
        TOKEN = login['token']
        test_user = login['user']['id']
        default_proj = login['project']['id']
        evidence['testUser'] = {'id': test_user, 'xyz': login['user']['xyz_id'],
                                'phone': TEST_PHONE[:3] + '****' + TEST_PHONE[-4:]}
        check('测试账号登录成功（拿到 JWT + 默认项目）', True,
              'user=%s project=%s' % (test_user, json.dumps(login['project'], ensure_ascii=False)))
        n_proj = dbq('SELECT count(*)::int AS n FROM projects WHERE user_id = $1', [test_user])[0]['n']
        check('测试账号是干净的（只有 1 个默认项目 —— 没有上轮残留）', n_proj == 1, 'projects=%s' % n_proj)
        # 顺手自检「按手机号回收」这套定位是准的：算出来的 hash 必须正好命中这个账号。
        # 这条同时证明 pre-clean 删的是对的人（否则它可能一直对着空气删，残留照旧留着）。
        h_rows = dbq('SELECT id FROM users WHERE phone_hash = $1', [phone_hash_of(TEST_PHONE)])
        check('按手机号能唯一定位到本次测试账号（回收逻辑本身是准的）',
              len(h_rows) == 1 and int(h_rows[0]['id']) == int(test_user),
              '命中=%s 账号=%s' % ([r['id'] for r in h_rows], test_user))

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
        check('**应用窗口只有一个**（没有多开 BrowserWindow）', len(app_pages) == 1,
              json.dumps([t.get('url') for t in pages], ensure_ascii=False))

        c = P.Cdp()
        try:
            c.js("localStorage.setItem('workbench.token', %s); localStorage.setItem('workbench.apiBase', %s); 'ok'"
                 % (json.dumps(TOKEN), json.dumps(API)))
            c.send('Page.reload')
        finally:
            c.ws.close()
        time.sleep(9)
        ok, _, dt = wait_until(lambda: bool(ui()['ids']), timeout=30)
        check('刷新后自动进工作台，左栏名单已拉回', ok, 'ids=%s waited=%dms' % (ui()['ids'], dt))
        check('安装渲染层 fetch 记录器', ev(RECORDER_JS) in ('installed', 'already'))
        shot('00-logged-in.png')

        # ---------------------------------------------------------- 3. 两个项目 + 三个智能体
        section('3. 建 2 个项目（A 里放 2 个智能体、B 里放 1 个）')
        ensure_projects_open()
        type_into('.projectBox__name', 'P3-项目A')
        click('.projectBox__create', settle=4.0)
        u = ui()
        pa = [p for p in u['projRows'] if p['name'] == 'P3-项目A']
        expect(len(pa) == 1, '界面上「新建项目」建出了项目 A', json.dumps(u['projRows'], ensure_ascii=False))
        pa_id = pa[0]['id']
        ok, _, _ = wait_until(lambda: any(r['id'] == pa_id and r['on'] for r in ui()['projRows']), timeout=15)
        check('建完自动切到项目 A', ok, 'projCur=%s' % ui()['projCur'])

        # 项目 A 里连点两次「＋ 添加」→ A1、A2
        for label in ('A1', 'A2'):
            hit, geom = click_checked('.agentList__add', settle=3.5)
            check('项目 A 里「＋ 添加」点得到（%s）' % label, hit, json.dumps(geom, ensure_ascii=False))
        a_agents = http_json('/agents?projectId=%d' % pa_id, token=TOKEN)[1]['agents']
        customs_a = [a for a in a_agents if a['kind'] == 'custom']
        expect(len(customs_a) == 2, '项目 A 里建出了 2 个智能体', json.dumps(a_agents, ensure_ascii=False))
        a1, a2 = customs_a[0], customs_a[1]

        ensure_projects_open()
        type_into('.projectBox__name', 'P3-项目B')
        click('.projectBox__create', settle=4.0)
        u = ui()
        pb = [p for p in u['projRows'] if p['name'] == 'P3-项目B']
        expect(len(pb) == 1, '界面上建出了项目 B', json.dumps(u['projRows'], ensure_ascii=False))
        pb_id = pb[0]['id']
        ok, _, _ = wait_until(lambda: any(r['id'] == pb_id and r['on'] for r in ui()['projRows']), timeout=15)
        check('建完自动切到项目 B', ok, 'projCur=%s' % ui()['projCur'])
        hit, geom = click_checked('.agentList__add', settle=3.5)
        check('项目 B 里「＋ 添加」点得到', hit, json.dumps(geom, ensure_ascii=False))
        b_agents = http_json('/agents?projectId=%d' % pb_id, token=TOKEN)[1]['agents']
        customs_b = [a for a in b_agents if a['kind'] == 'custom']
        expect(len(customs_b) == 1, '项目 B 里建出了 1 个智能体', json.dumps(b_agents, ensure_ascii=False))
        b1 = customs_b[0]

        # 归属以库为准
        rows = dbq('SELECT id, project_id FROM agents WHERE id = ANY($1::bigint[]) ORDER BY id',
                   [[a1['id'], a2['id'], b1['id']]])
        by_id = {iid(r['id']): iid(r['project_id']) for r in rows}
        check('归属正确（直连库）：A1/A2 在项目 A，B1 在项目 B',
              by_id.get(a1['id']) == iid(pa_id) and by_id.get(a2['id']) == iid(pa_id)
              and by_id.get(b1['id']) == iid(pb_id),
              'db=%s A=%s B=%s' % (by_id, pa_id, pb_id))
        evidence['projects'] = {
            'A': {'id': pa_id, 'name': 'P3-项目A', 'agents': [a1, a2]},
            'B': {'id': pb_id, 'name': 'P3-项目B', 'agents': [b1]},
            'default': {'id': default_proj},
        }
        # 分区名由「项目」算，这份期望值脚本自己按新规则拼出来，跟实现无关
        exp_part_a = 'persist:workbench-browser-project-%d' % pa_id
        exp_part_b = 'persist:workbench-browser-project-%d' % pb_id
        evidence['expectedPartitions'] = {'A': exp_part_a, 'B': exp_part_b,
                                          'rule': 'persist:workbench-browser-project-<projectId>'}
        shot('01-two-projects.png')

        # ---------------------------------------------------------- 4. 验收 1
        section('4. 验收 1（同项目内共享登录态）：A 登录后，同项目的 A2 打开同站就是登录态')
        click_project(pa_id)
        ok, _, _ = wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in a_agents], timeout=20)
        check('回到项目 A', ok, json.dumps(ui()['names'], ensure_ascii=False))
        check('选中 A1', select_agent_by_id(a1['id']) == 'clicked', 'A1=%s' % a1['id'])
        time.sleep(1.5)

        url_a1 = '%s/whoami/A1' % SITE
        snd = say('打开 %s' % url_a1, settle=1.5)
        evidence['sendOpenA1'] = snd
        expect(snd['typedOk'], 'A1 里那句「打开…」真的打进输入框并发出去了',
               json.dumps(snd, ensure_ascii=False))
        ok, _, _ = wait_until(lambda: any(url_a1 in (x.get('url') or '') for x in webviews()),
                              timeout=45, interval=0.6)
        wl = [x for x in webviews() if url_a1 in (x.get('url') or '')]
        expect(ok and bool(wl), 'A1 把登录态测试站开出来了', json.dumps([x.get('partition') for x in webviews()], ensure_ascii=False))
        wv_a1 = wl[0]
        evidence['a1Webview'] = {k: wv_a1.get(k) for k in ('partition', 'src', 'wcId', 'url')}
        check('**A1 这张页的分区 = 按项目算（persist:workbench-browser-project-<A>）**',
              wv_a1['partition'] == exp_part_a, 'partition=%s 期望=%s' % (wv_a1['partition'], exp_part_a))

        s0 = guest_state(url_a1)
        check('刚打开时 A1 是游客（没登录过，站点不给 cookie）',
              s_sid(s0) == '' and not s0.get('local'),
              json.dumps(s0, ensure_ascii=False))
        gc = guest_click(url_a1, '#relogin')
        time.sleep(1.2)
        ok, _, dt = wait_until(lambda: s_sid(guest_state(url_a1)) == 'A1', timeout=25)
        s1 = guest_state(url_a1)
        evidence['a1Login'] = {'click': gc, 'after': s1}
        check('**A1 在站点上真的登录成功了（页面自己读到 cookie + localStorage）**', ok,
              'sid=%s local=%s waited=%dms' % (s_sid(s1), s1.get('local'), dt))
        check('A1 的 localStorage 也写进去了（顺带证明站点数据也在这个分区里）',
              s1.get('local') == 'A1', json.dumps(s1, ensure_ascii=False))
        site_sid_a1 = [e for e in site_events() if e['path'] == '/sid' and e['name'] == 'A1']
        check('**站点服务端确实收到了这次登录（原始请求日志：/sid/A1）**',
              len(site_sid_a1) >= 1, json.dumps(site_sid_a1[-1:], ensure_ascii=False))
        site_who_a1 = [e for e in site_events() if e['path'] == '/whoami' and e['name'] == 'A1']
        check('**站点服务端也看见了这次登录的会话（/whoami/A1 第二次请求带的是 wbsid=A1）**',
              bool(site_who_a1) and site_who_a1[-1]['sid'] == 'A1',
              json.dumps(site_who_a1[-1:], ensure_ascii=False))

        # A2：同项目、从没登录过
        check('选中 A2', select_agent_by_id(a2['id']) == 'clicked', 'A2=%s' % a2['id'])
        time.sleep(1.5)
        url_a2 = '%s/whoami/A2' % SITE
        snd2 = say('打开 %s' % url_a2, settle=1.5)
        evidence['sendOpenA2'] = snd2
        expect(snd2['typedOk'], 'A2 里那句「打开…」真的打进输入框并发出去了',
               json.dumps(snd2, ensure_ascii=False))
        ok, _, _ = wait_until(lambda: any(url_a2 in (x.get('url') or '') for x in webviews()),
                              timeout=45, interval=0.6)
        wl2 = [x for x in webviews() if url_a2 in (x.get('url') or '')]
        expect(ok and bool(wl2), 'A2 把同一个站开出来了', json.dumps([x.get('url') for x in webviews()], ensure_ascii=False))
        wv_a2 = wl2[0]
        evidence['a2Webview'] = {k: wv_a2.get(k) for k in ('partition', 'src', 'wcId', 'url')}
        check('**A2 这张页的分区跟 A1 完全一样（同项目 = 同一套登录态）**',
              wv_a2['partition'] == wv_a1['partition'] == exp_part_a,
              'A1=%s A2=%s 期望=%s' % (wv_a1['partition'], wv_a2['partition'], exp_part_a))
        s2 = guest_state(url_a2)
        evidence['a2Guest'] = s2
        check('**★验收标准 1★ A2 从没登录过，打开同站却是登录状态（页面侧 cookie = A1 的会话）**',
              s_sid(s2) == 'A1' and s2.get('local') == 'A1', json.dumps(s2, ensure_ascii=False))
        site_who_a2 = [e for e in site_events() if e['path'] == '/whoami' and e['name'] == 'A2']
        check('**★验收标准 1（服务端视角）★ A2 那次请求带到站点的 Cookie 就是 A1 的 wbsid**',
              bool(site_who_a2) and site_who_a2[0]['sid'] == 'A1',
              json.dumps(site_who_a2[:1], ensure_ascii=False))
        shot('02-same-project-shared-login.png')

        # ---------------------------------------------------------- 5. 验收 2
        section('5. 验收 2（跨项目隔离）：项目 B 打开同一个站，登录态**不共享**')
        click_project(pb_id)
        ok, _, _ = wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in b_agents], timeout=20)
        check('切到项目 B', ok, json.dumps(ui()['names'], ensure_ascii=False))
        check('选中 B1', select_agent_by_id(b1['id']) == 'clicked', 'B1=%s' % b1['id'])
        time.sleep(1.5)
        url_b1 = '%s/whoami/B1' % SITE
        snd3 = say('打开 %s' % url_b1, settle=1.5)
        evidence['sendOpenB1'] = snd3
        expect(snd3['typedOk'], 'B1 里那句「打开…」真的打进输入框并发出去了',
               json.dumps(snd3, ensure_ascii=False))
        ok, _, _ = wait_until(lambda: any(url_b1 in (x.get('url') or '') for x in webviews()),
                              timeout=45, interval=0.6)
        wlb = [x for x in webviews() if url_b1 in (x.get('url') or '')]
        expect(ok and bool(wlb), 'B1 把同一个站开出来了', json.dumps([x.get('url') for x in webviews()], ensure_ascii=False))
        wv_b1 = wlb[0]
        evidence['b1Webview'] = {k: wv_b1.get(k) for k in ('partition', 'src', 'wcId', 'url')}
        check('**B1 这张页的分区 = 按项目 B 算，跟 A 的不一样**',
              wv_b1['partition'] == exp_part_b and wv_b1['partition'] != exp_part_a,
              'B1=%s A=%s B=%s' % (wv_b1['partition'], exp_part_a, exp_part_b))
        s3 = guest_state(url_b1)
        evidence['b1Guest'] = s3
        check('**★验收标准 2★ B1 打开同一个站是游客（A 的登录态没有串过来）**',
              s_sid(s3) == '' and not s3.get('local'), json.dumps(s3, ensure_ascii=False))
        site_who_b1 = [e for e in site_events() if e['path'] == '/whoami' and e['name'] == 'B1']
        check('**★验收标准 2（服务端视角）★ B1 那次请求到站点的 Cookie 是空的**',
              bool(site_who_b1) and site_who_b1[0]['sid'] == '' and site_who_b1[0]['cookie'] == '',
              json.dumps(site_who_b1[:1], ensure_ascii=False))
        shot('03-project-b-isolated.png')

        # 反向：B 里登录之后，A 的登录态不能被冲掉（双向不串）
        guest_click(url_b1, '#relogin')
        ok, _, dtb = wait_until(lambda: s_sid(guest_state(url_b1)) == 'B1', timeout=25)
        s3b = guest_state(url_b1)
        check('B1 在项目 B 里也登录成功（sid=B1）', ok,
              'waited=%dms %s' % (dtb, json.dumps(s3b, ensure_ascii=False)))
        click_project(pa_id)
        ok, _, _ = wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in a_agents], timeout=20)
        check('切回项目 A', ok, json.dumps(ui()['names'], ensure_ascii=False))
        check('选中 A2', select_agent_by_id(a2['id']) == 'clicked', 'A2=%s' % a2['id'])
        time.sleep(1.2)
        # 用 URL 栏真敲一次导航：产出一条**服务端看得到的**请求（证明 A 的会话没被 B 冲掉），
        # 顺便把「改地址回车即导航」这条路也走一遍。
        url_a2b = '%s/whoami/A2-afterB' % SITE
        type_into('.browserPanel__url', url_a2b)
        c = P.Cdp()
        try:
            c.send('Input.dispatchKeyEvent', type='rawKeyDown', windowsVirtualKeyCode=13, key='Enter', code='Enter')
            c.send('Input.dispatchKeyEvent', type='keyUp', windowsVirtualKeyCode=13, key='Enter', code='Enter')
        finally:
            c.ws.close()
        ok, _, dt = wait_until(lambda: (guest_target(url_a2b) is not None)
                               and (guest_state(url_a2b).get('site') or {}).get('name') == 'A2-afterB',
                               timeout=30, interval=0.6)
        s4 = guest_state(url_a2b)
        evidence['a2AfterBLogin'] = {'navigated': ok, 'ms': dt, 'state': s4}
        check('URL 栏输入新地址回车后真的导航了（地址 = %s）' % url_a2b, ok, json.dumps(s4, ensure_ascii=False))
        check('**★验收标准 2（反向）★ 在 B 里登录过之后，A2 的会话仍是 A 的（sid=A1，没被 B1 冲掉）**',
              s_sid(s4) == 'A1', json.dumps(s4, ensure_ascii=False))
        who_a2b = [e for e in site_events() if e['name'] == 'A2-afterB']
        check('**★验收标准 2（反向，服务端视角）★ 这次请求带到站点的是 wbsid=A1**',
              bool(who_a2b) and who_a2b[-1]['sid'] == 'A1',
              json.dumps(who_a2b[-1:], ensure_ascii=False))
        # 全程逐请求核对：**每一页带的 sid 都必须落在它该有的集合里**。
        # 这条是「从隔离改共享」最容易改过头的地方 —— A/B 之间绝不能出现对方的 sid。
        # （`selftest` 是脚本启动时用 http 直接探站的那一下，不在任何分区里，不参与核对。）
        allow_sid = {'A1': {'', 'A1'}, 'A2': {'A1'}, 'A2-afterB': {'A1'}, 'B1': {'', 'B1'}}
        who_all = [e for e in site_events() if e['path'] == '/whoami' and e['name'] != 'selftest']
        crossed = [e for e in who_all if e['sid'] not in allow_sid.get(e['name'], set())]
        evidence['siteWhoami'] = [{'name': e['name'], 'sid': e['sid']} for e in who_all]
        check('**站点侧全程逐请求核对：每一页带的 sid 都是它自己项目的那一个（A/B 两条线一次都没交叉）**',
              bool(who_all) and not crossed,
              'crossed=%s / 实际=%s' % (json.dumps(crossed, ensure_ascii=False),
                                       json.dumps(evidence['siteWhoami'], ensure_ascii=False)))
        # 这两条必须**现读** site_events()：`site_who_b1` 是「B1 刚打开时」那一刻的快照，
        # 只含「登录前游客」那一条 —— 拿它当证据等于用半句真话糊弄（第一版就是这么写的）。
        site_a1_now = [e for e in site_events() if e['path'] == '/whoami' and e['name'] == 'A1']
        site_b1_now = [e for e in site_events() if e['path'] == '/whoami' and e['name'] == 'B1']
        check('站点侧记录齐全：A1 与 B1 各有「登录前游客 + 登录后带 cookie」两条',
              [e['sid'] for e in site_a1_now] == ['', 'A1']
              and [e['sid'] for e in site_b1_now] == ['', 'B1'],
              'A1=%s / B1=%s' % (json.dumps([e['sid'] for e in site_a1_now]),
                                 json.dumps([e['sid'] for e in site_b1_now])))
        # 用 URL 栏把它导航回原来那张「我是谁」页（下面要点它页面里的下载链接）
        type_into('.browserPanel__url', url_a2)
        c = P.Cdp()
        try:
            c.send('Input.dispatchKeyEvent', type='rawKeyDown', windowsVirtualKeyCode=13, key='Enter', code='Enter')
            c.send('Input.dispatchKeyEvent', type='keyUp', windowsVirtualKeyCode=13, key='Enter', code='Enter')
        finally:
            c.ws.close()
        ok_back, _, _ = wait_until(lambda: (guest_target(url_a2) is not None)
                                   and (guest_state(url_a2).get('site') or {}).get('name') == 'A2',
                                   timeout=30, interval=0.6)
        check('再导航回 A2 那张「我是谁」页（准备点它的下载链接）', ok_back, url_a2)

        # ---------------------------------------------------------- 6. 验收 3
        section('6. 验收 3（下载归属）：物理目录按项目合并，但记录仍认得出是哪个智能体')
        # 回到 A1 那张页点下载链接（真鼠标），再回到 A2 那张页点一次
        click_project(pa_id)
        wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in a_agents], timeout=20)
        select_agent_by_id(a1['id'])
        time.sleep(1.2)
        gc1 = guest_click(url_a1, '#dl')
        ok, _, dt1 = wait_until(lambda: os.path.exists(os.path.join(PROFILE, 'browser-projects',
                                                                    str(pa_id), 'downloads', 'wb3-A1.txt')),
                                timeout=25)
        check('**A1 点下载 → 文件真的落盘了（项目 A 的目录下）**', ok,
              'click=%s waited=%dms' % (gc1, dt1))
        select_agent_by_id(a2['id'])
        time.sleep(1.2)
        gc2 = guest_click(url_a2, '#dl')
        ok2, _, dt2 = wait_until(lambda: os.path.exists(os.path.join(PROFILE, 'browser-projects',
                                                                     str(pa_id), 'downloads', 'wb3-A2.txt')),
                                 timeout=25)
        check('**A2 点下载 → 也落盘了**', ok2, 'click=%s waited=%dms' % (gc2, dt2))

        dl_dir = os.path.join(PROFILE, 'browser-projects', str(pa_id), 'downloads')
        check('**两个智能体的文件在同一个物理目录（按项目存放，这是本次改造的目的）**',
              os.path.isdir(dl_dir) and os.path.exists(os.path.join(dl_dir, 'wb3-A1.txt'))
              and os.path.exists(os.path.join(dl_dir, 'wb3-A2.txt')),
              json.dumps(sorted(os.listdir(dl_dir)) if os.path.isdir(dl_dir) else None, ensure_ascii=False))
        recs_path = os.path.join(PROFILE, 'browser-projects', '_downloads.jsonl')
        recs = []
        if os.path.exists(recs_path):
            with open(recs_path, encoding='utf-8') as f:
                recs = [json.loads(x) for x in f if x.strip()]
        evidence['downloadRecords'] = recs
        evidence['downloadDir'] = {'path': dl_dir, 'files': sorted(os.listdir(dl_dir)) if os.path.isdir(dl_dir) else []}
        check('下载记录里有两条（一次智能体一次）', len(recs) == 2, json.dumps(recs, ensure_ascii=False))
        r1 = [r for r in recs if r['filename'] == 'wb3-A1.txt']
        r2 = [r for r in recs if r['filename'] == 'wb3-A2.txt']
        check('**★验收标准 3★ 记录里认得出「wb3-A1.txt 是 A1 下载的」**',
              bool(r1) and iid(r1[0]['agentId']) == iid(a1['id']),
              json.dumps(r1[:1], ensure_ascii=False))
        check('**★验收标准 3★ 记录里认得出「wb3-A2.txt 是 A2 下载的」（同一个目录、不同智能体分得清）**',
              bool(r2) and iid(r2[0]['agentId']) == iid(a2['id']),
              json.dumps(r2[:1], ensure_ascii=False))
        check('记录里也带了项目号与归属来源（可复核，不是靠文件名猜）',
              all(iid(r['projectId']) == iid(pa_id) and r.get('agentSource') in ('renderer', 'lane')
                  for r in recs),
              json.dumps([{k: r.get(k) for k in ('projectId', 'agentId', 'agentSource')} for r in recs],
                         ensure_ascii=False))
        check('旧命名（按智能体）的下载目录没有被新建出来',
              not os.path.exists(os.path.join(PROFILE, 'browser-agents')),
              'browser-agents exists=%s' % os.path.exists(os.path.join(PROFILE, 'browser-agents')))
        # 把两个下载文件拷进验收目录当物证（profile 跑完会删掉）
        for fn in ('wb3-A1.txt', 'wb3-A2.txt'):
            src = os.path.join(dl_dir, fn)
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(OUTDIR, 'download-%s' % fn))
        shot('04-downloads.png')

        # ---------------------------------------------------------- 7. 验收 4
        section('7. 验收 4（回归）：标签页归属 / 任务并发 / 暂停继续 / 切项目不打断')
        # 7.1 标签页归属仍按智能体
        click_project(pa_id)
        wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in a_agents], timeout=20)
        select_agent_by_id(a1['id'])
        time.sleep(1.5)
        t_a1 = tabs_ui()
        select_agent_by_id(a2['id'])
        time.sleep(1.5)
        t_a2 = tabs_ui()
        evidence['tabsA1'] = t_a1
        evidence['tabsA2'] = t_a2
        check('**A1 顶栏只显示 A1 自己的页（看不到 A2 那张）**',
              t_a1['tabCount'] == 1 and url_a1 in (t_a1['tabs'][0]['title'] if t_a1['tabs'] else ''),
              json.dumps(t_a1, ensure_ascii=False))
        check('**A2 顶栏只显示 A2 自己的页（看不到 A1 那张）**',
              t_a2['tabCount'] == 1 and url_a2 in (t_a2['tabs'][0]['title'] if t_a2['tabs'] else ''),
              json.dumps(t_a2, ensure_ascii=False))
        check('切智能体换的只是「哪一桶可见」：两张页都还挂在 DOM 里、尺寸没塌',
              all(x['w'] > 100 and x['h'] > 100 for x in webviews()),
              json.dumps([{k: x[k] for k in ('wcId', 'partition', 'w', 'h')} for x in webviews()],
                         ensure_ascii=False))

        # 7.2 两条任务并发 + 暂停继续互不影响
        section('7.2 两条任务并发（同项目两个智能体），暂停一条不影响另一条')
        goal_a = '打开 %s 把整页读完，最后给我一份 P3-LANE-A 结论' % PAGE_A
        goal_b = '打开 %s 把整页读完，最后给我一份 P3-LANE-B 结论' % PAGE_B
        vw_a1 = [x for x in webviews() if x['wcId'] == wv_a1['wcId']][0]
        vw_a2 = [x for x in webviews() if x['wcId'] == wv_a2['wcId']][0]
        check('两张要驾驶的内嵌页都还挂着、有真实尺寸（尺寸塌了驾驶点不中任何元素）',
              vw_a1['w'] > 100 and vw_a1['h'] > 100 and vw_a2['w'] > 100 and vw_a2['h'] > 100,
              json.dumps([{k: x[k] for k in ('wcId', 'w', 'h', 'partition')} for x in (vw_a1, vw_a2)],
                         ensure_ascii=False))

        # A1 起第一路
        select_agent_by_id(a1['id'])
        time.sleep(1.2)
        t_send_a = now_ms()
        snd_a = say(goal_a, settle=1.4)
        evidence['sendGoalA'] = snd_a
        check('A1 那条任务指令真的发出去了', snd_a['typedOk'], json.dumps(snd_a, ensure_ascii=False))
        ok_a, _, _ = wait_until(lambda: (json.loads(driver_state(wv_a1['wcId'])).get('phase') == 'running'),
                                timeout=60, interval=0.8)
        check('A1 那一路真的跑起来了（主进程司机 running）', ok_a,
              driver_state(wv_a1['wcId']))
        # A2 起第二路
        select_agent_by_id(a2['id'])
        time.sleep(1.2)
        t_send_b = now_ms()
        snd_b = say(goal_b, settle=1.4)
        evidence['sendGoalB'] = snd_b
        check('A2 那条任务指令真的发出去了（同一项目、另一个智能体）', snd_b['typedOk'],
              json.dumps(snd_b, ensure_ascii=False))
        ok_b, _, _ = wait_until(lambda: (json.loads(driver_state(wv_a2['wcId'])).get('phase') == 'running'),
                                timeout=60, interval=0.8)
        check('A2 那一路也跑起来了（两路并发，不是排队）', ok_b, driver_state(wv_a2['wcId']))

        llm_reqs = [e for e in llm_events() if e['ev'] == 'req']
        overlapped = False
        open_at = {}
        for e in llm_reqs:
            g = e.get('goal') or ''
            k = 'A' if 'P3-LANE-A' in g else ('B' if 'P3-LANE-B' in g else None)
            if not k:
                continue
            open_at.setdefault(k, []).append(e['at'])
        if open_at.get('A') and open_at.get('B'):
            overlapped = min(max(open_at['A']), max(open_at['B'])) >= max(min(open_at['A']), min(open_at['B']))
        evidence['lanes'] = {'wcA': wv_a1['wcId'], 'wcB': wv_a2['wcId'],
                             'llmCountA': len(open_at.get('A') or []), 'llmCountB': len(open_at.get('B') or []),
                             'sentAtA': t_send_a, 'sentAtB': t_send_b}
        check('**两路任务的时间线真的重叠（并发，不是一前一后）**', overlapped,
              json.dumps({k: v[:4] for k, v in open_at.items()}, ensure_ascii=False))

        # 暂停 A1 那一路
        st_before_pause = {'A': lane_state(wv_a1['wcId']).get('step'), 'B': lane_state(wv_a2['wcId']).get('step')}
        t_pause = now_ms()
        pret = evf("const r = await window.workbench.pauseTask(%d); return JSON.stringify(r);" % wv_a1['wcId'])
        evidence['pause'] = {'at': t_pause, 'ret': pret, 'stepBefore': st_before_pause}
        check('暂停 A1 那一路的调用返回了', isinstance(pret, str) and '__error' not in str(pret), str(pret)[:200])
        samples = []
        for _ in range(4):
            time.sleep(4)
            samples.append({'at': now_ms(),
                            'stepA': lane_state(wv_a1['wcId']).get('step'),
                            'stepB': lane_state(wv_a2['wcId']).get('step'),
                            'drvA': json.loads(driver_state(wv_a1['wcId'])).get('phase'),
                            'drvB': json.loads(driver_state(wv_a2['wcId'])).get('phase')})
            print('[暂停中观测] %s' % json.dumps(samples[-1], ensure_ascii=False))
        evidence['pause']['samples'] = samples
        # 口径：暂停**不能撤掉已经发出去的那次模型调用**（HTTP 已经在路上），
        # 所以允许「暂停瞬间在途的这一步」落地（最多 1 步）；
        # 真正要证的是 **暂停之后它就不再往前走了** —— 12s 观测窗内三次采样必须停在同一个值。
        step_stable = (samples[0]['stepA'] or 0) == (samples[-1]['stepA'] or 0)
        step_bounded = (samples[-1]['stepA'] or 0) <= (st_before_pause['A'] or 0) + 1
        check('**★验收标准 4★ 被暂停的那一路停住了（A1 的步数不再涨）**',
              step_stable and step_bounded and samples[-1]['drvA'] == 'paused',
              'stepA %s -> %s -> %s（观测 %d 次；stable=%s bounded=%s drvA=%s）'
              % (st_before_pause['A'], samples[0]['stepA'], samples[-1]['stepA'], len(samples),
                 step_stable, step_bounded, samples[-1]['drvA']))
        check('**★验收标准 4★ A1 停住的同时 A2 照跑（两路的暂停/继续互不影响）**',
              (samples[-1]['stepB'] or 0) > (st_before_pause['B'] or 0),
              'stepB %s -> %s' % (st_before_pause['B'], samples[-1]['stepB']))
        check('主进程侧两路状态也是分开的（A 暂停、B 运行）',
              samples[-1]['drvB'] == 'running',
              'drvA=%s drvB=%s' % (samples[-1]['drvA'], samples[-1]['drvB']))

        rret = evf("const r = await window.workbench.resumeTask(%d); return JSON.stringify(r);" % wv_a1['wcId'])
        time.sleep(1.0)
        ok_res, _, _ = wait_until(lambda: (lane_state(wv_a1['wcId']).get('step') or 0) > (samples[-1]['stepA'] or 0),
                                  timeout=30, interval=1.0)
        evidence['pause']['resumeRet'] = rret
        evidence['pause']['stepAfterResume'] = lane_state(wv_a1['wcId']).get('step')
        check('**★验收标准 4★ 恢复 A1 之后它继续推进（继续也是按智能体分开的）**', ok_res,
              'stepA %s -> %s' % (samples[-1]['stepA'], lane_state(wv_a1['wcId']).get('step')))

        # 7.3 切换项目/智能体不打断（Phase 2 能力回归）
        st_before_switch = lane_state(wv_a1['wcId']).get('step')
        g_before = json.loads(guest_eval(PAGE_A, GUEST_STATE)) if guest_target(PAGE_A) else {}
        t_sw = now_ms()
        click_project(pb_id)
        wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in b_agents], timeout=20)
        select_agent_by_id(b1['id'])
        time.sleep(6)
        s_mid = lane_state(wv_a1['wcId']).get('step')
        click_project(pa_id)
        wait_until(lambda: ui()['ids'] == [iid(a['id']) for a in a_agents], timeout=20)
        s_after = lane_state(wv_a1['wcId']).get('step')
        g_after = json.loads(guest_eval(PAGE_A, GUEST_STATE)) if guest_target(PAGE_A) else {}
        evidence['switchRegression'] = {'at': t_sw, 'stepBefore': st_before_switch, 'stepInB': s_mid,
                                        'stepAfter': s_after, 'guestBefore': g_before, 'guestAfter': g_after}
        check('**★验收标准 4★ 切到项目 B（还换了智能体）期间，项目 A 那一路的步数仍在涨**',
              (s_mid or 0) > (st_before_switch or 0) and (s_after or 0) >= (s_mid or 0),
              'step %s -> 在B %s -> 回A %s' % (st_before_switch, s_mid, s_after))
        check('**★验收标准 4★ 切回来还是同一张页（没被重载：timeOrigin 不变）**',
              g_before.get('t0') == g_after.get('t0') and g_before.get('t0') is not None,
              't0 before=%s after=%s' % (g_before.get('t0'), g_after.get('t0')))
        shot('05-regression.png')

        # ---------------------------------------------------------- 8. 分区目录对照
        section('8. 分区目录对照（改造前 vs 改造后）')
        snap = snapshot_partitions(AFTER_SNAPSHOT)
        evidence['partitionsAfter'] = {'profile': snap['profile'], 'takenAt': snap['takenAt'],
                                       'summary': snap['summary'],
                                       'dirs': [{'dir': p['dirName'], 'kind': p['kind'], 'id': p['id'],
                                                 'files': p['files']} for p in snap['partitions']],
                                       'projectsDownloads': snap['browserProjectsDir'],
                                       'records': snap['downloadRecords']}
        kinds = snap['summary']['byKind']
        check('**改造后：Partitions 下出现的都是「按项目」的分区（project）**',
              kinds.get('project', 0) >= 2 and kinds.get('agent', 0) == 0,
              json.dumps(snap['summary'], ensure_ascii=False))
        check('改造后：项目 A、项目 B 的分区都在（两个项目各一套登录态）',
              set(snap['summary']['projectPartitionIds']) >= {iid(pa_id), iid(pb_id)},
              json.dumps(snap['summary']['projectPartitionIds']))
        check('改造后：没有产生任何「按智能体」的新分区目录（老规则不再写）',
              kinds.get('agent', 0) == 0, json.dumps(snap['summary']['byKind']))
        check('对照：改造前目录里是 agent 命名、改造后是 project 命名',
              before['summary']['projectPartitionIds'] == []
              and len(snap['summary']['projectPartitionIds']) >= 2,
              'before=%s after=%s' % (json.dumps(before['summary'], ensure_ascii=False),
                                      json.dumps(snap['summary'], ensure_ascii=False)))
        check('下载目录按项目落（browser-projects/<项目>/downloads）',
              bool(snap['browserProjectsDir'])
              and any(d['name'] == str(pa_id) for d in snap['browserProjectsDir']),
              json.dumps([d.get('name') for d in snap['browserProjectsDir']], ensure_ascii=False))
        print('[after] %s' % json.dumps(evidence['partitionsAfter']['summary'], ensure_ascii=False))
        print('[对照] before=%s' % json.dumps(evidence['partitionsBefore']['summary'], ensure_ascii=False))

        # ---------------------------------------------------------- 9. 收尾
        section('9. 收尾：删测试账号 + 活库零污染 + 端口释放')
        # 分区目录证据已经落盘，profile 可以删了。
        # ⚠️ 顺序要紧：**先杀进程再删目录** —— Electron 还在跑的时候 profiles 下的
        #    Cookies / Local Storage 等文件是被占用的，`rmtree(ignore_errors=True)`
        #    会静默留下一半，断言就会报「没删掉」（第一版就是这么假失败的）。
        kill_all()
        time.sleep(1.5)
        for _ in range(6):
            shutil.rmtree(PROFILE, ignore_errors=True)
            if not os.path.exists(PROFILE):
                break
            time.sleep(1.0)
        leftovers = []
        if os.path.exists(PROFILE):
            for root, dirs, files in os.walk(PROFILE):
                leftovers += [os.path.join(root, x) for x in files][:5]
                if leftovers:
                    break
        check('验收临时 profile 已删（不会污染你的真实 userData）', not os.path.exists(PROFILE),
              '残留=%s' % json.dumps(leftovers[:5], ensure_ascii=False))
        check('验收用的是临时 profile，没碰你的真实 userData',
              os.path.normcase(os.path.realpath(PROFILE)).startswith(
                  os.path.normcase(os.path.realpath(os.environ.get('TEMP', '/tmp'))))
              and 'roaming' not in os.path.normcase(os.path.realpath(PROFILE)),
              'profile=%s' % PROFILE)

        cleanup = subprocess.run([NODE, os.path.join(HERE, '2b-cleanup.mjs'), str(test_user)],
                                 cwd=REPO, capture_output=True, text=True, encoding='utf-8')
        check('测试账号已整体删除（级联）', cleanup.returncode == 0,
              ((cleanup.stdout or '') + (cleanup.stderr or ''))[:400])
        if cleanup.returncode == 0:
            cinfo = json.loads(cleanup.stdout)
            evidence['cleanup'] = cinfo
            deleted = cinfo.get('deleted', {})
            check('库里已经查不到这个账号了',
                  (deleted.get('users') or 0) >= 1, json.dumps(deleted, ensure_ascii=False))

        live_after = {}
        for t in TABLES:
            live_after[t] = [str(r['id']) for r in dbq('SELECT id FROM %s ORDER BY id' % t)]
        diff = {t: {'before': len(live_before[t]), 'after': len(live_after[t])}
                for t in TABLES if live_before[t] != live_after[t]}
        evidence['liveAfter'] = {k: len(v) for k, v in live_after.items()}
        check('**活库零污染：11 张表的 id 集合跟跑之前一模一样**', not diff,
              json.dumps(diff, ensure_ascii=False))

    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        check('验收过程没有异常', False, str(exc)[:400])
    finally:
        kill_all()
        # ⚠️ 异常路径也必须回收测试账号：正常路径已在 section 9 删过（这次是空操作），
        # 但**中途抛异常时 section 9 会被整个跳过** —— 第三轮就是这样把 user 22 留在活库里，
        # 害得下一轮被「干净账号」前提拦住。清理不能只挂在"跑到底"的那条路径上。
        try:
            leaked = purge_leftovers(TEST_PHONE)
            if leaked:
                print('[cleanup] 收尾回收了中途残留的测试账号：%s' % leaked)
        except Exception as e:  # noqa: BLE001
            print('[cleanup] 收尾回收失败（可能需要手工清）：%s' % str(e)[:160])
        time.sleep(1.0)
        busy_left = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
        check('验收自己的四个端口全部释放', not busy_left, 'busy=%s' % busy_left)
        for port in (8787, 5173):
            if port_busy(port):
                print('[note] %d 仍在监听（用户自己的实例，全程没动）' % port)

        passed = sum(1 for r in results if r['ok'])
        failed = [r for r in results if not r['ok']]
        shots = evidence.get('shots') or []
        print('\n[截图] 成功 %d / 共 %d %s'
              % (sum(1 for s in shots if s.get('ok')), len(shots),
                 ('（没拍到的是 CDP 抖动，不影响断言）' if any(not s.get('ok') for s in shots) else '')))
        evidence['results'] = results
        evidence['endedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        evidence['summary'] = {'total': len(results), 'passed': passed, 'failed': len(failed),
                               'failedNames': [r['name'] for r in failed]}
        with open(os.path.join(OUTDIR, 'desktop-tests.json'), 'w', encoding='utf-8') as f:
            json.dump(evidence, f, ensure_ascii=False, indent=2)
        print('\n================ 汇总：%d 条断言，%d 通过，%d 失败 ================'
              % (len(results), passed, len(failed)))
        for r in failed:
            print('  FAIL  %s :: %s' % (r['name'], r['detail'][:200]))
        sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
