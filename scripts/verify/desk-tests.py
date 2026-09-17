"""子阶段 A 桌面侧真机验收（改造点 1/2/3 的并发相关 8 条标准）。

用法：
  python desk-tests.py setup          # 开页 + 记录 wcId
  python desk-tests.py concurrency    # 验收 1：同一智能体两路真并发（时间戳重叠）
  python desk-tests.py pause          # 验收 2：暂停 1 号，2 号不受影响
  python desk-tests.py crossagent     # 验收 3：跨智能体 A/B 同时跑
  python desk-tests.py failfast       # 验收 5：忘记传 target id 直接报错
  python desk-tests.py sensitive      # 验收 6：密码/验证码不代填（并发场景下）
  python desk-tests.py resources      # 验收 8：5-8 个浏览器实例的资源占用
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 探针在上一级 %TEMP%
os.environ.setdefault('WB20_PORT', '9333')
os.environ.setdefault('WB20_MATCH', 'localhost:5273')

import wb20probe as P  # noqa: E402

TOKEN = open('C:/Users/bing/AppData/Local/Temp/subA/token.txt', encoding='utf-8').read().strip()
API = 'http://127.0.0.1:8799'
LLM_LOG = 'C:/Users/bing/AppData/Local/Temp/subA/llm.jsonl'
OUTDIR = 'C:/Users/bing/AppData/Local/Temp/subA'
PY = sys.executable


def api_get(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(API + path, headers={'authorization': 'Bearer ' + TOKEN})
    with op.open(req, timeout=15) as r:
        return json.load(r)


def js(expr):
    c = P.Cdp()
    try:
        return c.jsf(expr)
    finally:
        c.ws.close()


def ev(expr):
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        c.ws.close()


def llm_lines():
    try:
        with open(LLM_LOG, encoding='utf-8') as f:
            return [json.loads(x) for x in f if x.strip()]
    except FileNotFoundError:
        return []


def truncate_llm_log():
    open(LLM_LOG, 'w').close()


def webviews():
    return ev(P.WEBVIEWS_JS)['list']


def wc_of(url_part):
    for w in webviews():
        if url_part in (w.get('url') or ''):
            return w['wcId']
    return None


def start_lane(wc, goal, agent):
    return js(
        "const st = await window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d});"
        "return JSON.stringify(st);" % (json.dumps(goal), json.dumps(API), json.dumps(TOKEN), wc, agent)
    )


def state(wc):
    return js("return JSON.stringify(await window.workbench.getTaskState(%d));" % wc)


def lanes():
    return js("return JSON.stringify(await window.workbench.agentLanes());")


def dump(name, obj):
    path = os.path.join(OUTDIR, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print('->', path)
    return path


def page_state(wc):
    try:
        return api_get('/agent/loop/state?wcId=%d' % wc)['state']
    except Exception as e:  # noqa: BLE001
        return {'__error': str(e)}


# ---------------------------------------------------------------------------
def cmd_setup():
    print(js(
        "await window.workbench.openBrowser('http://127.0.0.1:8899/page-a');"
        "await new Promise(r=>setTimeout(r,2200));"
        "await window.workbench.openBrowser('http://127.0.0.1:8898/page-b');"
        "await new Promise(r=>setTimeout(r,2600));"
        "return 'opened';"
    ))
    time.sleep(1)
    w = webviews()
    print(json.dumps(w, ensure_ascii=False, indent=1))
    dump('pages-setup.json', w)


def cmd_concurrency():
    """验收 1：同一智能体（小助 id=1）两张页同时跑两个任务，用时间戳证明执行期真实重叠。"""
    truncate_llm_log()
    wa, wb = wc_of('8899/page-a'), wc_of('8898/page-b')
    assert wa and wb, '两张页必须先开好（跑 setup）'
    print('wcA =', wa, 'wcB =', wb)
    t0 = time.time()
    # 两路几乎同时发车
    r1 = start_lane(wa, '并发任务甲：整理 A 页要点', 1)
    r2 = start_lane(wb, '并发任务乙：整理 B 页要点', 1)
    print('lane1 =', r1)
    print('lane2 =', r2)
    timeline = []
    for i in range(40):
        time.sleep(1)
        h = api_get('/health')
        timeline.append({
            't': round(time.time() - t0, 1),
            'liveLoops': h['liveLoops'],
            'llmCalls': h['llmCalls'],
            'pageStates': h['pageStates'],
            'lanes': json.loads(lanes()),
            'taskA': json.loads(state(wa)),
            'taskB': json.loads(state(wb)),
        })
        if timeline[-1]['liveLoops'] == 0 and i >= 4:
            break
    lines = llm_lines()
    intervals = {}
    for ev_ in lines:
        intervals.setdefault(ev_['goal'], []).append(ev_)
    overlap = None
    spans = {}
    for g, evs in intervals.items():
        reqs = [e for e in evs if e['ev'] == 'req']
        ress = [e for e in evs if e['ev'] == 'res']
        if reqs and ress:
            spans[g] = (min(r['at'] for r in reqs), max(r['at'] for r in ress))
    keys = list(spans)
    if len(keys) >= 2:
        a, b = spans[keys[0]], spans[keys[1]]
        overlap = round((min(a[1], b[1]) - max(a[0], b[0])) / 1000, 2)
    out = {
        'wcA': wa, 'wcB': wb, 'lane1': json.loads(r1), 'lane2': json.loads(r2),
        'timeline': timeline,
        'llm_spans_ms': {k: {'from': v[0], 'to': v[1], 'dur_s': round((v[1] - v[0]) / 1000, 2)} for k, v in spans.items()},
        'overlap_s': overlap,
        'llm_request_count': len([x for x in lines if x['ev'] == 'req']),
        'stateA': page_state(wa), 'stateB': page_state(wb),
    }
    dump('concurrency.json', out)
    print('两路执行区间：', json.dumps(out['llm_spans_ms'], ensure_ascii=False))
    print('重叠时长（秒）=', overlap)
    print('A 页状态：', json.dumps(out['stateA'], ensure_ascii=False))
    print('B 页状态：', json.dumps(out['stateB'], ensure_ascii=False))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'dropped';" % (wa, wb))


def cmd_pause():
    """验收 2：暂停 1 号那一路，2 号必须完全不受影响、继续跑完。"""
    truncate_llm_log()
    wa, wb = wc_of('8899/page-a'), wc_of('8898/page-b')
    assert wa and wb, '两张页必须先开好（跑 setup）'
    print('wcA =', wa, 'wcB =', wb)
    r1 = start_lane(wa, '暂停实验甲：整理 A 页', 1)
    r2 = start_lane(wb, '暂停实验乙：整理 B 页', 1)
    print('lane1 =', r1)
    print('lane2 =', r2)
    time.sleep(4.0)
    before = len([x for x in llm_lines() if x['ev'] == 'req'])
    pause_ret = js("return JSON.stringify(await window.workbench.pauseTask(%d));" % wa)
    t_pause = time.time()
    print('暂停 1 号返回：', pause_ret)
    samples = []
    for i in range(30):
        time.sleep(1)
        samples.append({
            't': round(time.time() - t_pause, 1),
            'taskA': json.loads(state(wa)),
            'taskB': json.loads(state(wb)),
            'stateA_step': (page_state(wa) or {}).get('step'),
            'stateB_step': (page_state(wb) or {}).get('step'),
            'liveLoops': api_get('/health')['liveLoops'],
        })
        if samples[-1]['taskB']['phase'] in ('done', 'failed') and i >= 3:
            break
    lines = llm_lines()
    a_after = [x for x in lines if x['ev'] == 'req' and x['at'] > t_pause * 1000 and '暂停实验甲' in x['goal']]
    b_after = [x for x in lines if x['ev'] == 'req' and x['at'] > t_pause * 1000 and '暂停实验乙' in x['goal']]
    out = {
        'wcA': wa, 'wcB': wb, 'lane1': json.loads(r1), 'lane2': json.loads(r2),
        'pause_ret': json.loads(pause_ret),
        'llm_reqs_before_pause': before,
        'A_reqs_after_pause': len(a_after),
        'B_reqs_after_pause': len(b_after),
        'samples': samples,
        'finalA': json.loads(state(wa)), 'finalB': json.loads(state(wb)),
    }
    dump('pause.json', out)
    print('暂停后：A 的模型请求数 =', len(a_after), ' B 的模型请求数 =', len(b_after))
    print('A 终态：', out['finalA']['phase'], out['finalA']['detail'])
    print('B 终态：', out['finalB']['phase'], out['finalB']['detail'])
    for s in samples[:6]:
        print('  %5.1fs A=%s/%s step=%s | B=%s/%s step=%s | live=%s' % (
            s['t'], s['taskA']['phase'], s['taskA']['step'], s['stateA_step'],
            s['taskB']['phase'], s['taskB']['step'], s['stateB_step'], s['liveLoops']))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'dropped';" % (wa, wb))


def cmd_crossagent():
    """验收 3：智能体 A(1) 与 智能体 B(8) 各开一张页同时跑，互不干扰。"""
    truncate_llm_log()
    wa = wc_of('8899/page-a')
    if wa is None:
        js("await window.workbench.openBrowser('http://127.0.0.1:8899/page-a'); await new Promise(r=>setTimeout(r,2500)); return 'ok';")
        wa = wc_of('8899/page-a')
    # 切到「卡布」，给它开一张自己的页（不同 partition）
    js("(()=>{const it=[...document.querySelectorAll('.contact')].find(e=>e.textContent.includes('卡布')); if(it) it.click(); return it?'clicked':'NO';})()")
    time.sleep(1.5)
    js("await window.workbench.openBrowser('http://127.0.0.1:8897/page-c'); await new Promise(r=>setTimeout(r,2600)); return 'ok';")
    time.sleep(1)
    wc = webviews()
    print(json.dumps(wc, ensure_ascii=False, indent=1))
    wb = wc_of('8897/page-c')
    assert wb, '卡布那张页没开出来'
    # 切回小助，两路同时发车
    js("(()=>{const it=[...document.querySelectorAll('.contact')].find(e=>e.textContent.includes('小助')); if(it) it.click(); return 'ok';})()")
    time.sleep(1.2)
    start_lane(wa, '跨智能体甲：小助的 A 页', 1)
    start_lane(wb, '跨智能体乙：卡布的 C 页', 8)
    timeline = []
    t0 = time.time()
    for i in range(40):
        time.sleep(1)
        timeline.append({
            't': round(time.time() - t0, 1),
            'taskA': json.loads(state(wa)), 'taskB': json.loads(state(wb)),
            'liveLoops': api_get('/health')['liveLoops'],
        })
        if timeline[-1]['liveLoops'] == 0 and i >= 4:
            break
    lines = llm_lines()
    out = {
        'wcA': wa, 'wcB': wb, 'partitions': {str(x['wcId']): x['partition'] for x in wc},
        'timeline': timeline,
        'finalA': json.loads(state(wa)), 'finalB': json.loads(state(wb)),
        'stateA': page_state(wa), 'stateB': page_state(wb),
        'llm_reqs': len([x for x in lines if x['ev'] == 'req']),
    }
    dump('crossagent.json', out)
    print('A 终态：', out['finalA']['phase'], '| B 终态：', out['finalB']['phase'])
    print('A 页状态 current_task =', out['stateA'].get('current_task'))
    print('B 页状态 current_task =', out['stateB'].get('current_task'))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'dropped';" % (wa, wb))


def cmd_failfast():
    """验收 5：**并发场景下**重新验证 fail-fast —— 忘记传 target id 必须直接报错。"""
    wa, wb = wc_of('8899/page-a'), wc_of('8898/page-b')
    start_lane(wa, 'failfast 复验：甲路', 1)
    start_lane(wb, 'failfast 复验：乙路', 1)
    time.sleep(1.5)
    lanes_during = json.loads(lanes())
    r1 = js("try { const r = await window.workbench.readPage(); return JSON.stringify({threw:false, r}); } catch (e) { return JSON.stringify({threw:true, msg:String(e && e.message || e)}); }")
    r2 = js("try { const r = await window.workbench.readPage(999999); return JSON.stringify({threw:false, r}); } catch (e) { return JSON.stringify({threw:true, msg:String(e && e.message || e)}); }")
    r3 = js("try { const r = await window.workbench.drive({action:'read_page'}); return JSON.stringify({threw:false, r}); } catch (e) { return JSON.stringify({threw:true, msg:String(e && e.message || e)}); }")
    out = {'lanes_during_test': lanes_during, 'liveLoops_during_test': api_get('/health')['liveLoops'],
           'readPage_no_target': json.loads(r1), 'readPage_bad_target': json.loads(r2),
           'drive_no_target': json.loads(r3)}
    dump('failfast.json', out)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'dropped';" % (wa, wb))


def cmd_sensitive():
    """验收 6：**并发场景下**重跑「密码 / 验证码 / 支付不代填」。

    顺序刻意安排成「先把 /form 开出来（含导航），**再**在它上面发车」——
    避免在循环跑着的时候去导航/重挂 webview（那是另一件事，见验收报告「新发现」一节）。
    """
    # 1) 把 B 那张页导航到敏感表单页（此时还没有任何循环在跑）
    js("await window.workbench.openBrowser('http://127.0.0.1:8898/form'); await new Promise(r=>setTimeout(r,2600)); return 'ok';")
    time.sleep(1)
    wf = wc_of('8898/form')
    assert wf, '敏感表单页没开出来'
    wa = wc_of('8899/page-a')
    # 2) 并发：A 页一路循环跑着，同时在表单页上打敏感动作（同一窗口期）
    start_lane(wa, '敏感闸复验：并发窗口内跑一路', 1)
    start_lane(wf, '敏感闸复验：表单页也挂一路', 1)
    time.sleep(1.5)
    lanes_during = json.loads(lanes())
    res = {}
    res['pw'] = js("return JSON.stringify(await window.workbench.drive({action:'type',target:'密码',text:'hunter2'},%d));" % wf)
    res['otp'] = js("return JSON.stringify(await window.workbench.drive({action:'type',target:'短信验证码',text:'123456'},%d));" % wf)
    res['normal'] = js("return JSON.stringify(await window.workbench.drive({action:'type',target:'普通输入框',text:'hello-subA'},%d));" % wf)
    res['pay'] = js("return JSON.stringify(await window.workbench.drive({action:'click',target:'立即支付'},%d));" % wf)
    time.sleep(1)
    # 3) 直接进访客页读真实 value（硬证据）
    g = P.Cdp(P.any_target('8898/form'))
    vals = g.js("JSON.stringify({pw:document.querySelector('#pw1').value,otp:document.querySelector('#otp1').value,q1:document.querySelector('#q1').value})")
    g.ws.close()
    out = {
        'wcForm': wf, 'wcA': wa,
        'lanes_during_test': lanes_during, 'liveLoops_during_test': api_get('/health')['liveLoops'],
        'results': {k: json.loads(v) for k, v in res.items()},
        'guest_values': json.loads(vals),
    }
    dump('sensitive.json', out)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'ok';" % (wa, wf))


def _browser_procs():
    """通过 CDP 的 SystemInfo.getProcessInfo 拿到**本实例**的进程清单（含 OS pid）。"""
    import websocket
    ver = P._http('/json/version')
    ws = websocket.create_connection(ver['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
    try:
        ws.send(json.dumps({'id': 1, 'method': 'SystemInfo.getProcessInfo', 'params': {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get('id') == 1:
                return msg.get('result', {}).get('processInfo', [])
    finally:
        ws.close()


def _mem_of(pids):
    """tasklist 取每个 pid 的工作集（KB）。"""
    out = {}
    for pid in pids:
        r = subprocess.run(['tasklist', '/FO', 'CSV', '/NH', '/FI', 'PID eq %d' % pid],
                           capture_output=True, text=True, encoding='utf-8', errors='ignore')
        line = (r.stdout or '').strip().splitlines()
        if not line:
            continue
        parts = [x.strip('"') for x in line[0].split('","')]
        if len(parts) >= 5:
            try:
                out[pid] = int(parts[4].replace(',', '').replace(' K', '').replace('K', '').strip())
            except ValueError:
                pass
    return out


def cmd_resources():
    """验收 8：同时开 5-8 张内嵌页时的内存 / CPU 占用（只记录，不做限制）。"""
    urls = [
        'http://127.0.0.1:8899/page-a', 'http://127.0.0.1:8898/page-b', 'http://127.0.0.1:8897/page-c',
        'http://127.0.0.1:8896/page-d', 'http://127.0.0.1:8895/page-e', 'http://127.0.0.1:8894/page-f',
        'http://127.0.0.1:8893/page-g', 'http://127.0.0.1:8892/page-h',
    ]
    # 先把开页上限抬到 8（配置项，不改代码；这正是 D 上限「可调」的用法）
    print(js("return JSON.stringify(await window.workbench.setSettings({maxBrowserInstances: 8}));"))
    base = webviews()
    print('STEP: webviews ok, count =', len(base))
    samples = []

    def measure(label):
        procs = _browser_procs()
        mem = _mem_of([p['id'] for p in procs])
        rows = [{'pid': p['id'], 'type': p.get('type'), 'memMB': round(mem.get(p['id'], 0) / 1024, 1)} for p in procs]
        return {'label': label, 'procCount': len(rows),
                'memMB': round(sum(r['memMB'] for r in rows), 1), 'procs': rows}

    samples.append(measure('%d 张页（本次实验的起点）' % len(base)))
    for u in urls:
        print('STEP: openBrowser', u)
        js("await window.workbench.openBrowser(%s); await new Promise(r=>setTimeout(r,2200)); return 'ok';" % json.dumps(u))
        w = webviews()
        print('  -> count =', len(w))
        samples.append(measure('%d 张页' % len(w)))
        samples[-1]['wcIds'] = [x['wcId'] for x in w]
        if len(w) >= 8:
            break
    time.sleep(4)
    final = webviews()
    procs1 = _browser_procs()
    cpu1 = {p['id']: p.get('cpuTime', 0) for p in procs1}
    time.sleep(6)
    procs2 = _browser_procs()
    cpu2 = {p['id']: p.get('cpuTime', 0) for p in procs2}
    mem = _mem_of([p['id'] for p in procs2])
    rows = []
    for p in procs2:
        pid = p['id']
        d = cpu2.get(pid, 0) - cpu1.get(pid, 0)
        rows.append({
            'pid': pid, 'type': p.get('type'),
            'memMB': round(mem.get(pid, 0) / 1024, 1),
            'cpu_pct_over_6s': round(d / 6 * 100, 1),
            'cpuTime_s': round(p.get('cpuTime', 0), 1),
        })
    out = {
        'settings': json.loads(js("return JSON.stringify(await window.workbench.getSettings());")),
        'pages_before': len(base), 'samples': samples, 'pages_final': len(final),
        'webviews': final, 'processes': rows,
        'total_memMB': round(sum(r['memMB'] for r in rows), 1),
        'total_cpu_pct': round(sum(r['cpu_pct_over_6s'] for r in rows), 1),
        'health': api_get('/health'),
    }
    dump('resources.json', out)
    print(json.dumps({'pages': len(final), 'processes': rows,
                      'total_memMB': out['total_memMB'], 'total_cpu_pct': out['total_cpu_pct'],
                      'samples': [{'label': s['label'], 'procCount': s['procCount'], 'memMB': s['memMB']} for s in samples]},
                     ensure_ascii=False, indent=1))


def cmd_gate():
    """验收 1 的补充：开关本身还在 —— 把上限调回 1，第 2 路必须被明确拒绝。"""
    wa, wb = wc_of('8899/page-a'), wc_of('8898/page-b')
    print('设上限=1：', js("return JSON.stringify(await window.workbench.setSettings({maxConcurrentAgentTasks: 1}));"))
    start_lane(wa, '闸门实验：第 1 路', 1)
    time.sleep(0.8)
    r2 = start_lane(wb, '闸门实验：第 2 路（应被拒）', 1)
    time.sleep(0.8)
    out = {
        'limit1': json.loads(js("return JSON.stringify(await window.workbench.getSettings());")),
        'lane2_ret': json.loads(r2),
        'lanes': json.loads(lanes()),
        'taskB': json.loads(state(wb)),
        'liveLoops': api_get('/health')['liveLoops'],
    }
    print('恢复上限=20：', js("return JSON.stringify(await window.workbench.setSettings({maxConcurrentAgentTasks: 20}));"))
    dump('gate.json', out)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    js("await window.workbench.agentDrop(%d); await window.workbench.agentDrop(%d); return 'dropped';" % (wa, wb))


if __name__ == '__main__':
    {'setup': cmd_setup, 'concurrency': cmd_concurrency, 'pause': cmd_pause,
     'crossagent': cmd_crossagent, 'failfast': cmd_failfast,
     'sensitive': cmd_sensitive, 'resources': cmd_resources, 'gate': cmd_gate}[sys.argv[1]]()
