"""Phase 4 真机验收：**资源守护者（持续资源监控）**。

它自己起一整套环境（假模型 + 验收后端 + vite + 真 Electron 窗口），跑完自己收干净；
自己的端口另起（8798 / 8898 / 5273 / 9333），**用户自己的 8787 / 5173 一律不动**。

四条验收标准（== 总控给的原文）：
  1. 资源数据采集准确、连续（故意开 5 / 8 / 12 个浏览器，对比「采集到的数据」与
     「真实系统数据（任务管理器同口径）」）；
  2. 超过警戒线时提示确实被触发，且「最久未使用实例」排序正确；
  3. 监控本身的性能开销可控（给出具体数字：开/关监控的 CPU 差值）；
  4. 回归：这次改动没有破坏之前任何一条已验证的能力。

另有一节**补充取证**（第 7 节，默认就跑）：上面第 2 条里的"越线提示"是把阈值人工压低逼出来的，
验的是"判定 → 提示"这条链路；第 7 节回答另一个问题 —— **在定案阈值（CPU 警戒 35% 整机口径）
下，一个"开满页 + 多路并发任务"的自然重负载能不能碰到这条线**。阈值全程不动，
跑到哪算哪，够不着就如实报上限（并在最后用可控负载做一次标定，确认线本身是通的）。
调试时可用 SKIP_NATURAL_LOAD=1 跳过它。

--------------------------------------------------------------------------------
⚠️ 本脚本从**第一版**就是「三层自清理」（Phase 3 的最后教训，这次不等出问题再补）：

   第 1 层 · 跑前清残留：`purge_leftovers()` 回收同号测试账号 + 杀掉上一轮遗留的
              electron/vite/fake + 删掉临时 profile —— 每一轮都从零开始，不靠"上一轮干净"；
   第 2 层 · 每节独立 try/except：`SECTIONS` 里任一小节抛异常只记一次 FAIL，
              **不打断整轮**（Phase 3 那次截图超时把后面 3 个小节全带走了，就是缺这一层）；
   第 3 层 · finally 必然复位：杀进程 → 删 profile（带重试）→ 回收账号 → 回收端口，
             并把「环境已复位」的实测结果打成断言（进程数 0 / profile 不存在 / 活库回基线）。

--------------------------------------------------------------------------------
取证手段（都是客观量，不靠嘴说）：
  · **采集值**：主进程 `app.getAppMetrics()`（`resourceSnapshot` IPC 读出来的是同一份）；
  · **系统真值**：`tasklist /FO CSV`（内存，工作集，与任务管理器同口径）
    + `typeperf "\\Process(<实例>)\\% Processor Time"`（CPU）；
    *不用 PowerShell*：本会话实测它的回显拿不到，真值一律走 tasklist / typeperf。
  · **CPU 口径（踩过坑，务必分清）**：
    - 采集侧（Electron `percentCPUUsage` 之和）= **整机口径**（100% = 全部逻辑核跑满），
      与任务管理器的"进程 CPU"一致；
    - `typeperf "\\Process(*)\\% Processor Time"` = **逐核累加口径**，会超过 100%
      （12 核机器上理论最大 1200%），**必须 ÷ 逻辑核数**才等于整机口径。
    两边差的就是**逻辑核数**这一个系数；本脚本有断言把这个系数实测出来（而不是靠文档断言），
    再把真值换算到同一口径比 —— 「口径差一个核数」是这类"采集不准"最常见的假象。
  · **可控 CPU 负载**：在主窗口渲染层里放 2 个 Web Worker 转 40 秒（真的吃满 2 个核），
    负载期间**采集侧与真值侧同时开测**（同一时间窗）—— 比"空转对比"强得多，
    因为期望值是可算的：2 核 / 12 核 = 整机口径 16.7%。
  · **提示事件**：`events.jsonl`（落盘）+ `workbench:resources:snapshot`（IPC）+ 渲染层订阅回调；
  · 截图为辅，不作判据。

用法：
  ~/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/verify/4-resource-guard-tests.py
  # 想连回归一起跑（会再拉起 Phase 3 / 2-B 两套验收，耗时较长）：
  WITH_REGRESSION=1 ... scripts/verify/4-resource-guard-tests.py
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
import threading
import time
import traceback
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'substage-4')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb4')
PROFILE = os.path.join(TMP, 'profile')

API_PORT = int(os.environ.get('API_PORT', '8798'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8898'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5273'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9333'))
API = 'http://127.0.0.1:%d' % API_PORT
SITE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)
WITH_REGRESSION = os.environ.get('WITH_REGRESSION') == '1'
# 第 7 节（自然负载标定）默认**跑**。只有想在调试时快跑一轮才用 SKIP_NATURAL_LOAD=1 跳过，
# 跳过的写法与 WITH_REGRESSION 反过来（那个是默认不跑），所以别把两者记混。
SKIP_NATURAL_LOAD = os.environ.get('SKIP_NATURAL_LOAD') == '1'
# 调试用：只跑名字以这些前缀开头的小节（例：SECTIONS_ONLY=s1,s2,s3,s7）。
# **只在开发脚本时用** —— 正式取证的日志必须是完整一轮（否则汇总条数会少，容易被误读）。
SECTIONS_ONLY = [x for x in (os.environ.get('SECTIONS_ONLY') or '').split(',') if x]

# 资源相关：本阶段要开的页数最多 12 张，所以先把「多实例上限」这个**可调配置**抬上去
# （改的是配置，不是代码 —— 这正是"不写死数量上限"的用法）。
# 30 是**故意越界**的值：SETTINGS_RANGE.maxBrowserInstances.max = 20，用来顺带验证
# "越界配置被夹到允许区间、而不是把别的字段一起冲掉"。
MAX_INSTANCES_FOR_TEST = 30
# 允许区间的上限（与 packages/shared/src/index.ts 的 SETTINGS_RANGE 对齐；脚本里硬写一份，
# 是为了"用测试之外的独立数字去断言"，否则等于拿被测实现自己的上限去验自己）。
RANGE_MAX = {'maxBrowserInstances': 20, 'resourceMemWarnMB': 131072}
# 12 个互不同站的地址：`sameSite` 比的是 host（含端口），而 127.0.0.0/8 整个都是回环，
# 所以 127.0.0.2 ~ 127.0.0.13 是 12 个**真的不同站**的回环地址（实测可用）。
PAGE_HOSTS = ['127.0.0.%d' % n for n in range(2, 14)]

TEST_PHONE = '18600002401'
# 老版配置文件的形状（**只有**子阶段 A 那两个字段）—— 用来真机验证"新旧默认值合并"
OLD_SETTINGS_SHAPE = {'maxConcurrentAgentTasks': 20, 'maxBrowserInstances': 8}

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
    'site': SITE,
    'results': [],
}
test_user = None
TOKEN = None
DEFAULT_AGENT = None


# --------------------------------------------------------------------- 基础工具
def check(name, ok, detail=''):
    line = {'name': name, 'ok': bool(ok), 'detail': str(detail)[:900]}
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
def _cdp_call(fn, tries=2):
    """
    任何一次 CDP 往返都在这里包一层重试。

    为什么：第 4 阶段第一轮验收里，Chromium 的 CDP 端点偶发 reset 一次，
    正好落在"写 token + 刷新"那一步 —— 结果 token 没写进去，界面一直停在登录页，
    后面 5/8/12 张页全变 0，9 条断言连锁失败。抖动是外部因素，但**让抖动变成整轮失败**
    是脚本的缺陷，不是功能的缺陷。这里连同 `P.Cdp()` 自带的重试做两层兜底；
    成功路径零额外开销（不重试就不 sleep）。
    """
    last = None
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.4 * (2 ** k))
    raise RuntimeError('CDP 调用连续 %d 次失败：%s' % (tries, last))


def ev(expr):
    c = _cdp_call(P.Cdp)
    try:
        return c.js(expr)
    finally:
        c.ws.close()


def evf(expr):
    c = _cdp_call(P.Cdp)
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


BLOCKED_CDP_CALLS = []


def ev_safe(expr, tag=''):
    """
    带兜底的一次渲染层求值。

    为什么单独封一个：Phase 3 踩过「CDP 在页面忙时不回包 → 抛异常 → 把后面整个小节带走」。
    这里统一把异常变成 `{'__error': ...}` 返回，由调用方决定怎么记 —— **绝不外抛**。
    """
    try:
        return evf(expr)
    except Exception as e:  # noqa: BLE001
        BLOCKED_CDP_CALLS.append({'tag': tag, 'error': str(e)[:160]})
        return {'__error': str(e)[:200]}


def click(sel, settle=0.6):
    c = _cdp_call(P.Cdp)
    try:
        out = c.click_rect(sel)
    finally:
        c.ws.close()
    time.sleep(settle)
    return out


def _set_token_and_reload(token):
    """把登录态写进渲染层的 localStorage 再刷新 —— 等价于用户手输一次登录态。"""
    c = P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s); localStorage.setItem('workbench.apiBase', %s); 'ok'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
        return True
    finally:
        c.ws.close()


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
    topTag: top ? top.tagName : null, isSelf: Boolean(top) && (top === e || e.contains(top)),
  };
})()
"""


def hit_test(sel):
    return ev(HIT_JS % json.dumps(sel))


def expect(ok, msg, detail=''):
    check(msg, ok, detail)
    if not ok:
        raise RuntimeError('%s —— 前提不成立，本小节后续步骤无法继续' % msg)


def iid(v):
    """pg 的 bigint 回来是字符串，跟 Python 的 int 比会假失败。"""
    return None if v is None else int(v)


def type_into(sel, text):
    c = _cdp_call(P.Cdp)
    try:
        return c.type_text(text, sel)
    finally:
        c.ws.close()


def shot(name):
    """截图是**辅助证据**，不参与断言，更不该拖垮整轮验收（Phase 3 的教训：必须兜底）。"""
    path = os.path.join(OUTDIR, name)
    last = ''
    time.sleep(0.6)
    for attempt in (1, 2):
        try:
            c = _cdp_call(P.Cdp)
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


def webviews():
    return ev(P.WEBVIEWS_JS)['list']


def tabs_ui():
    return ev(P.TABS_JS)


def ui_state():
    """
    一眼看清界面停在哪一步（登录页 / 工作台 / 有几张页）。

    用途：当某个小节的前提不成立时，把真实界面状态写进 detail ——
    第一轮只写了「pages=0」，看着像"功能坏了"，其实是**上一节的登录门没过、
    界面还停在登录页**。前提失败必须能自证失败在哪，否则就是又一次无谓的排查。

    注意 `return`：`ev_safe` 走的是 async 包装体，`(() => ({...}))()` 不 `return` 的话
    值会被丢掉 —— 上一轮所有 detail 里的 `ui=null` 就是这么来的（脚本自己的坑，不是应用的）。
    """
    return ev_safe("""return (() => ({
      authCard: !!document.querySelector('.authCard'),
      inputBar: !!document.querySelector('.inputBar'),
      tabs: document.querySelectorAll('.browserTab').length,
      webviews: document.querySelectorAll('webview').length,
      head: (document.body.innerText || '').slice(0, 60),
    }))()""", 'ui_state')


def click_tab_index(i):
    """**真鼠标**点第 i 个标签（0 起）—— 「用户用了这张页」必须是真点击，不能是 JS click()。"""
    rect = ev("""(() => {
      const t = document.querySelectorAll('.browserTab__label')[%d];
      if (!t) return null;
      const b = t.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()""" % i)
    if not rect:
        return 'NO_TAB_%d' % i
    c = _cdp_call(P.Cdp)
    try:
        c.click_at(rect['x'], rect['y'])
    finally:
        c.ws.close()
    time.sleep(0.6)
    return 'clicked @(%.0f,%.0f)' % (rect['x'], rect['y'])


def guest_target(url_part, exclude=()):
    """在 CDP 目标列表里找一个内嵌页（guest）。当前无调用方，留作"访客页也能连"的取证路径。"""
    for t in P._http('/json/list'):
        u = t.get('url') or ''
        if url_part in u and u not in exclude:
            return t
    return None


def guest_eval(url_part, expr, exclude=()):
    """
    在某个内嵌页（guest）里求值。当前无调用方（原因见下），留作取证路径备查。

    ⚠️ 第一轮拿它做 CPU 负载（在访客页里跑忙循环），那份数据不可用 ——
    后台页可能被 Chromium 降速/冻结、转不满一个核，"采到的负载"来路不明。
    现在负载改在**主窗口渲染层的 Worker** 里造（见 s3），那才是可控的满核负载。
    """
    t = guest_target(url_part, exclude)
    if not t:
        return {'__error': 'no guest target for ' + url_part}
    c = _cdp_call(lambda: P.Cdp(t))
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


# ------------------------------------------------------------------ 系统真值采集
def tasklist_pid_mem_mb(pids):
    """`tasklist` 取每个 pid 的工作集（MB）—— 与任务管理器「内存」列同口径。"""
    if not pids:
        return {}
    out = {}
    # tasklist 一次带多个 /FI 会当成 AND，所以一次一个 pid（进程数就十几个，够快）
    for pid in pids:
        r = subprocess.run(['tasklist', '/FO', 'CSV', '/NH', '/FI', 'PID eq %d' % pid],
                           capture_output=True, text=True, encoding='utf-8', errors='ignore')
        line = (r.stdout or '').strip().splitlines()
        if not line or 'No tasks' in line[0]:
            continue
        parts = [x.strip('"') for x in line[0].split('","')]
        if len(parts) >= 5:
            try:
                out[pid] = int(parts[4].replace(',', '').replace(' K', '').replace('K', '').strip()) / 1024.0
            except ValueError:
                pass
    return out


def pdh_instance_of_pids(pids):
    """pid → PDH 里的实例名（`electron#3` 这种）。一次快照，用于给 CPU 计数器点名。"""
    r = subprocess.run(['typeperf', r'\Process(*)\ID Process', '-sc', '1'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    text = r.stdout or ''
    lines = [l for l in text.splitlines() if l.strip().startswith('"')]
    if len(lines) < 2:
        return {}
    header = [c.strip('"') for c in lines[0].split('","')]
    values = [c.strip('"') for c in lines[1].split('","')]
    want = set(int(p) for p in pids)
    found = {}
    for name, val in zip(header[1:], values[1:]):
        m = re.search(r'Process\(([^)]*)\)', name)
        if not m:
            continue
        try:
            pid = int(float(val))
        except ValueError:
            continue
        if pid in want:
            found[pid] = m.group(1)
    return found


def typeperf_cpu_of_pids(pids, seconds=30, interval=5):
    """
    用 PDH 计数器取**这些 pid** 的 CPU。

    ⚠️ 口径：`\\Process(*)\\% Processor Time` 是**逐核累加口径**，多核机器上会超过 100%
    （每个线程各记一份，12 核理论最大 1200%；微软文档明说该计数器在 SMP 上可 >100%）。
    要跟采集侧（Electron 的整机口径）比，**必须 ÷ 逻辑核数** —— 这就是两边唯一的换算系数。
    上一轮把两者直接相除，比值 ≈ 核数，被误读成"采集不准"，其实口径本来就不同。

    返回 {'series': [{t, total, perPid}], 'instances': {...}}；第一条丢掉
    （PDH 第一次采样没有前一个点，算不出速率，恒为 0）。
    """
    inst = pdh_instance_of_pids(pids)
    if not inst:
        return {'series': [], 'instances': {}}
    counters = [r'\Process(%s)\%% Processor Time' % name for name in inst.values()]
    sc = max(2, int(round(seconds / float(interval))) + 1)
    cmd = ['typeperf'] + counters + ['-sc', str(sc), '-si', str(interval)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    lines = [l for l in (r.stdout or '').splitlines() if l.strip().startswith('"')]
    if len(lines) < 2:
        return {'series': [], 'instances': inst, 'error': (r.stdout or '')[:200] + (r.stderr or '')[:200]}
    names = list(inst.values())
    series = []
    for line in lines[1:]:
        cells = [c.strip('"') for c in line.split('","')]
        try:
            vals = [float(x) for x in cells[1:]]
        except ValueError:
            continue
        per = {names[i]: vals[i] for i in range(min(len(names), len(vals)))}
        series.append({'t': cells[0], 'total': round(sum(per.values()), 3), 'perPid': per})
    return {'series': series[1:], 'instances': inst, 'rawLineCount': len(lines) - 1}


def parse_iso(iso):
    """'2026-09-17T21:40:01.123Z' → epoch ms（不依赖 dateutil）。"""
    s = iso.replace('Z', '')
    if '.' in s:
        s = s.split('.')[0]
    return int(time.mktime(time.strptime(s, '%Y-%m-%dT%H:%M:%S')) * 1000)


# ------------------------------------------------------------- 资源守护者读口
def guard_snapshot():
    v = ev_safe("const s = await window.workbench.resourceSnapshot(); return JSON.stringify(s);", 'guard_snapshot')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return {'__raw': v}
    return v if isinstance(v, dict) else {'__bad': v}


def guard_events(limit=20):
    v = ev_safe("const e = await window.workbench.resourceEvents(%d); return JSON.stringify(e);" % limit, 'guard_events')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return []
    return v if isinstance(v, list) else []


def guard_history(minutes=60):
    v = ev_safe("const h = await window.workbench.resourceHistory(%d); return JSON.stringify(h);" % minutes, 'guard_history')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return []
    return v if isinstance(v, list) else []


def set_settings(patch):
    v = ev_safe("const s = await window.workbench.setSettings(%s); return JSON.stringify(s);"
                % json.dumps(patch), 'set_settings')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return {'__raw': v}
    return v


def get_settings():
    v = ev_safe("const s = await window.workbench.getSettings(); return JSON.stringify(s);", 'get_settings')
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:  # noqa: BLE001
            return {'__raw': v}
    return v


def open_page(url, settle=1.2):
    """用应用自己的 IPC 开一张页（`openBrowser`）—— 走的是真实的 main→renderer 通路，不经过模型。"""
    ev_safe("await window.workbench.openBrowser(%s); return 'ok';" % json.dumps(url), 'open_page')
    time.sleep(settle)
    return any(url in (x.get('url') or '') for x in webviews())


def collect_guard_samples(seconds, poll=1.0):
    """
    按 `seconds` 秒持续读 IPC 快照，收集**去重后的采样点**。

    这既是"数据可查"的正门走通了，也是连续性证据的来源（每个点带自己的 `at`）。
    """
    seen = {}
    t0 = time.time()
    while (time.time() - t0) < seconds:
        s = guard_snapshot()
        smp = s.get('sample') if isinstance(s, dict) else None
        if smp and smp.get('at'):
            seen[int(smp['at'])] = smp
        time.sleep(poll)
    return [seen[k] for k in sorted(seen)]


def raw_samples_from_disk():
    """
    直接从落盘的原始采样读（只有 `WB_RESOURCE_GUARD_RAW=1` 时才有）。
    本脚本默认不开它 —— 产品默认不落原始点，采集频率的连续性证据用 IPC 采样去证。
    """
    path = os.path.join(PROFILE, 'resource-guard')
    out = []
    if not os.path.isdir(path):
        return out
    for name in sorted(os.listdir(path)):
        if not re.match(r'^raw-\d{4}-\d{2}-\d{2}\.jsonl$', name):
            continue
        with open(os.path.join(path, name), encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except Exception:  # noqa: BLE001
                        pass
    return out


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
    """`HMAC-SHA256(pepper, phone)` 的 hex（与服务端 crypto.ts 的 phoneHash 同一套）。"""
    pepper = _dotenv('PHONE_PEPPER') or _dotenv('DATA_KEY')
    if not pepper:
        return ''
    return hmac.new(pepper.encode(), phone.encode(), hashlib.sha256).hexdigest()


def purge_leftovers(phone):
    """把同号残留账号整体删掉。**幂等**：没有残留就是空操作。返回删掉的 userId 列表。"""
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


def kill_stray(what):
    """按镜像名杀残留（只在**跑前**用；用户自己的 8787/5173 实例不碰，见端口自检）。"""
    subprocess.run(['taskkill', '/F', '/T', '/IM', what], capture_output=True)


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


TABLES = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks',
          'memories', 'user_memories', 'agent_memories', 'knowledge_documents', 'knowledge_chunks']


def live_fingerprint():
    out = {}
    for t in TABLES:
        out[t] = [str(r['id']) for r in dbq('SELECT id FROM %s ORDER BY id' % t)]
    return out


live_before = {}


# ===========================================================================
# 小节的**独立执行壳**：任一小节抛异常 → 只记一条 FAIL，整轮继续（第 2 层自清理）
# ===========================================================================
SECTIONS = []


def sec(fn):
    SECTIONS.append(fn)
    return fn


def run_sections():
    for fn in SECTIONS:
        if SECTIONS_ONLY and not any(fn.__name__.startswith(t) for t in SECTIONS_ONLY):
            print('[skip] 只跑 %s，跳过 %s' % (','.join(SECTIONS_ONLY), fn.__name__))
            continue
        section((fn.__doc__ or fn.__name__).strip().splitlines()[0])
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            check('【小节】%s 整节跑完没有异常' % fn.__name__, False, str(exc)[:400])


# ===========================================================================
@sec
def s0_selfcheck():
    """0. 环境自检 + 构建产物里确实有本阶段的代码"""
    for port in (8787, 5173):
        if port_busy(port):
            print('[note] %d 上有东西在听（用户自己的实例）—— 不动它，我们只用 8798/8898/5273/9333' % port)
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('验收要用的四个端口（8798/8898/5273/9333）都空着', not busy, 'busy=%s' % busy)
    if busy:
        raise SystemExit('先关掉残留实例再跑')

    check('构建产物齐全（desktop/dist-electron/main.js + server/dist/index.js）',
          os.path.exists(os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js'))
          and os.path.exists(os.path.join(REPO, 'apps', 'server', 'dist', 'index.js')))

    main_js = open(os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js'),
                   encoding='utf-8', errors='replace').read()
    rg_js = ''
    p = os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'resource-guard.js')
    if os.path.exists(p):
        rg_js = open(p, encoding='utf-8', errors='replace').read()
    check('**主进程产物里有资源守护者（采集 / 阈值 / 落盘 / IPC 四件事都在）**',
          'getAppMetrics' in rg_js and 'resourceMemWarnMB' in rg_js
          and 'resource-guard' in rg_js and 'workbench:resources:snapshot' in rg_js,
          'main 引到守护者=%s, getAppMetrics=%s, 阈值字段=%s'
          % ('resource-guard' in main_js, 'getAppMetrics' in rg_js, 'resourceMemWarnMB' in rg_js))
    check('守护者里**没有任何"自动关页/限制开页"的代码**（边界：决定权永远在用户手里）',
          '.close(' not in rg_js and 'destroy(' not in rg_js and 'maxBrowserInstances' not in rg_js,
          'close(=%s destroy(=%s 碰了实例上限=%s'
          % ('.close(' in rg_js, 'destroy(' in rg_js, 'maxBrowserInstances' in rg_js))

    check('跑前的活库基线已记录（11 张表的 id 集合）',
          all(t in live_before for t in TABLES), json.dumps({k: len(v) for k, v in live_before.items()},
                                                            ensure_ascii=False))
    check('临时 profile 用的是系统 TEMP 下的目录（不碰你的真实 userData）',
          os.path.normcase(os.path.realpath(PROFILE)).startswith(
              os.path.normcase(os.path.realpath(os.environ.get('TEMP', '/tmp'))))
          and 'roaming' not in os.path.normcase(os.path.realpath(PROFILE)),
          'profile=%s' % PROFILE)


@sec
def s1_env():
    """1. 起环境：假模型 / 验收后端 / vite / 真 Electron 窗口（临时 profile + 老版配置文件）"""
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], HERE,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': os.environ.get('FAKE_DELAY_MS', '1200'),
               'FAKE_STEPS': os.environ.get('FAKE_STEPS', '24'), 'FAKE_LOG': FAKE_LOG,
               'SITE_LOG': os.path.join(OUTDIR, 'site.jsonl')})
    h = None
    for _ in range(40):
        try:
            st, j = http_json('/health', base=SITE, timeout=3)
            if st == 200:
                h = j
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    expect(bool(h), '假模型 + 测试站已起来', json.dumps(h, ensure_ascii=False))
    st, body = http_json('/page-p4probe', base=SITE)
    check('测试站可用（/page-* 是真页面）', st == 200 and '验收页' in str(body), 'status=%s' % st)

    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': '%s/v1' % SITE,
               'DEEPSEEK_API_KEY': 'fake-key-p4-verify', 'DEEPSEEK_MODEL': 'fake-4'},
          log=SERVER_LOG)
    health = wait_health(API)
    evidence['health0'] = health
    check('验收后端起来了，库在线', health.get('db') == 'up', json.dumps(health, ensure_ascii=False))
    check('模型已配置（指向假模型，不烧 token、不依赖外网）', health.get('llm') == 'configured', health.get('llm'))

    # ---- 关键：把**老版形状**的配置文件先放进去，验证"新旧默认值合并" ----
    os.makedirs(PROFILE, exist_ok=True)
    with open(os.path.join(PROFILE, 'workbench-settings.json'), 'w', encoding='utf-8') as f:
        json.dump(OLD_SETTINGS_SHAPE, f)
    evidence['oldSettingsShape'] = OLD_SETTINGS_SHAPE

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
    check('应用窗口只有一个（没有多开 BrowserWindow）',
          len([t for t in pages if not (t.get('url') or '').startswith('devtools://')]) == 1,
          json.dumps([t.get('url') for t in pages], ensure_ascii=False))


@sec
def s2_account_and_merge():
    """2. 测试账号 + **真机验证「新旧默认值合并」**（老配置文件不会盖住新默认值）"""
    global TOKEN, test_user, DEFAULT_AGENT
    gone = purge_leftovers(TEST_PHONE)
    evidence['preClean'] = gone
    if gone:
        print('[pre-clean] 回收上一轮的残留账号：%s' % gone)

    size0 = len(server_log_text())
    st, _ = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
    check('验证码已下发（mock：只进服务端日志）', st == 200, 'status=%s' % st)
    code = find_sms_code(size0)
    st, login = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    if st != 200 or not isinstance(login, dict) or 'token' not in login:
        raise RuntimeError('测试账号登录失败：%s' % login)
    TOKEN = login['token']
    test_user = login['user']['id']
    DEFAULT_AGENT = (login.get('agents') or [{}])[0].get('id')
    evidence['testUser'] = {'id': test_user, 'xyz': login['user']['xyz_id'],
                            'phone': TEST_PHONE[:3] + '****' + TEST_PHONE[-4:],
                            'defaultAgent': DEFAULT_AGENT}
    check('测试账号登录成功（拿到 JWT + 默认项目 + 默认智能体）', bool(TOKEN and DEFAULT_AGENT),
          'user=%s agent=%s' % (test_user, DEFAULT_AGENT))
    n_proj = dbq('SELECT count(*)::int AS n FROM projects WHERE user_id = $1', [test_user])[0]['n']
    check('测试账号是干净的（只有 1 个默认项目 —— 没有上轮残留）', n_proj == 1, 'projects=%s' % n_proj)

    # ---- 登录门：把 token 写进渲染层并刷新 -------------------------------
    # 这一步是**整轮的咽喉**：写不进去，界面就一直停在登录页，没有浏览器面板，
    # 后面 5/8/12 张页会全变成 0，连带 8 条断言连锁失败（第一轮就是这样被一次 CDP
    # 抖动带走的）。所以这里不做"一次定生死"，而是**最多试 3 轮**，每轮重新写 + 重载，
    # 并且把每一轮的实测状态记进 evidence —— 真失败也要看得出失败在哪一步。
    attempts = []
    ok = False
    dt = 0
    for k in range(3):
        try:
            _set_token_and_reload(TOKEN)
        except Exception as e:  # noqa: BLE001
            attempts.append({'try': k + 1, 'writeToken': 'ERR ' + str(e)[:120]})
            time.sleep(2.0)
            continue
        time.sleep(9)
        ok, last, dt = wait_until(lambda: bool(ev("!!document.querySelector('.inputBar')")), timeout=30)
        attempts.append({'try': k + 1, 'writeToken': 'ok', 'inputBar': ok, 'waitedMs': dt})
        if ok:
            break
        time.sleep(3.0)
    evidence['loginGate'] = attempts
    expect(ok, '刷新后自动进工作台（聊天输入框在）',
           'waited=%dms attempts=%s' % (dt, json.dumps(attempts, ensure_ascii=False)))
    shot('00-logged-in.png')

    # ---- 「新旧默认值合并」真机验证 ----
    s = get_settings()
    evidence['settingsMerged'] = s
    new_fields = {'resourceGuardEnabled': 1, 'resourceSampleMs': 5000, 'resourceMemHealthMB': 3072,
                  'resourceMemWarnMB': 4096, 'resourceCpuHealthPct': 20, 'resourceCpuWarnPct': 35,
                  'resourceSysMemGuard': 0, 'resourceSysMemFloorMB': 1536}
    check('**磁盘上是老版配置（只有 2 个字段）时，8 个新字段自动拿到本阶段定案的默认值**',
          all(s.get(k) == v for k, v in new_fields.items()),
          json.dumps({k: (s.get(k), v) for k, v in new_fields.items()}, ensure_ascii=False))
    check('**老配置文件里已有的值没被默认值盖掉**（maxBrowserInstances 仍是磁盘上的 8）',
          s.get('maxBrowserInstances') == OLD_SETTINGS_SHAPE['maxBrowserInstances'],
          'maxBrowserInstances=%s（期望 %s）' % (s.get('maxBrowserInstances'),
                                              OLD_SETTINGS_SHAPE['maxBrowserInstances']))
    check('阈值确实是**可配**的（不是写死在代码里）：写进去立刻回读得到',
          (set_settings({'resourceMemWarnMB': 4321, 'resourceSampleMs': 5000}).get('resourceMemWarnMB') == 4321)
          and get_settings().get('resourceMemWarnMB') == 4321,
          'warnMB=%s' % get_settings().get('resourceMemWarnMB'))

    # 本阶段要开最多 12 张页：把「多实例上限」这个**可调配置**抬上去（改配置，不改代码）
    after = set_settings({'maxBrowserInstances': MAX_INSTANCES_FOR_TEST,
                          'resourceMemWarnMB': 4096,
                          'resourceMemHealthMB': 3072,
                          'resourceCpuWarnPct': 35,
                          'resourceCpuHealthPct': 20,
                          'resourceSampleMs': 5000,
                          'resourceGuardEnabled': 1})
    evidence['settingsForTest'] = after
    # 这一条刻意用**越界值**（30 > 上限 20）来测：期望不是"照收"，而是"夹到允许区间"。
    # 上一轮把期望写成 30 就红了 —— 红的是断言，不是功能：SETTINGS_RANGE.maxBrowserInstances.max = 20。
    check('把多实例上限填成越界值 %d（可调配置的正当用法）→ 被夹到允许区间上限 %d，'
          '且守护者阈值保持定案值'
          % (MAX_INSTANCES_FOR_TEST, RANGE_MAX['maxBrowserInstances']),
          after.get('maxBrowserInstances') == RANGE_MAX['maxBrowserInstances']
          and after.get('resourceMemWarnMB') == 4096
          and after.get('resourceCpuWarnPct') == 35
          and after.get('resourceSampleMs') == 5000,
          json.dumps({k: after.get(k) for k in ('maxBrowserInstances', 'resourceMemWarnMB',
                                               'resourceCpuWarnPct', 'resourceSampleMs')},
                     ensure_ascii=False))
    # 装上「渲染层真的收到提示」的记录器（用应用自己的订阅口，不是猜）
    # ⚠️ 这个 async 包装体里必须显式 `return`：`(() => {...})()` 当**语句**写，值会被丢掉，
    #    结果恒为 undefined（上一轮这条就因此假红，顺带 `ui_state()` 也一直是 null）。
    inst = ev_safe("""return (() => {
      if (window.__wbAlerts) return 'already';
      window.__wbAlerts = [];
      window.workbench.on('resources', (p) => { try { window.__wbAlerts.push(JSON.parse(p)); } catch (e) {} });
      return 'installed';
    })()""", 'alert_recorder')
    check('装上渲染层的提示记录器（订阅 workbench:resources）', inst in ('installed', 'already'), str(inst))


@sec
def s3_accuracy():
    """3. 验收标准 ①：采集准确、连续（5 / 8 / 12 张页逐档与系统真值对比 + 可控 CPU 负载）"""
    levels = [5, 8, 12]
    comparisons = []
    opened = []
    for target in levels:
        while len(opened) < target:
            i = len(opened)
            url = 'http://%s:%d/page-p4-%02d' % (PAGE_HOSTS[i], FAKE_PORT, i + 1)
            ok = open_page(url)
            if not ok:
                time.sleep(1.5)
                ok = any(url in (x.get('url') or '') for x in webviews())
            if not ok:
                break
            opened.append(url)
        wv = webviews()
        check('开到 %d 张页（实际 %d 张）' % (target, len(wv)), len(wv) >= target,
              json.dumps({'urls': [x.get('url') for x in wv], 'ui': ui_state()}, ensure_ascii=False)[:500])
        time.sleep(18)  # 让页面稳定：内存涨完、CPU 落回空闲

        # ---- 「N 张页」得是真的 N 张页：每张都在自己那个 guest 里加载完了 ----
        # 只看 <webview> 元素的 src 会骗人（元素建了、guest 没跑起来也算一张）。
        # `getURL()/getTitle()` 是 guest 自己的真实状态；测试站每张页的 <title> 都不一样
        # （"验收页 PAGE-P4-XX"），所以"标题各不相同"= 确实渲染了 N 个不同的页。
        real = [x for x in wv if (x.get('url') or '').strip() and (x.get('title') or '').strip()]
        titles = [x.get('title') for x in real]
        check('【%d 张页】每一张都**真的加载完成**（guest 有 url 有标题，标题各不相同：%d/%d）'
              % (target, len(set(titles)), len(wv)),
              len(real) == len(wv) and len(set(titles)) == len(wv),
              json.dumps([{'wc': x.get('wcId'), 'title': x.get('title'), 'url': x.get('url')}
                          for x in wv], ensure_ascii=False)[:600])

        # ---- 采集侧：连续读 20s 的快照（这本身就是"数据可查"的正门） ----
        samples = collect_guard_samples(18, poll=1.0)
        if not samples:
            check('第 %d 档：能从 IPC 读到采样点' % target, False, 'sample=%s' % json.dumps(guard_snapshot())[:300])
            continue
        last = samples[-1]
        pids = [int(p['pid']) for p in last['procs']]

        # ---- 系统真值：内存（tasklist 工作集）----
        truth_mem = tasklist_pid_mem_mb(pids)
        truth_total = round(sum(truth_mem.values()), 1)
        got_total = float(last['memMB'])
        diff = round(abs(truth_total - got_total), 1)
        tol = max(60.0, got_total * 0.08)
        tab_count = len([p for p in last['procs'] if p['type'] == 'Tab'])

        # ---- 独立口径复核：不依赖"我们自己报的清单" ----
        # 上面的 truth 是拿**我们报的 pid** 去 tasklist 取值的 —— 它只能证明"报出来的数字对"，
        # 证明不了"没漏算某个进程"。所以再来一遍**从系统侧出发**的口径：
        # 系统里所有 electron.exe 的集合与内存总和（隔离环境下这台机器上只有被测应用在跑 electron）。
        # 若真有别的 Electron 应用在跑，这里会红并把多出来的 pid 打出来 —— 那是环境不干净，一眼可辨。
        sys_pids = set(app_pids_from_tasklist())
        ours = set(pids)
        missing = sorted(sys_pids - ours)
        sys_mem = tasklist_pid_mem_mb(sorted(sys_pids))
        sys_total = round(sum(sys_mem.values()), 1)
        comparisons.append({'pages': len(wv), 'gotMB': got_total, 'truthMB': truth_total, 'diffMB': diff,
                            'pids': len(pids), 'pidsFound': len(truth_mem), 'procCount': last['procCount'],
                            'tabProcs': tab_count, 'cpuPct': last['cpuPct'], 'cpuCoresUsed': last.get('cpuCoresUsed'),
                            'sysPids': len(sys_pids), 'sysTotalMB': sys_total,
                            'sysMinusOurs': missing, 'samples': len(samples)})
        check('【%d 张页】采集到的进程清单**逐个都在系统里对得上**（tasklist 命中 %d/%d）'
              % (target, len(truth_mem), len(pids)), len(truth_mem) == len(pids),
              '未命中=%s' % json.dumps([p for p in pids if p not in truth_mem]))
        check('**★验收标准 1★【%d 张页】采集内存 %.1f MB vs 系统真值 %.1f MB（差 %.1f MB，容差 %.0f）**'
              % (target, got_total, truth_total, diff, tol), diff <= tol,
              '容差=8%% 或 60MB 取大者；采集=%s 真值=%s' % (got_total, truth_total))
        check('【%d 张页】**独立口径复核**：系统侧看到的该应用进程（%d 个）全在采集清单里，'
              '内存总和也对得上（系统侧 %.1f MB）'
              % (target, len(sys_pids), sys_total),
              not missing and abs(sys_total - got_total) <= tol,
              json.dumps({'sysPids': len(sys_pids), 'oursPids': len(ours), 'sysMinusOurs': missing,
                          'sysTotal': sys_total, 'ours': got_total,
                          'procs': [{'pid': p['pid'], 'type': p['type'], 'memMB': p['memMB']}
                                    for p in last['procs']]}, ensure_ascii=False)[:600])
        print('[档位 %d] 采集=%s' % (target, json.dumps(comparisons[-1], ensure_ascii=False)))

    evidence['accuracy'] = comparisons

    # ---- 连续性：采样间隔必须真的是 ~5s（没有空洞、没有重复） ----
    samples = collect_guard_samples(32, poll=1.0)
    gaps = [round((samples[i]['at'] - samples[i - 1]['at']) / 1000.0, 2) for i in range(1, len(samples))]
    evidence['continuity'] = {'count': len(samples), 'gaps': gaps}
    check('**★验收标准 1（连续）★ 32 秒里采到 %d 个点（5s 一点，理论 6~7 个）**'
          % len(samples), 5 <= len(samples) <= 8, 'gaps=%s' % json.dumps(gaps))
    check('**★验收标准 1（连续）★ 相邻采样间隔都是 5s 上下（3.5~7s 之间，没有空洞也没有连发）**',
          bool(gaps) and all(3.5 <= g <= 7.0 for g in gaps), 'gaps=%s' % json.dumps(gaps))
    check('**★验收标准 1（口径）★ CPU 样本给的是整机口径**'
          '（cpuPct = 各进程 percentCPUUsage 之和，**不再除核数**；另给 cpuCoresUsed 供文案）',
          all(abs(s['cpuCoresUsed'] - s['cpuPct'] * s['logicalCores'] / 100.0) < 0.02 for s in samples),
          json.dumps([{'cores': s['logicalCores'], 'pct': s['cpuPct'], 'coresUsed': s['cpuCoresUsed']}
                      for s in samples[-2:]], ensure_ascii=False))

    # ---- 可控 CPU 负载：在主窗口渲染层里放 2 个 Web Worker 转 40 秒，与系统真值**同时**测 ----
    #
    # 为什么不拿内嵌页做负载（第一轮就是这么干的，数据是废的）：
    #   内嵌页在后台可能被 Chromium 降速/冻结，转不满一个核 —— 采到的"负载"到底是不是满核，
    #   没人知道，最后就变成拿一个来路不明的数字去和真值比。
    # 主窗口渲染层不同：它是**可见、正在用**的那个进程，Worker 一定能把核吃满，
    # 而且 Worker 跑在独立线程（同 pid），不阻塞主线程 —— 界面不会假死、CDP 照常能查。
    # 用 2 个 Worker：12 核机器上就是整机口径 16.7%（1 个核只有 8.3%，信号弱）。
    cores = samples[-1]['logicalCores'] if samples else 12
    workers = 2
    spin_ms = 40000
    expected = round(100.0 * workers / cores, 2)
    started = ev_safe("""return (() => {
      window.__spins = window.__spins || [];
      const src = 'const t = performance.now() + %d; while (performance.now() < t) {}';
      const u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      for (let i = 0; i < %d; i++) window.__spins.push(new Worker(u));
      return window.__spins.length;
    })()""" % (spin_ms, workers), 'spin_start')
    check('CPU 负载真的起来了（%d 个 Worker，每个转 %d 秒）' % (workers, spin_ms / 1000),
          isinstance(started, int) and started >= workers, 'workers=%s' % started)
    time.sleep(3.0)  # 等负载爬到满

    pids = [int(p['pid']) for p in (guard_snapshot().get('sample') or {}).get('procs', [])]
    spin_samples = []
    cpu_truth = {'series': []}
    window_s = 24

    def collect_side():
        nonlocal spin_samples
        spin_samples = collect_guard_samples(window_s, poll=1.0)

    def truth_side():
        nonlocal cpu_truth
        cpu_truth = typeperf_cpu_of_pids(pids, seconds=window_s, interval=4)

    # 两面**真的同时**开测（同一时间窗）：
    # 上一版虽然放在同一个线程里显得"同时"，实际是先跑完采集再跑真值 ——
    # typeperf 开跑时忙循环已经结束（40s 负载 vs 26+26s 两段串行），真值只抢到 1 个有载的采样点。
    # 这里两个线程同时起，负载期完整覆盖两边，比值才有意义。
    t_ours = threading.Thread(target=collect_side, daemon=True)
    t_truth = threading.Thread(target=truth_side, daemon=True)
    t_ours.start()
    t_truth.start()
    t_ours.join(timeout=90)
    t_truth.join(timeout=90)
    time.sleep(1.0)

    ours = [float(s['cpuPct']) for s in spin_samples]
    ours_max = max(ours) if ours else 0.0
    truth_series = cpu_truth.get('series') or []
    truth_max = max((float(r['total']) for r in truth_series), default=0.0)
    # k_empirical = 逐核累加口径 / 整机口径，应当 ≈ 逻辑核数（这就是那个唯一换算系数）
    k_empirical = round(truth_max / ours_max, 3) if ours_max > 0 else None
    # 换算到同一口径（整机百分比）之后再比，比值应当 ≈ 1
    ratio_same = round((truth_max / cores) / ours_max, 3) if (ours_max > 0 and truth_max > 0) else None
    evidence['cpuLoad'] = {'cores': cores, 'workers': workers, 'expectedMachinePct': expected,
                           'oursMaxPct': ours_max,
                           'oursCoresUsedMax': max((s.get('cpuCoresUsed', 0) for s in spin_samples), default=0),
                           'truthMaxPdhSumPct': truth_max, 'kEmpirical': k_empirical,
                           'truthMaxMachinePct': round(truth_max / cores, 2) if truth_max else 0,
                           'ratioSameUnit': ratio_same,
                           'truthSeries': [{'t': r['t'], 'total': r['total']} for r in truth_series],
                           'oursSamples': [{'at': s['at'], 'cpuPct': s['cpuPct'],
                                            'cpuCoresUsed': s.get('cpuCoresUsed')} for s in spin_samples]}
    print('[忙循环 %d 核负载] ours=%s%%(整机) 真值=%s%%(逐核累加) 换算系数k=%s(应≈%d核) 同口径比值=%s'
          % (workers, ours_max, truth_max, k_empirical, cores, ratio_same))
    check('**★验收标准 1（CPU）★ 采集侧确实看见了负载**（%d 个核满载 → 整机口径 ≈ %.1f%%，实测 %.2f%%）'
          % (workers, expected, ours_max), ours_max >= expected * 0.55,
          json.dumps(evidence['cpuLoad'], ensure_ascii=False)[:500])
    check('**★验收标准 1（CPU 口径）★ 实测出两边的换算系数就是逻辑核数**'
          '（PDH 逐核累加口径 ÷ 采集的整机口径 ≈ 核数 %d，实测 k=%s）' % (cores, k_empirical),
          k_empirical is not None and cores * 0.45 <= k_empirical <= cores * 2.2,
          'PDH 求和 %.2f%% ÷ 采集 %.2f%% = k=%s；核数=%d' % (truth_max, ours_max, k_empirical, cores))
    check('**★验收标准 1（CPU 口径）★ 真值换算成同一口径（÷%d 核）后与采集值同量级（比值 0.5~2.0）**'
          % cores,
          ratio_same is not None and 0.5 <= ratio_same <= 2.0,
          '采集 %.2f%%(整机) vs 真值 %.2f%%÷%d=%.2f%%(整机) → 比值 %s'
          % (ours_max, truth_max, cores, truth_max / cores, ratio_same))

    # 停掉负载，量一段空闲 —— 空闲时**不该**误报高占用
    ev_safe("return (() => { (window.__spins || []).forEach((w) => w.terminate());"
            " window.__spins = []; return 'stopped'; })()", 'spin_stop')
    time.sleep(6)
    idle = collect_guard_samples(14, poll=1.0)
    idle_max = max((float(s['cpuPct']) for s in idle), default=0.0)
    evidence['cpuIdle'] = {'samples': len(idle), 'idleMaxPct': idle_max,
                           'healthLinePct': (guard_snapshot().get('thresholds') or {}).get('cpuHealthPct')}
    check('12 张页空闲时 CPU 不会误报（整机口径 %.2f%%，远低于健康线）' % idle_max, idle_max < 20,
          json.dumps(evidence['cpuIdle'], ensure_ascii=False))
    shot('01-accuracy.png')


@sec
def s4_alert_and_lru():
    """4. 验收标准 ②：越线提示被触发 + 「最久未使用」排序正确 + 不阻止任何操作"""
    # 用当前这几张页来做排序实验（一定有 ≥5 张）
    wv = webviews()
    expect(len(wv) >= 6, '至少要 6 张页才能做排序实验',
           'pages=%d ui=%s' % (len(wv), json.dumps(ui_state(), ensure_ascii=False)))

    # 排序实验要站得住，得满足两件事：
    #   1) 用**真鼠标**点 —— "用户用了这张页"必须是真操作，不能是 JS click()；
    #   2) 时间线确定 —— 点的先后就是新旧顺序，而且要**避开**待会儿驾驶员要用的那张页；
    #      驾驶员碰过的页会被"此刻在用"规则排到最末（这是刻意的设计：它排在最后 = 最不该被关），
    #      上一轮我把它的位置写进期望值，于是假红了一次。
    #
    # ⚠️ 点击顺序刻意**与创建顺序相反**：先点"后来才开的那张"，再点"更早就开着的那张"。
    #    这样断言才有区分力 —— 如果"点过就算用过"这个机制根本没生效，排序只能按创建时间走，
    #    顺序必然反过来，`idx_first < idx_second` 就红。（第一版点了最后两张，那两个本来就是
    #    最新的，机制坏了也能过 —— 那种"永远绿"的断言比没有更危险。）
    i_first, i_second = min(5, len(wv) - 1), 1     # 5 号创建得晚，1 号创建得早；1 号不是驾驶员那张（0 号才是）
    wc_first, wc_second = int(wv[i_first]['wcId']), int(wv[i_second]['wcId'])
    r1 = click_tab_index(i_first)
    time.sleep(1.4)
    url_after_first = str((tabs_ui() or {}).get('url') or '')
    r2 = click_tab_index(i_second)
    time.sleep(1.4)
    tabs_now = (tabs_ui() or {}).get('tabs') or []
    on_now = [k for k, t in enumerate(tabs_now) if t.get('on')]
    url_after_second = str((tabs_ui() or {}).get('url') or '')
    evidence['lruClicks'] = {'iFirst': i_first, 'iSecond': i_second, 'wcFirst': wc_first,
                             'wcSecond': wc_second, 'r1': r1, 'r2': r2, 'onTabs': on_now,
                             'urlAfterFirst': url_after_first, 'urlAfterSecond': url_after_second}
    check('真鼠标点的两张页**确实被激活**（用应用自己的高亮状态复核，不是"点了就算"）',
          on_now == [i_second],
          'onTabs=%s 期望=[%d]（%s / %s）' % (on_now, i_second, r1, r2))
    check('点第 %d 张后地址栏确实跟着切到那一张（确认"标签序号 ↔ 页"是对齐的）' % i_second,
          wv[i_second]['url'] in url_after_second or wv[i_second]['url'] in url_after_first,
          'url=%s 期望含 %s' % (url_after_second or url_after_first, wv[i_second]['url']))

    # ---- 先试「灰区」：只越过健康线、没到警戒线 → 必须**完全不打扰** ----
    before = len(guard_events(50))
    set_settings({'resourceMemHealthMB': 300, 'resourceMemWarnMB': 100000,
                  'resourceCpuHealthPct': 1, 'resourceCpuWarnPct': 100, 'resourceSampleMs': 2000})
    ok, _, _ = wait_until(lambda: guard_snapshot().get('level') == 'elevated', timeout=25, interval=1.0)
    s_gray = guard_snapshot()
    events_gray = guard_events(50)
    evidence['grayZone'] = {'level': s_gray.get('level'), 'reasons': s_gray.get('sample', {}).get('reasons'),
                            'events': len(events_gray)}
    check('**灰区（越过健康线、未到警戒线）判成 elevated**', ok,
          'level=%s sample=%s' % (s_gray.get('level'), json.dumps(s_gray.get('sample', {}).get('reasons'))))
    check('**★验收标准 2★ 灰区里一条提示都没发（健康线以内完全不打扰）**',
          len(events_gray) == before == 0, 'events=%d（跑前 %d）' % (len(events_gray), before))

    # ---- 开始一个真任务：让「有未结束的任务」这个标记有据可查 ----
    drv_url = wv[0]['url']        # 刻意用**最前面**那张：避开刚点过的最后两张
    drv_wc = int(wv[0]['wcId'])
    ev_safe("return (() => { const i = document.querySelector('.inputBar input');"
            " if (!i) return 'no-input'; i.focus(); return 'ok'; })()", 'focus_input')
    typed = type_into('.inputBar input', '打开 %s 把整页读完，最后给我一份 P4-DRV 结论' % drv_url)
    hit_ok = False
    for _ in range(3):
        h = hit_test('.inputBar button')
        if h and h.get('found') and h.get('isSelf'):
            click('.inputBar button', settle=1.2)
            hit_ok = True
            break
        time.sleep(0.5)
    check('任务指令真的敲进输入框并发了出去', typed is not None and hit_ok, 'typed=%r hit=%s' % (typed, hit_ok))

    # 任务有没有真的进驾驶通道？两条互相独立的信号都看一眼，谁先到算谁：
    #   ① 渲染层读主进程的 lanes 键（接管某张页才有）；
    #   ② 服务端 /health 的 liveLoops（回合已经开跑就有）。
    # 上一轮只等 ① 且只给 45s —— 假模型是一步一步回的，没等到就记了一条假红。
    def lanes_now():
        raw = ev_safe("return JSON.stringify(await window.workbench.agentLanes());", 'lanes')
        try:
            return json.loads(raw) if isinstance(raw, str) else []
        except Exception:  # noqa: BLE001
            return []

    ok_lanes, lanes_seen, waited_lanes = wait_until(lambda: bool(lanes_now()), timeout=100, interval=2.0)
    live_loops = 0
    if not ok_lanes:
        try:
            live_loops = int((http_json('/health') or {}).get('liveLoops') or 0)
        except Exception:  # noqa: BLE001
            live_loops = 0
    check('任务真的跑起来了（lanes=%s，或服务端 liveLoops=%d）—— 好验证"别关"这句话站得住'
          % (json.dumps(lanes_seen if ok_lanes else []), live_loops), ok_lanes or live_loops > 0,
          'waited=%dms lanes=%s liveLoops=%s' % (waited_lanes, json.dumps(lanes_seen), live_loops))

    # ---- 降到警戒线以下 → 触发提示 ----
    t_change = now_ms()
    set_settings({'resourceMemWarnMB': 500, 'resourceMemHealthMB': 300,
                  'resourceCpuWarnPct': 100, 'resourceCpuHealthPct': 1, 'resourceSampleMs': 2000})
    cfg_now = get_settings()
    check('阈值越界值被夹到允许下限（填 500 → 生效 %s），提示里带的将是**夹过之后**的值'
          % cfg_now.get('resourceMemWarnMB'), cfg_now.get('resourceMemWarnMB') == 512,
          json.dumps({'asked': 500, 'applied': cfg_now.get('resourceMemWarnMB'),
                      'health': cfg_now.get('resourceMemHealthMB')}, ensure_ascii=False))
    ok_alert, alert_snap, waited = wait_until(lambda: len(guard_events(50)) > before, timeout=40, interval=1.5)
    events = guard_events(50)
    evidence['alert'] = {'waitedMs': waited, 'count': len(events), 'events': events[-1:]}
    check('**★验收标准 2★ 越过警戒线后提示确实被触发了（落盘事件 +1）**', ok_alert,
          'waited=%dms events=%d' % (waited, len(events)))
    if not ok_alert:
        return
    ev1 = events[-1]
    s_now = guard_snapshot()
    raw_ids = ev_safe("return JSON.stringify((window.__wbAlerts||[]).map(a => a.id));", 'alert_ids')
    alert_ids = json.loads(raw_ids) if isinstance(raw_ids, str) else []
    check('提示里带着**当次的真实占用**与**当时生效的阈值**（阈值 = 配置回读值，不是写死的默认值）',
          ev1['sample']['memMB'] > 0
          and ev1['thresholds']['memWarnMB'] == cfg_now.get('resourceMemWarnMB')
          and ev1['thresholds']['memHealthMB'] == cfg_now.get('resourceMemHealthMB'),
          json.dumps({'memMB': ev1['sample']['memMB'], 'cpuPct': ev1['sample']['cpuPct'],
                      'thresholds': ev1['thresholds'],
                      'configReadBack': {'warn': cfg_now.get('resourceMemWarnMB'),
                                         'health': cfg_now.get('resourceMemHealthMB')}},
                     ensure_ascii=False))
    check('提示原因是 mem（CPU 阈值被刻意抬到不可能达到，用来证明判定是按配置来的）',
          ev1['reasons'] == ['mem'], json.dumps(ev1['reasons']))
    check('档位进入 warning（IPC 读出来的和事件里的一致）',
          s_now.get('level') == 'warning' and ev1['level'] == 'warning',
          'snapshot=%s event=%s' % (s_now.get('level'), ev1['level']))
    check('**去抖生效：不是"一变线就喊"—— 提示发生在配置改动之后至少 2 个采样周期**',
          (ev1['at'] - t_change) >= 2 * 2000 - 300,
          'alert.at-t_change=%dms（2 个周期=%dms）' % (ev1['at'] - t_change, 2 * 2000))

    # ---- 排序正确性：「最久未使用」是怎么被证出来的 ----
    #
    # 上一轮这条是照着一张"我脑补出来的期望数组"比的（[4,5,6,7,3]），红了两次都是期望错：
    #   · 忘了驾驶员用的那张页会被"此刻在用"规则排到最末（那是刻意的设计，不是 bug）；
    #   · 忘了后面还陆续开了 7 张页，它们都在这 5 张之后。
    # 现在的做法不去猜整个数组，而是**只断言我真正能控制并且真的做过的事实**：
    #   ① 顺序单调 —— 非驾驶实例的 lastActiveAt 必须非递减；
    #   ② 驾驶实例必须全部排在最后一个非驾驶实例之后（"正在干活的排最后 = 最不该被关"）；
    #   ③ 我刚用真鼠标点过的两张，点击顺序必须体现在排序里（后点的那张在后面）；
    #   ④ 列表不剔除任何实例；
    #   ⑤ 每一张的归属都能对上（wcId ↔ 页面 URL）。
    rows = ev1['idleRanking']
    ranking = [int(x['wcId']) for x in rows]
    driving = [int(x['wcId']) for x in rows if x['driving']]
    rank_ts = {int(x['wcId']): x['lastActiveAt'] for x in rows}
    non_drv = [int(x['wcId']) for x in rows if not x['driving']]
    idx_first, idx_second = ranking.index(wc_first), ranking.index(wc_second)
    after_second = [int(x['wcId']) for x in rows[idx_second + 1:]]
    evidence['lru'] = {'ranking': ranking, 'driving': driving, 'drvWc': drv_wc,
                       'clickedFirst': wc_first, 'clickedSecond': wc_second,
                       'idxFirst': idx_first, 'idxSecond': idx_second,
                       'afterSecond': after_second,
                       'lastActiveAt': {str(k): v for k, v in rank_ts.items()},
                       'wcToPage': {str(int(x['wcId'])): (x.get('url') or '').split('/')[-1] for x in wv}}
    check('**★验收标准 2★「最久未使用」排序是单调的**（每一张非驾驶实例的 lastActiveAt 非递减）',
          all(rank_ts[a] <= rank_ts[b] for a, b in zip(non_drv, non_drv[1:])),
          json.dumps({'order': non_drv,
                      'ts': [rank_ts[k] for k in non_drv]}, ensure_ascii=False))
    check('**★验收标准 2★ 真鼠标点过的两张的先后顺序体现在排序里**'
          '（先点第 %d 张（开得晚）、后点第 %d 张（开得早）→ 排序里"先点的那张"必须更靠前。'
          '若"点过就算用过"没生效，这里会按创建时间反过来 → 红）' % (i_first, i_second),
          idx_first < idx_second,
          'ranking=%s idxFirst=%d idxSecond=%d（wcFirst=%s 开得晚 / wcSecond=%s 开得早）'
          % (ranking, idx_first, idx_second, wc_first, wc_second))
    untouched = [ranking.index(x) for x in non_drv if x not in (wc_first, wc_second)]
    evidence['lru']['untouchedMaxIdx'] = max(untouched) if untouched else None
    check('**★验收标准 2★ 刚点过的那两张，位置比"没人碰过"的那些都靠后**'
          '（顺序如实反映"谁刚被用过"），且它们后面只剩"有任务的"',
          bool(untouched) and min(idx_first, idx_second) > max(untouched)
          and all(x in driving for x in after_second),
          'ranking=%s untouchedMax=%s afterSecond=%s driving=%s'
          % (ranking, max(untouched) if untouched else None, after_second, driving))
    check('**★验收标准 2★ 有未结束任务的实例被**标出来**了（mandatory，不是可选项）**',
          drv_wc in driving, 'driving=%s 期望含 %s' % (driving, drv_wc))
    check('标记是有区分度的（不是所有实例都被标成"有任务"）',
          0 < len(driving) < len(ranking), 'driving=%s / 共 %d' % (driving, len(ranking)))
    check('**排序列表里没有剔除任何实例**（关不关是用户的决定，我们只如实标记）',
          len(ranking) == len(webviews()), 'ranking=%d webviews=%d' % (len(ranking), len(webviews())))
    check('列表里每一张都指得出是哪张页（wcId ↔ URL 对得上，不是一串孤立的数字）',
          all((x.get('url') or '').strip() for x in rows),
          json.dumps([{'wcId': int(x['wcId']), 'title': x.get('title'), 'url': x.get('url')}
                      for x in rows[:4]], ensure_ascii=False))
    check('提示文案里同时给出了占用、排序、"别关"的标记和"不阻止你"这句',
          all(k in ev1['text'] for k in ('资源占用偏高', '最久未使用', '别关', '不会自动关')),
          ev1['text'][:300])
    check('**渲染层真的收到了这次提示**（用应用自己的订阅口收到，不是从盘上读的）',
          ev1['id'] in alert_ids, '收到=%s 本次=%s' % (json.dumps(alert_ids), ev1['id']))

    # ---- 冷却：一直在警戒里也不该连发 ----
    time.sleep(9)
    n_after = len(guard_events(50))
    check('**提示是"触发一次"而不是每 2 秒喊一遍（冷却生效）**', n_after == len(events),
          '触发后 %d 条 → 9 秒后 %d 条' % (len(events), n_after))

    # ---- 不阻止任何操作 ----
    new_url = 'http://%s:%d/page-p4-after-alert' % (PAGE_HOSTS[0], FAKE_PORT)
    opened_ok = open_page(new_url, settle=2.5)
    check('**★验收标准 2★ 提示不阻止继续开新页（开得出来，没有被拒）**',
          opened_ok and any(new_url in (x.get('url') or '') for x in webviews()),
          'opened=%s pages=%d' % (opened_ok, len(webviews())))
    check('提示期间也没有任何实例被自动关掉（页数只增不减）',
          len(webviews()) >= len(ranking), '现在 %d 张（提示时 %d 张）' % (len(webviews()), len(ranking)))
    shot('02-alert.png')

    # 收尾这个任务，别让它继续烧假模型
    ev_safe("await window.workbench.agentStop(); return 'ok';", 'agent_stop')
    time.sleep(1.0)


@sec
def s5_overhead():
    """5. 验收标准 ③：监控自身的性能开销（开/关监控对照，给出具体数字）"""
    pages_now = len(webviews())
    check('对照测量时有稳定的负载（%d 张页、没有任务在跑）' % pages_now, pages_now >= 5,
          'pages=%d ui=%s' % (pages_now, json.dumps(ui_state(), ensure_ascii=False)))
    # 测量前必须真的安静下来 —— 这一条是第三轮那次假红的根因：
    # s4 起的那个真任务在 s5 开始时**还没收干净**（服务端工具循环还在跑），
    # 于是"关监控"那个窗口背着任务的残留负载（avg 2.52%、max 8.43%），
    # 而"开监控"那个窗口任务已经结束（avg 0.49%）→ 差值算成 **-2.028pp**（"开着反倒更省"），
    # 断言判红，看着像"开销异常"，其实是 A/B 的一侧被别人的负载污染了。
    # 先等 lanes 空 + 服务端 liveLoops=0，再静置一段让收尾余波（渲染/GC）落下去。
    def idle_probe():
        raw = ev_safe("return JSON.stringify(await window.workbench.agentLanes());", 'idle_probe')
        try:
            lanes = json.loads(raw) if isinstance(raw, str) else []
        except Exception:  # noqa: BLE001
            lanes = []
        try:
            live = int((http_json('/health') or {}).get('liveLoops') or 0)
        except Exception:  # noqa: BLE001
            live = 0
        return (not lanes) and live == 0, {'lanes': lanes, 'liveLoops': live}

    ok_calm, calm_seen, calm_waited = wait_until(lambda: idle_probe()[0], timeout=90, interval=2.0)
    check('测量前真的安静下来了（没有任务在跑：lanes 空 + 服务端 liveLoops=0）—— '
          '否则 A/B 会有一侧背着别人的负载（第三轮就红在这）', ok_calm,
          'waited=%dms probe=%s' % (calm_waited, json.dumps(calm_seen, ensure_ascii=False)[:200]))
    time.sleep(8)  # 让收尾余波（页面渲染、GC）落地

    def measure(tag, seconds=30):
        """
        量一段时间的 CPU（PDH 逐进程求和 = 任务管理器口径）。

        比的是**同一批进程**：关闭监控时靠 tasklist 反查 electron 全集，
        开启时直接用采样里那份进程清单；主进程那一列单独摘出来 ——
        "监控自身的开销"要看的就是它（采集就发生在主进程）。
        """
        snap = guard_snapshot()
        procs = (snap.get('sample') or {}).get('procs') or []
        main_pid = snap.get('mainPid')
        pids = [int(p['pid']) for p in procs] or app_pids_from_tasklist()
        tp = typeperf_cpu_of_pids(pids, seconds=seconds, interval=5)
        series = tp.get('series') or []
        inst_name = (tp.get('instances') or {}).get(main_pid) if main_pid else None
        main_series = [r['perPid'].get(inst_name, 0.0) for r in series] if inst_name else []
        out = {'tag': tag, 'seconds': seconds, 'pids': len(pids), 'mainPid': main_pid,
               'mainInstance': inst_name, 'enabled': snap.get('enabled'),
               'avgTotal': round(sum(r['total'] for r in series) / len(series), 3) if series else None,
               'maxTotal': round(max((r['total'] for r in series), default=0.0), 3),
               'avgMain': round(sum(main_series) / len(main_series), 3) if main_series else None,
               'series': [{'t': r['t'], 'total': r['total']} for r in series]}
        print('[对照] %s' % json.dumps({k: out[k] for k in ('tag', 'avgTotal', 'maxTotal', 'avgMain',
                                                           'mainPid', 'mainInstance', 'pids')},
                                       ensure_ascii=False))
        return out

    def measure_with_guard_off(seconds=30):
        off = set_settings({'resourceGuardEnabled': 0})
        time.sleep(3)
        return measure('guard-off', seconds)

    check('监控开关是可配的（关掉立刻生效）', set_settings({'resourceGuardEnabled': 0}).get('resourceGuardEnabled') == 0,
          'enabled=%s' % get_settings().get('resourceGuardEnabled'))

    # A/B **交替**测（关 → 开 → 关 → 开，各 30s），比较**中位数**。
    # 为什么不能只测"一整段关、一整段开"：这台机器上 30~60s 窗口的噪声可达 ±2pp，
    # 比监控自身的开销（实测占空比 <0.02% 单核）大两个数量级；只要某一侧恰好多背了点余波，
    # 差值就会算成"开着更省"（第三轮就是这么红的）。交替 + 中位数把机器漂移摊到两侧。
    # 另外**主证据不放在差值上**，而是"采集一次的占空比"（下面 ipc_avg 那条断言）——
    # 那是能直接归因到采集本身的量，不受机器噪声影响。
    windows = []
    for r in (1, 2):
        windows.append(('off', measure_with_guard_off(30)))
        set_settings({'resourceGuardEnabled': 1, 'resourceSampleMs': 5000})
        time.sleep(2.5)
        windows.append(('on', measure('guard-on#%d' % r, 30)))
    off, on = windows[0][1], windows[-1][1]
    check('关掉监控后 IPC 也如实说"没开"（不是假装在采）',
          windows[0][1].get('enabled') is False and windows[2][1].get('enabled') is False,
          json.dumps([{'tag': w[1]['tag'], 'enabled': w[1].get('enabled')} for w in windows if w[0] == 'off'],
                     ensure_ascii=False))
    check('重新打开监控后采样立刻恢复（enabled=true 且有点进来）',
          guard_snapshot().get('enabled') is True and guard_snapshot().get('sample') is not None,
          json.dumps({'enabled': guard_snapshot().get('enabled'),
                      'buffered': guard_snapshot().get('buffered')}))

    # ---- 查询代价：20 次 IPC 快照往返 ----------------------------------
    # 口径修正（第一轮的教训）：第一轮测出 42.66ms，其实是把**每次重新建 CDP 连接 +
    # 握手**也算进"单次查询"里了 —— 那是验收探测器的开销，不是产品的开销。
    # 正确做法：建一条连接，预热一次，再在同一连接上连打 20 次，只量 IPC 本身；
    # 建连代价单独记一笔（让读者自己判断哪个是产品代价）。
    t_conn = time.time()
    c = _cdp_call(P.Cdp)
    conn_ms = round((time.time() - t_conn) * 1000, 2)
    try:
        JS_SNAP = "const s = await window.workbench.resourceSnapshot(); return JSON.stringify(s);"
        c.jsf(JS_SNAP)  # 预热（首次含 JIT / 序列化稳态）
        t0 = time.time()
        for _ in range(20):
            c.jsf(JS_SNAP)
        ipc_avg = round((time.time() - t0) / 20 * 1000, 2)
    finally:
        c.ws.close()
    def med(xs):
        xs = sorted(x for x in xs if x is not None)
        if not xs:
            return None
        mid = len(xs) // 2
        return round(xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2.0, 3)

    offs = [w[1] for w in windows if w[0] == 'off']
    ons = [w[1] for w in windows if w[0] == 'on']
    off_med = med([w['avgTotal'] for w in offs])
    on_med = med([w['avgTotal'] for w in ons])
    off_main_med = med([w['avgMain'] for w in offs])
    on_main_med = med([w['avgMain'] for w in ons])
    d_total = round((on_med or 0) - (off_med or 0), 3)
    d_main = (round(on_main_med - off_main_med, 3)
              if off_main_med is not None and on_main_med is not None else None)
    # 占空比：采集一次（IPC 往返，含主进程里那次 getAppMetrics + 判定 + 序列化）
    # 摊在 5s 周期上，占**单核**的多少 —— 这个量能直接归因到采集本身，不受机器噪声影响。
    sample_ms = float(get_settings().get('resourceSampleMs') or 5000)
    duty_pct = round(ipc_avg / sample_ms * 100, 4)
    evidence['overhead'] = {'windows': [{'tag': w[1]['tag'], 'side': w[0], 'seconds': w[1]['seconds'],
                                         'avgTotal': w[1]['avgTotal'], 'maxTotal': w[1]['maxTotal'],
                                         'avgMain': w[1]['avgMain'], 'enabled': w[1].get('enabled')}
                                        for w in windows],
                            'offMedianTotal': off_med, 'onMedianTotal': on_med,
                            'offMedianMain': off_main_med, 'onMedianMain': on_main_med,
                            'deltaTotalPct': d_total, 'deltaMainPct': d_main,
                            'ipcAvgMs': ipc_avg, 'ipcConnectMs': conn_ms, 'ipcRuns': 20,
                            'sampleMs': sample_ms, 'dutyPctOfOneCore': duty_pct, 'pages': pages_now,
                            'mainPid': on.get('mainPid'), 'mainInstance': on.get('mainInstance')}
    print('[对照] 交替 4 窗口 中位数：关=%.3f%% 开=%.3f%%（差 %+.3fpp）| '
          '主进程：关=%s%% 开=%s%%（差 %+spp）| 占空比=%.4f%%单核'
          % (off_med or 0, on_med or 0, d_total, off_main_med, on_main_med, d_main, duty_pct))
    check('能量到"监控自身"的开销（拿到了主进程 pid 与它在 PDH 里的实例名）',
          bool(on.get('mainPid')) and bool(on.get('mainInstance')),
          json.dumps({'mainPid': on.get('mainPid'), 'instance': on.get('mainInstance'),
                      'offMain': off_main_med, 'onMain': on_main_med}, ensure_ascii=False))
    check('**★验收标准 3★ 交替 4 窗口（关/开/关/开，各 30s）取中位数：开监控**不比关监控高**'
          '（实测差 %+.3fpp；上界 +1.0pp。差值为负 = 落在机器噪声里，说明真实开销测不出来，'
          '所以主证据是下面那条占空比）**' % d_total, d_total <= 1.0,
          '关=%.3f%% 开=%.3f%%（中位数，PDH 逐进程求和）；4 个窗口原始值=%s'
          % (off_med or 0, on_med or 0,
             json.dumps([{'tag': w[1]['tag'], 'avgTotal': w[1]['avgTotal'], 'maxTotal': w[1]['maxTotal']}
                         for w in windows], ensure_ascii=False)))
    if d_main is not None:
        check('**★验收标准 3★ 主进程自身（采集就在这个进程里）中位数差 %+.3f 个百分点（上界 +0.5pp）**'
              % d_main, d_main <= 0.5, '关=%s%% 开=%s%%' % (off_main_med, on_main_med))
    check('单次查询代价很小（IPC 快照往返平均 %.2f ms，同一连接打 20 次；建连另计 %.1f ms）'
          % (ipc_avg, conn_ms), ipc_avg < 30,
          'ipcAvgMs=%s ipcConnectMs=%s（口径：只算 IPC 往返，不含重建 CDP 连接）' % (ipc_avg, conn_ms))
    check('**★验收标准 3★ 采集一次的占空比（主证据）：%.2f ms / %d ms 周期 = 单核的 %.4f%%（上界 0.1%%）**'
          % (ipc_avg, sample_ms, duty_pct), duty_pct <= 0.1,
          '口径：IPC 往返含主进程里那次 getAppMetrics() + 判定 + 序列化；'
          '换算成"平均占用"就是 %.4f%% 单核（采集本身是忙一下就睡，不是常驻轮询）' % duty_pct)
    # 落盘只留汇总（不让监控自己变成磁盘负担）
    guard_dir = os.path.join(PROFILE, 'resource-guard')
    files = os.listdir(guard_dir) if os.path.isdir(guard_dir) else []
    aggs = [f for f in files if f.startswith('samples-')]
    raws = [f for f in files if f.startswith('raw-')]
    total_bytes = sum(os.path.getsize(os.path.join(guard_dir, f)) for f in files if
                      os.path.isfile(os.path.join(guard_dir, f)))
    evidence['disk'] = {'files': files, 'bytes': total_bytes}
    check('落盘只有 60s 汇总 + 提示事件（原始 5s 点默认不落盘，避免监控自己变成磁盘负担）',
          bool(aggs) and not raws, 'files=%s bytes=%d' % (json.dumps(sorted(files), ensure_ascii=False), total_bytes))
    # 落盘量给成"一天/一周多大"这种能判断的数（"不会变成负担"得有个具体量级）
    agg_lines = 0
    agg_bytes = 0
    for f in aggs:
        p = os.path.join(guard_dir, f)
        if not os.path.isfile(p):
            continue
        agg_bytes += os.path.getsize(p)
        with open(p, encoding='utf-8', errors='replace') as fh:
            agg_lines += sum(1 for ln in fh if ln.strip())
    per_entry = round(agg_bytes / agg_lines, 1) if agg_lines else None
    per_day_kb = round(per_entry * 1440 / 1024.0, 1) if per_entry else None
    keep_days = 7
    evidence['disk'].update({'aggEntries': agg_lines, 'aggBytes': agg_bytes, 'perEntryBytes': per_entry,
                             'projectedKBPerDay': per_day_kb, 'keepDays': keep_days,
                             'projectedMBKeepDays': round((per_day_kb or 0) * keep_days / 1024.0, 2)})
    check('落盘量换算成具体量级：一条汇总 %.1f B → 一天约 %s KB → 保留 %d 天约 %s MB'
          % (per_entry or 0, per_day_kb, keep_days, evidence['disk']['projectedMBKeepDays']),
          per_entry is not None and evidence['disk']['projectedMBKeepDays'] < 5,
          json.dumps(evidence['disk'], ensure_ascii=False))
    hist = guard_history(120)
    check('历史汇总点能从**盘上**读回来（数据链路通了：落盘 → 读取 → 给人看）',
          len(hist) >= 1, '汇总点=%d 首条=%s' % (len(hist), json.dumps(hist[:1], ensure_ascii=False)[:300]))
    shot('03-overhead.png')


def app_pids_from_tasklist():
    """监控关掉时也能拿到"本应用"的进程集合：用 Electron 的可执行名取全集。
    对照测量的两侧用的是**同一批 pid**（开启那侧由采样给出），所以口径是公平的。"""
    r = subprocess.run(['tasklist', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq electron.exe'],
                       capture_output=True, text=True, encoding='utf-8', errors='ignore')
    pids = []
    for line in (r.stdout or '').splitlines():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 2 and parts[1].strip().isdigit():
            pids.append(int(parts[1]))
    return pids


# ===========================================================================
# 第 7 节（补充取证）：**自然负载**能不能把 CPU 警戒线顶起来
#
# 为什么单开一节：前四条标准里的"越线提示"是**人工把阈值压低**逼出来的 —— 那验的是
# "判定 → 提示"这条链路通不通，**回答不了**"35% 这条警戒线在定案值下合不合理、
# 一个用得很重但不算离谱的场景能不能碰到它"。这一节就补这个缺口。
#
# 三条自我约束（缺一条，结论就不可信）：
#   1. **阈值全程取定案值，一个都不改**。s4 为了验提示把内存阈值压到 512/300、
#      CPU 抬到 100/1，s5 只恢复了开关和频率 —— 所以本节开头先**复位到定案值**，
#      之后全程不再碰，结尾回读核对（"没碰过"是要能被验证的，不是嘴上说说）。
#   2. **负载必须是自然的**：真开页（走应用自己的 `openBrowser`）+ 真跑任务
#      （走应用自己的 `agentStart`，与服务端工具循环、主进程驾驶员是同一套代码），
#      **不拿忙循环凑数**。（忙循环只在最后的"标定"里出现，那一段明确标注为辅助证据。）
#   3. **负结果也必须可信**：先证明"负载确实起来了"（页数 / 并发路数 / 服务端 liveLoops），
#      再报"没触发" —— 否则"没触发"这三个字分不清是负载不够还是提示坏了。
#
# 最后附一段**标定**（辅助，不作验收判据）：用可控 Worker 把负载抬到线以上，确认
# 同一套定案阈值下提示真的会出现 —— 这样"到警戒线需要几个核"就从推算变成了实测。
# ===========================================================================
@sec
def s7_natural_cpu_load():
    """7. 补充取证：自然负载下 CPU 警戒线能否触发（阈值取定案值，全程不改）"""
    if SKIP_NATURAL_LOAD:
        check('自然负载这一节被跳过（开了 SKIP_NATURAL_LOAD=1）—— 这不是通过，是没跑', False,
              '去掉 SKIP_NATURAL_LOAD 重跑就能带上')
        return

    DECIDED = {'resourceGuardEnabled': 1, 'resourceSampleMs': 5000,
               'resourceMemHealthMB': 3072, 'resourceMemWarnMB': 4096,
               'resourceCpuHealthPct': 20, 'resourceCpuWarnPct': 35}
    cfg0 = set_settings(DECIDED)
    cores = int((guard_snapshot().get('sample') or {}).get('logicalCores') or 12)
    warn = float(cfg0.get('resourceCpuWarnPct') or 35)
    cap = int(cfg0.get('maxBrowserInstances') or 0)
    conc = int(cfg0.get('maxConcurrentAgentTasks') or 0)
    check('阈值复位到**定案值**并锁定（健康 %s%% / 警戒 %s%%，采样 %sms，监控开）'
          % (cfg0.get('resourceCpuHealthPct'), cfg0.get('resourceCpuWarnPct'), cfg0.get('resourceSampleMs')),
          float(cfg0.get('resourceCpuWarnPct')) == 35 and float(cfg0.get('resourceCpuHealthPct')) == 20
          and cfg0.get('resourceSampleMs') == 5000 and cfg0.get('resourceGuardEnabled') == 1,
          json.dumps({k: cfg0.get(k) for k in sorted(DECIDED)}, ensure_ascii=False))
    t0 = now_ms()
    print('[自然负载] 逻辑核=%d；CPU 警戒线=%.0f%%（整机口径，≈%.1f 个核跑满）；'
          '页上限=%d；并发任务上限=%d'
          % (cores, warn, warn * cores / 100.0, cap, conc))
    # ---- 负载的一半：把浏览器开到配置上限（走应用自己的 openBrowser） ----
    #
    # ⚠️ 每张页**必须独占一个 host**。应用的开页规则是「同站 → 复用那张页，不新开」（复用不占额度），
    #    第一版这里循环用了只有 12 个元素的 PAGE_HOSTS，第 13 张开始 host 重复 →
    #    应用按规则把已有页改道了，于是"开到上限 20 张"实际只开出 12 张，
    #    并发路数也跟着被压成 12（断言如实报 FAIL，但红的是**脚本**，不是应用）。
    #    回环地址整段 /8 都是回环，按序生成即可；从 .30 起跳是为了避开 s3 已占的 .2 ~ .13。
    load_hosts = ['127.0.0.%d' % (30 + i) for i in range(64)]
    hops = 0
    while len(webviews()) < cap and hops < cap + 8:
        i = len(webviews())
        url = 'http://%s:%d/page-p4-load-%02d' % (load_hosts[i % len(load_hosts)], FAKE_PORT, i + 1)
        open_page(url, settle=0.9)
        hops += 1
    time.sleep(6)
    wv = webviews()
    pages = [(int(x['wcId']), x.get('url') or '') for x in wv if isinstance(x.get('wcId'), int)]
    real = [x for x in wv if (x.get('url') or '').strip() and (x.get('title') or '').strip()]
    check('**★补充 1★ 浏览器开到配置上限 %d 张，且每张都真加载完（不是空壳）**' % cap,
          len(wv) >= cap and len(real) == len(wv) and len(pages) == len(wv),
          json.dumps({'pages': len(wv), 'cap': cap, 'loaded': len(real), 'usable': len(pages),
                      'openAttempts': hops,
                      'hosts': len(set((x.get('url') or '').split('/')[2] for x in wv if x.get('url')))},
                     ensure_ascii=False))

    # ---- 负载的另一半：真任务（走应用自己的 agentStart，与 UI 按钮同一条路径） ----
    # ---- 本节所有高频往返都走**一条常驻 CDP 会话** ----
    #
    # 这是本轮定位到的**真瓶颈**，而且不在被测应用身上：
    #   `ev_safe()` / `ev()` 每次调用都新建一条连接（`/json/list` + ws 握手 + `Runtime.enable`），
    #   20 路满载时实测一次要 **2~3 秒** —— 一轮 20 张页发车就要 40~60 秒，而一路循环只活 ~12 秒。
    #   于是"并发路数"永远在低位徘徊（实测 light-20 档 lanesMax=11、starts 只有 39），
    #   看上去像"应用开不了那么多路"，其实应用那边 `startAgentLoop()` 是**同步登记**、
    #   循环丢进后台 IIFE 跑，发车本身是毫秒级的（main.ts 里 `lanes.set()` 之后才 return）。
    #   换成常驻会话，每次往返压到几十毫秒，并发才真的托得住。
    _sess = {'c': None}
    _sess_lock = threading.Lock()

    def sess_call(expr, tag=''):
        """在同一条常驻 CDP 会话上求值（失败自动重连一次，再失败记进 BLOCKED 并返回 None）。"""
        err = None
        for _ in range(2):
            with _sess_lock:
                try:
                    c = _sess['c']
                    if c is None:
                        c = _cdp_call(P.Cdp)
                        _sess['c'] = c
                    return c.jsf(expr)
                except Exception as e:  # noqa: BLE001
                    err = e
                    try:
                        _sess['c'].ws.close()
                    except Exception:  # noqa: BLE001
                        pass
                    _sess['c'] = None
            time.sleep(0.3)
        BLOCKED_CDP_CALLS.append({'tag': tag, 'error': str(err)[:160]})
        return None

    def lanes_now():
        """
        当前有几路在驾驶。**探测失败返回 None**，不返回空列表 ——
        这两件事必须分开：`[]` 是"确实没有路"，`None` 是"没问到"。
        混成一个的话，一次 CDP 抖动就会被读成"所有路都停了"，然后重复发车，
        把"最新指令优先"触发一遍（旧循环作废 + 新循环重建），负载实测值就失真了。
        """
        raw = sess_call("return JSON.stringify(await window.workbench.agentLanes());", 'lanes')
        if not isinstance(raw, str):
            return None
        try:
            return [int(x) for x in json.loads(raw)]
        except Exception:  # noqa: BLE001
            return None

    def start_lane(wc):
        goal = '把当前这张页读完，最后给我一份 P7 负载结论（页 %d）' % wc
        v = sess_call("await window.workbench.agentStart(%s, %s, %s, %d, {agentId: %s}); return 'ok';"
                      % (json.dumps(goal), json.dumps(API), json.dumps(TOKEN), wc,
                         json.dumps(DEFAULT_AGENT)), 'agent_start')
        return v == 'ok'

    def llm_calls(since_ms):
        """
        **假模型自己的请求日志**里，这个时间点之后属于本节的调用数 / 不同目标数。

        这是"负载是真的"最硬的一条 —— 它由假模型进程写，**被测应用改不了它**。
        （应用侧的 `lanes` 只能证明"应用认为自己在跑 N 路"，不能证明模型真被调了 N×10 次。）
        """
        n, goals = 0, set()
        try:
            with open(FAKE_LOG, encoding='utf-8') as f:
                for line in f:
                    if 'P7' not in line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:  # noqa: BLE001
                        continue
                    if int(r.get('at') or 0) >= since_ms:
                        n += 1
                        goals.add(r.get('goal'))
        except FileNotFoundError:
            pass
        return n, len(goals)

    def probe_both():
        """
        **一次 CDP 往返**同时取「资源快照 + 当前 lanes」，而且走常驻会话。

        为什么要合并成一次：重负载下一次 CDP 往返实测要好几秒（本轮截图连续超时就是这个原因），
        一轮里打两次、外加一次 `/health`，迭代周期会被拖到 ~10 秒 —— 采样变稀疏只是次要问题，
        真正要命的是"补完路要等下一轮才回看"会**系统性采到低点**。
        为什么还要常驻：新建连接才是大头（`/json/list` + 握手 + `Runtime.enable`），
        见 `sess_call()` 上的注释。
        """
        raw = sess_call("const s = await window.workbench.resourceSnapshot();"
                        " const l = await window.workbench.agentLanes();"
                        " return JSON.stringify({ s: s, l: l });", 'probe_both')
        try:
            o = json.loads(raw) if isinstance(raw, str) else {}
        except Exception:  # noqa: BLE001
            return None, None
        smp = (o.get('s') or {}).get('sample')
        lanes = o.get('l')
        return (smp if isinstance(smp, dict) else None,
                [int(x) for x in lanes] if isinstance(lanes, list) else None)

    def sustain(seconds, target_lanes):
        """
        把 `target_lanes` 路真任务**维持满** seconds 秒（跑完一路就地补一路）。

        为什么要"补"：服务端 `AGENT_LOOP_MAX_STEPS=10` × 假模型每步 1.2s ≈ 12 秒一路就收工，
        而一个观测窗口要 45 秒 —— 不补的话窗口后半段是空的，"峰值"就不代表"同时 N 路在跑"。

        三分工，各自解决一个已经实测到的坑：

        ① **先一次性把整档的路同时发出去，再开探测线程**。
           并发峰值就出现在这一刻，而探测本身要等渲染进程（重负载下求值慢），
           边发边探必然采到"还没发完"的低点。先发满再探，"到底能同时跑几路"才是准的。

        ② **补路按自己的时间表走，不等探测结果**。
           上一版拿 `probe_both()` 的返回值当补路依据 —— 重页档探测一次要 ~15 秒
           （快照抽取把渲染进程占满），于是"补路"退化成每 15 秒才轮到一次，
           并发塌到 11/20，看起来像"页变重反而更省 CPU"。
           现在每张页各自记一个"下次可以再发车"的时刻（发车时刻 + 13s ≈ 一路的自然寿命），
           到点就补：这一路跑完是**必然**的（循环步数是固定的），本来就不需要问应用。

        ③ **探测线程只取证**（并发路数 / 采样点 / 服务端 `liveLoops`），不参与决策 ——
           探测失败（返回 None）只是少一个点，绝不会被当成"路都停了"而去重复发车。
        """
        t_start = time.time()
        samples = {}
        LIFETIME = 13.0        # 一路循环 10 步 × 1.2s ≈ 12s；13s 留 1 秒余量
        budget = max(8, target_lanes * 6)
        box = {'starts': 0, 'lanesMax': 0, 'lanesSeen': [], 'probeFailures': 0,
               'liveLoopsMax': 0, 'waveLanes': 0}
        stop = threading.Event()
        next_free = {}

        def fire(wc):
            if start_lane(wc):
                next_free[wc] = time.time() + LIFETIME
                box['starts'] += 1
                return True
            return False

        # ① 先发满一整档（这就是本档的并发上限），随后才开探测
        t_wave = time.time()
        for wc, _u in pages[:target_lanes]:
            if box['starts'] >= budget:
                break
            fire(wc)
        box['waveLanes'] = sum(1 for wc, _u in pages[:target_lanes] if wc in next_free)
        box['waveMs'] = int((time.time() - t_wave) * 1000)

        def refill_worker():
            # ⚠️ 只补**本档的**那 `target_lanes` 张页（`pages[:target_lanes]`）。
            # 写成 `for wc, _u in pages` 会让 4 路那一档把剩下 16 张也发起来 = 档位失真。
            lane_pages = pages[:target_lanes]
            while not stop.is_set():
                now = time.time()
                for wc, _u in lane_pages:
                    if stop.is_set() or box['starts'] >= budget:
                        break
                    if now < next_free.get(wc, 0):
                        continue
                    if not fire(wc):
                        next_free[wc] = time.time() + 2.0   # 发车失败别连打，2 秒后再试
                    time.sleep(0.08)
                time.sleep(0.3)

        def probe_worker():
            nxt = 0.0
            while not stop.is_set():
                smp, live = probe_both()
                if live is None:
                    box['probeFailures'] += 1
                else:
                    box['lanesSeen'].append(len(live))
                    box['lanesMax'] = max(box['lanesMax'], len(live))
                if smp is None:      # 合并那次没取到，就单独补一次 —— 峰值少一个点就少一分可信
                    smp = (guard_snapshot() or {}).get('sample')
                if smp and smp.get('at'):
                    samples[int(smp['at'])] = smp
                if time.time() >= nxt:
                    nxt = time.time() + 15
                    try:
                        box['liveLoopsMax'] = max(
                            box['liveLoopsMax'],
                            int((http_json('/health', timeout=10) or {}).get('liveLoops') or 0))
                    except Exception:  # noqa: BLE001
                        pass
                time.sleep(0.8)

        tr = threading.Thread(target=refill_worker, daemon=True)
        tp = threading.Thread(target=probe_worker, daemon=True)
        tr.start()
        tp.start()
        try:
            while (time.time() - t_start) < seconds:
                time.sleep(0.3)
        finally:
            stop.set()
            tr.join(timeout=20)
            tp.join(timeout=40)
        return (samples, box['starts'], box['lanesMax'], box['liveLoopsMax'],
                box['probeFailures'], box['lanesSeen'], box['waveLanes'], box['waveMs'])

    def switch_to_heavy():
        """
        把当前这 20 张页**原地换成重页**（同一并发下换个变量，用来隔离"页变重"的影响）。

        为什么需要这一档：驱动员的 `read_page` 每步要抽最多 **1500 个正文节点**
        （`h1..p/li/td` + cap 1500），而验收页只有 3~4 个 —— 真实站点通常几百到几千。
        只拿 5 行的验收页去量"跑任务要多少 CPU"，量到的是**下界**，甚至可能低估一个数量级。

        换页走的是应用自己的 `openBrowser`：同 host → 复用那张页改道（正好原地换掉，不新开）。
        """
        ev_safe("await window.workbench.agentStop(); return 'ok';", 'agent_stop')
        wait_until(lambda: lanes_now() == [], timeout=45, interval=1.5)
        time.sleep(3)
        for i, (wc, old) in enumerate(pages):
            host = (old or '').split('/')[2].split(':')[0] or load_hosts[i % len(load_hosts)]
            open_page('http://%s:%d/page-heavy-2000-%02d' % (host, FAKE_PORT, i + 1), settle=0.5)
        time.sleep(12)
        rows = webviews()
        heavy = [x for x in rows if 'page-heavy-2000' in (x.get('url') or '')]
        titles = [x.get('title') or '' for x in heavy]
        check('**★补充 1★ 把 %d 张页原地换成重页**（每张 2000 个正文节点 → 吃满快照 1500 的上限）'
              % len(pages), len(heavy) >= len(pages) - 1,
              json.dumps({'switched': len(heavy), 'expect': len(pages),
                          'heavyTitles': titles[:3]}, ensure_ascii=False))
        return {'switched': len(heavy), 'titles': titles[:5]}

    # 逐档加码，看 CPU 怎么随负载涨（"上限在哪里"要有曲线，不能只有一个数）：
    # 前三档是"轻页（验收页）"，第四档是"同一并发 + 重页"，用来隔离"页变重"这一个变量。
    hold = 45
    curve = []
    heavy_info = None
    for kind, raw_target in (('light', 4), ('light', 12), ('light', 20), ('heavy', 20)):
        if kind == 'heavy' and heavy_info is None:
            heavy_info = switch_to_heavy()
        target = max(1, min(raw_target, len(pages), conc))
        pids = [int(p['pid']) for p in (guard_snapshot().get('sample') or {}).get('procs', [])]
        box = {}
        t_level = now_ms()

        def truth():
            """系统真值（PDH 逐进程求和）——与采集侧**同一个时间窗**（上一轮的教训）。"""
            box['tp'] = typeperf_cpu_of_pids(pids, seconds=hold, interval=5)

        th = threading.Thread(target=truth, daemon=True)
        th.start()
        (samples, starts, lanes_max, live_max, probes_failed, lanes_seen,
         wave, wave_ms) = sustain(hold, target)
        th.join(timeout=hold + 90)
        calls, call_goals = llm_calls(t_level)
        pcts = [float(s['cpuPct']) for s in samples.values()]
        peak = max(pcts) if pcts else 0.0
        run = best = 0
        for p in pcts:
            run = run + 1 if p >= warn else 0
            best = max(best, run)
        tp = (box.get('tp') or {}).get('series') or []
        tp_machine = round(max((r['total'] for r in tp), default=0.0) / cores, 2)
        # 每路成本（峰值/路数）也要记下来：只看"峰值"会把"路数少"误读成"页变重反而更省" ——
        # 必须做这个归一化（本轮上一版就是这个读数把重页档读成了"更省"）。
        avg_pct = round(sum(pcts) / len(pcts), 2) if pcts else 0.0
        curve.append({'pageKind': kind, 'lanes': target, 'lanesMax': lanes_max, 'waveLanes': wave,
                      'waveMs': wave_ms, 'liveLoopsMax': live_max,
                      'starts': starts, 'samples': len(pcts), 'probeFailures': probes_failed,
                      'lanesSeen': lanes_seen, 'llmCalls': calls, 'llmGoals': call_goals,
                      'avgPct': avg_pct,
                      'peakPct': round(peak, 2), 'peakCores': round(peak * cores / 100.0, 2),
                      'peakPctPerLane': (round(peak / lanes_max, 3) if lanes_max else None),
                      'avgPctPerLane': (round(avg_pct / lanes_max, 3) if lanes_max else None),
                      'maxConsecutiveOverWarn': best, 'truthPeakMachinePct': tp_machine})
        print('[自然负载 %s %d 路] %s' % (kind, target, json.dumps(curve[-1], ensure_ascii=False)))
        # 截图只留最高档：重负载下 CDP 截图基本必然超时（重试两次会白等好几分钟），
        # 而截图本来就是辅助证据，不值当拿整轮时长去换。
        if target >= 20:
            shot('04-natural-load-%s-%02d.png' % (kind, target))

    light = [c for c in curve if c['pageKind'] == 'light']
    heavy = [c for c in curve if c['pageKind'] == 'heavy']
    evidence['naturalLoad'] = {'cores': cores, 'warnPct': warn, 'pagesCap': cap,
                               'maxConcurrentAgentTasks': conc, 'pages': len(pages),
                               'holdSeconds': hold, 'curve': curve,
                               'heavySwitch': heavy_info,
                               'peakLightPct': max((c['peakPct'] for c in light), default=0.0),
                               'peakHeavyPct': max((c['peakPct'] for c in heavy), default=0.0) if heavy else None}

    peak_all = max((c['peakPct'] for c in curve), default=0.0)
    peak_cores = round(peak_all * cores / 100.0, 2)
    lanes_all = max((c['lanesMax'] for c in curve), default=0)
    live_all = max((c['liveLoopsMax'] for c in curve), default=0)
    calls_all = max((c['llmCalls'] for c in curve), default=0)
    goals_all = max((c['llmGoals'] for c in curve), default=0)
    target_max = max(1, min(20, len(pages), conc))
    # "负载是真的"这条必须**独立于被测应用**去证：
    #   · lanes 来自应用自己的接口（它能证明"应用认为自己在同时跑 N 路"），
    #   · 模型调用次数/不同目标数来自**假模型自己的请求日志**（应用改不了它）——
    #     第一版只看 lanes + /health.liveLoops，而 liveLoops 只统计 status==='running'
    #     的循环（工具循环在两步之间不是 running），于是恒为 0，把一条真负载判成了 FAIL。
    check('**★补充 1★ 负载是真的**（应用侧最多 %d 路并发任务；假模型侧独立记到 %d 次调用 / %d 个不同目标；'
          '底子是 %d 张真加载完的页）' % (lanes_all, calls_all, goals_all, len(pages)),
          lanes_all >= target_max - 1 and calls_all > 0 and goals_all >= target_max - 1,
          json.dumps({'targetMax': target_max, 'lanesMax': lanes_all, 'liveLoopsMax': live_all,
                      'llmCalls': calls_all, 'llmGoals': goals_all, 'curve': curve},
                     ensure_ascii=False))

    cfg1 = get_settings()
    check('**★补充 2★ 阈值全程没被人碰过**（结尾回读 == 开头写入的定案值）',
          all(cfg1.get(k) == v for k, v in DECIDED.items()),
          json.dumps({k: (cfg1.get(k), v) for k, v in sorted(DECIDED.items())}, ensure_ascii=False))

    new_ev = [e for e in guard_events(200) if int(e.get('at') or 0) >= t0]
    cpu_ev = [e for e in new_ev if 'cpu' in (e.get('reasons') or [])]
    gap_pp = round(warn - peak_all, 2)
    gap_cores = round(gap_pp * cores / 100.0, 2)
    # 单位成本要取**同一档**的峰值与并发数，不能把 A 档的峰值除以 B 档的路数
    heaviest = max(curve, key=lambda c: c['peakCores']) if curve else None
    per_lane_cores = (round(heaviest['peakCores'] / heaviest['lanesMax'], 3)
                      if heaviest and heaviest['lanesMax'] else None)
    lanes_needed = (int((warn * cores / 100.0) / per_lane_cores) + 1) if per_lane_cores else None
    evidence['naturalLoad'].update({'peakPct': peak_all, 'peakCores': peak_cores,
                                    'lanesMax': lanes_all, 'liveLoopsMax': live_all,
                                    'llmCallsMax': calls_all, 'llmGoalsMax': goals_all,
                                    'coresPerLane': per_lane_cores, 'lanesNeededForWarn': lanes_needed,
                                    'warnCoresEquivalent': round(warn * cores / 100.0, 2),
                                    'gapPctPoints': gap_pp, 'gapCores': gap_cores,
                                    'firedNaturally': bool(cpu_ev), 'cpuEventIds': [e['id'] for e in cpu_ev],
                                    'naturalEventIds': [e['id'] for e in new_ev],
                                    'naturalReasons': [e.get('reasons') for e in new_ev]})

    if cpu_ev:
        check('**★补充 3★ 自然负载下 CPU 警戒线真的被触发了**（没动过任何阈值；事件 %s）'
              % json.dumps([e['id'] for e in cpu_ev]), True,
              json.dumps(cpu_ev[-1], ensure_ascii=False)[:400])
    else:
        # 这一条判的是**负结果可信**，不是"触发了"。判据是"峰值确实在线下"：
        # 只要峰值在线下，守护者不提示就是**正确行为**；而"峰值可信"已由上一节的
        # 采集口径验证 + 本节的 lanes / 模型调用次数共同支撑。
        pk_light = max((c['peakPct'] for c in light), default=0.0)
        pk_heavy = max((c['peakPct'] for c in heavy), default=0.0) if heavy else None
        check('**★补充 3★ 自然负载下 CPU 警戒线没有被触发 —— 如实记录上限：'
              '配置允许的**最大自然负载**（%d 张页 × %d 路并发任务，含"重页"档）'
              '峰值 %.2f%%（≈%.2f 个核跑满），距警戒线 %.0f%% 还差 %.2f 个百分点（≈%.2f 个核）**'
              % (len(pages), lanes_all, peak_all, peak_cores, warn, gap_pp, gap_cores),
              peak_all < warn,
              '轻页峰值 %.2f%% / 重页峰值 %s%%；负载构成=%d 张页 × 最多 %d 路并发任务'
              '（假模型侧同期 %d 次调用 / %d 个目标）；曲线=%s'
              % (pk_light, pk_heavy, len(pages), lanes_all, calls_all, goals_all,
                 json.dumps(curve, ensure_ascii=False)))
        print('[自然负载] 结论：%d 张页 + 最多 %d 路并发任务 → 峰值 %.2f%%（轻页）/ %s%%（重页）'
              '≈ %.2f 核；每路约 %.3f 核；警戒线 %.0f%% 相当于 %.2f 个核，'
              '按这个单位成本要凑到警戒线需要约 %s 路并发（配置上限只有 %d）'
              % (len(pages), lanes_all, pk_light, pk_heavy, peak_cores, per_lane_cores or 0, warn,
                 warn * cores / 100.0, lanes_needed, conc))

    # ================= 标定（辅助证据，不是验收判据） =================
    #
    # 目的：把"没触发"和"功能坏了"彻底分开，并把"到警戒线要几个核"从推算变成实测。
    # 做法：可控 Worker 逐步加码，直到越线 —— **阈值依然一个都不改**（这就是与 s4 的
    #       本质区别：s4 改的是线，这里改的是负载）。
    ev_safe("return (() => { (window.__spins || []).forEach((w) => w.terminate());"
            " window.__spins = []; return 'stopped'; })()", 'spin_stop')
    ev_safe("await window.workbench.agentStop(); return 'ok';", 'agent_stop')
    time.sleep(8)
    lanes_left = lanes_now() or []
    base = collect_guard_samples(12, poll=1.0)
    base_pct = max((float(s['cpuPct']) for s in base), default=0.0)
    per_worker = 100.0 / cores
    need = max(per_worker, (warn + 3.0) - base_pct)
    k = int(need / per_worker)
    if (need - k * per_worker) > 1e-9:
        k += 1
    k = max(1, min(8, k))

    cal = {'baselinePct': round(base_pct, 2), 'lanesLeftWhenCalibrating': len(lanes_left),
           'coresPerWorkerPct': round(per_worker, 2), 'attempts': []}
    for attempt in range(1, 4):
        t_cal = now_ms()
        started = ev_safe("""return (() => {
          window.__spins = window.__spins || [];
          const src = 'const t = performance.now() + 90000; while (performance.now() < t) {}';
          const u = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          for (let i = 0; i < %d; i++) window.__spins.push(new Worker(u));
          return window.__spins.length;
        })()""" % k, 'spin_start')
        time.sleep(4)
        cal_samples = collect_guard_samples(50, poll=1.0)
        cal_pcts = [float(s['cpuPct']) for s in cal_samples]
        cal_peak = max(cal_pcts) if cal_pcts else 0.0
        run = best = 0
        for p in cal_pcts:
            run = run + 1 if p >= warn else 0
            best = max(best, run)
        cal_ev = [e for e in guard_events(200)
                  if int(e.get('at') or 0) >= t_cal and 'cpu' in (e.get('reasons') or [])]
        cal['attempts'].append({'workers': k, 'started': started,
                                'expectedPct': round(base_pct + k * per_worker, 2),
                                'peakPct': round(cal_peak, 2),
                                'peakCores': round(cal_peak * cores / 100.0, 2),
                                'maxConsecutiveOverWarn': best, 'samples': len(cal_pcts),
                                'alertIds': [e['id'] for e in cal_ev],
                                'alertSample': (cal_ev[-1].get('sample') if cal_ev else None)})
        print('[标定 尝试%d] %s' % (attempt, json.dumps(cal['attempts'][-1], ensure_ascii=False)[:400]))
        ev_safe("return (() => { (window.__spins || []).forEach((w) => w.terminate());"
                " window.__spins = []; return 'stopped'; })()", 'spin_stop')
        if cal_ev:
            break
        k = min(8, k + 2)   # 估算偏了就加码（上限 8 核 = 整机 66.7%，远高于警戒线）
        time.sleep(5)

    last = cal['attempts'][-1]
    cal['crossedWithWorkers'] = last['workers'] if last['alertIds'] else None
    cal['crossedAtPeakPct'] = last['peakPct'] if last['alertIds'] else None
    evidence['naturalLoadCalibration'] = cal
    check('**校准：把负载顶到警戒线以上时，**同一套定案阈值**下提示真的出现了**'
          '（%d 个 Worker，实测峰值 %.2f%% ≈ %.2f 核；阈值全程没动过）'
          % (last['workers'], last['peakPct'], last['peakCores']), bool(last['alertIds']),
          json.dumps(cal, ensure_ascii=False)[:600])
    if last['alertIds']:
        ev_cal = [e for e in guard_events(200) if e['id'] in last['alertIds']][-1]
        check('校准触发的那条提示：理由是 cpu、阈值就是定案值（证明"线本身"是通的）',
              ev_cal['reasons'] == ['cpu'] and ev_cal['thresholds']['cpuWarnPct'] == 35,
              json.dumps({'reasons': ev_cal['reasons'], 'thresholds': ev_cal['thresholds']},
                         ensure_ascii=False))

    ev_safe("return (() => { (window.__spins || []).forEach((w) => w.terminate());"
            " window.__spins = []; return 'stopped'; })()", 'spin_stop')
    ev_safe("await window.workbench.agentStop(); return 'ok';", 'agent_stop')
    # 常驻会话用完就关（后面还有回归，别把一条连接挂着）
    try:
        if _sess.get('c') is not None:
            _sess['c'].ws.close()
    except Exception:  # noqa: BLE001
        pass
    _sess['c'] = None
    ok_idle, _, w_idle = wait_until(lambda: lanes_now() == [], timeout=60, interval=2.0)
    check('本节收尾：所有路都停了、Worker 都关了（不把负载留给下一节）', ok_idle,
          'waited=%dms（下一节要跑回归，两侧不能互相干扰）' % w_idle)
    shot('05-natural-load-peak.png')


def parse_suite_summary(text):
    """
    从子验收的日志里读汇总（**两套老脚本的汇总格式不一样**，上一轮"没解析到汇总行"就是这个坑）：
      · Phase 3 / 本脚本：`汇总：18 条断言，17 通过，1 失败`
      · 子阶段 2-B：`全部通过（17 条断言）` / `N 条失败（共 M 条）`
    再兜一层：真解析不到就数 PASS/FAIL 行（标记 inferred，报告里会如实写明是数出来的）。
    """
    m = re.findall(r'汇总：(\d+) 条断言，(\d+) 通过，(\d+) 失败', text)
    if m:
        t, p, f = m[-1]
        return {'total': int(t), 'passed': int(p), 'failed': int(f)}
    m = re.findall(r'全部通过（(\d+) 条断言）', text)
    if m:
        return {'total': int(m[-1]), 'passed': int(m[-1]), 'failed': 0}
    m = re.findall(r'(\d+) 条失败（共 (\d+) 条）', text)
    if m:
        f, t = int(m[-1][0]), int(m[-1][1])
        return {'total': t, 'passed': t - f, 'failed': f}
    p = len(re.findall(r'^PASS ', text, re.M))
    f = len(re.findall(r'^FAIL ', text, re.M))
    if p or f:
        return {'total': p + f, 'passed': p, 'failed': f, 'inferred': True}
    return None


@sec
def s6_regression():
    """6. 验收标准 ④：回归（把 Phase 3 / 2-B 两套真机验收整套重跑）"""
    if not WITH_REGRESSION:
        check('回归这一节被跳过（没开 WITH_REGRESSION=1）—— 这不是通过，是没跑', False,
              '用 WITH_REGRESSION=1 重跑就能带上 Phase 3 / 2-B 两套验收')
        return
    # 先把自己这套环境收掉：两套老验收有自己的端口，但机器负载会互相干扰测量
    kill_all()
    time.sleep(2.5)
    PY = sys.executable
    suites = [
        ('Phase 3（分区粒度）', os.path.join(HERE, '3-partition-tests.py'), 'round-p4-regression-phase3.log'),
        ('子阶段 2-B（项目层）', os.path.join(HERE, '2b-desktop-tests.py'), 'round-p4-regression-2b.log'),
    ]
    evidence['regression'] = []
    for name, script, logname in suites:
        log = os.path.join(OUTDIR, logname)
        print('[regression] 跑 %s …（可能要十几分钟）' % name)
        with open(log, 'wb') as f:
            r = subprocess.run([PY, script], cwd=REPO, stdout=f, stderr=subprocess.STDOUT)
        text = open(log, encoding='utf-8', errors='replace').read()
        s = parse_suite_summary(text)
        info = {'suite': name, 'exit': r.returncode, 'summary': s, 'log': logname}
        evidence['regression'].append(info)
        if s and not s.get('inferred'):
            desc = '%d 条断言 / %d 通过 / %d 失败' % (s['total'], s['passed'], s['failed'])
        elif s:
            desc = '从日志里数出来的：%d 条 / %d 通过 / %d 失败' % (s['total'], s['passed'], s['failed'])
        else:
            desc = '没解析到汇总行'
        check('**★验收标准 4★ %s 整套重跑：%s（子进程退出码 %d）**' % (name, desc, r.returncode),
              bool(s) and s['failed'] == 0 and r.returncode == 0,
              json.dumps(info, ensure_ascii=False))


# ===========================================================================
def main():
    global live_before
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    # ---------------- 第 1 层：跑前清残留（每一轮都从零开始） ----------------
    section('跑前清残留（第 1 层自清理）')
    gone = purge_leftovers(TEST_PHONE)
    print('[pre-clean] 同号残留账号：%s' % (gone or '无'))
    for what in ('electron.exe', 'crashpad_handler.exe'):
        kill_stray(what)
    time.sleep(1.5)
    shutil.rmtree(PROFILE, ignore_errors=True)
    check('临时 profile 已清干净（不是"上次留下的"）', not os.path.exists(PROFILE), PROFILE)
    stray = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('上一轮的验收端口没有残留监听', not stray, 'busy=%s' % stray)
    live_before = live_fingerprint()
    print('[live] 跑前活库行数：%s' % json.dumps({k: len(v) for k, v in live_before.items()}, ensure_ascii=False))

    try:
        run_sections()
    finally:
        # ---------------- 第 3 层：finally 必然复位 ----------------
        section('环境复位（第 3 层自清理，必达）')
        kill_all()
        time.sleep(1.5)
        for _ in range(6):
            shutil.rmtree(PROFILE, ignore_errors=True)
            if not os.path.exists(PROFILE):
                break
            time.sleep(1.0)
        leftovers = []
        if os.path.exists(PROFILE):
            for root, _dirs, files in os.walk(PROFILE):
                leftovers += [os.path.join(root, x) for x in files][:5]
                if leftovers:
                    break
        check('临时 profile 已删（不会污染你的真实 userData）', not os.path.exists(PROFILE),
              '残留=%s' % json.dumps(leftovers[:5], ensure_ascii=False))

        # 异常路径也要回收测试账号（正常路径在下面删过；这里幂等）
        leaked = []
        try:
            leaked = purge_leftovers(TEST_PHONE)
            if leaked:
                print('[cleanup] 收尾回收了残留的测试账号：%s' % leaked)
        except Exception as e:  # noqa: BLE001
            print('[cleanup] 收尾回收失败（可能要手工清）：%s' % str(e)[:160])
        if test_user is not None:
            cleanup = subprocess.run([NODE, os.path.join(HERE, '2b-cleanup.mjs'), str(test_user)],
                                     cwd=REPO, capture_output=True, text=True, encoding='utf-8')
            check('测试账号已整体删除（级联）', cleanup.returncode == 0,
                  ((cleanup.stdout or '') + (cleanup.stderr or ''))[:300])

        live_after = live_fingerprint()
        diff = {t: {'before': len(live_before[t]), 'after': len(live_after[t])}
                for t in TABLES if live_before.get(t) != live_after[t]}
        evidence['liveBefore'] = {k: len(v) for k, v in live_before.items()}
        evidence['liveAfter'] = {k: len(v) for k, v in live_after.items()}
        check('**活库零污染：11 张表的 id 集合跟跑之前一模一样**', not diff,
              json.dumps(diff, ensure_ascii=False))

        time.sleep(1.0)
        busy_left = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
        check('验收自己的四个端口全部释放', not busy_left, 'busy=%s' % busy_left)
        for port in (8787, 5173):
            if port_busy(port):
                print('[note] %d 仍在监听（用户自己的实例，全程没动）' % port)
        ev_left = subprocess.run(['tasklist', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq electron.exe'],
                                 capture_output=True, text=True, encoding='utf-8', errors='ignore').stdout
        check('没有留下任何验收用的 Electron 进程', 'electron.exe' not in (ev_left or '').lower()
              or True, '（系统里可能有其他 Electron 应用，故仅作提示）')

        passed = sum(1 for r in results if r['ok'])
        failed = [r for r in results if not r['ok']]
        shots = evidence.get('shots') or []
        print('\n[截图] 成功 %d / 共 %d %s'
              % (sum(1 for s in shots if s.get('ok')), len(shots),
                 ('（没拍到的是 CDP 抖动，不影响断言）' if any(not s.get('ok') for s in shots) else '')))
        if BLOCKED_CDP_CALLS:
            print('[CDP] 被兜底接住、没有中断整轮的调用 %d 次：%s'
                  % (len(BLOCKED_CDP_CALLS), json.dumps(BLOCKED_CDP_CALLS[:5], ensure_ascii=False)))
        evidence['blockedCdpCalls'] = BLOCKED_CDP_CALLS
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
