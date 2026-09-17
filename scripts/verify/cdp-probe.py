"""第 20 步验收探针：连 9333 上的验收实例渲染进程，做 eval / 真键盘输入 / 点击 / 截图。

用法（端口读 WB20_PORT，页面匹配读 WB20_MATCH）：
  python wb20probe.py eval "<js>"      # 同步表达式
  python wb20probe.py evalf "<js>"     # 异步（内部包 (async()=>{...})()）
  python wb20probe.py click "<选择器>"  # 真鼠标点击
  python wb20probe.py type "<文本>" ["选择器"]
  python wb20probe.py login <token文件>
  python wb20probe.py send "<文本>"
  python wb20probe.py shot <png路径>
  python wb20probe.py webviews         # 列出所有 <webview> 的 partition / src / 尺寸
  python wb20probe.py targets          # 列出所有调试目标（看有没有第二个窗口）
"""
import base64
import json
import os
import sys
import time
import urllib.request

import websocket

PORT = os.environ.get('WB20_PORT', '9333')
MATCH = os.environ.get('WB20_MATCH', 'localhost:5273')


def _http(path, tries=3):
    """
    读 CDP 的 HTTP 端点。

    这里必须带重试：实测 Chromium 的 /json/list 会**偶发**直接把连接 reset 掉
    （第 4 阶段第一轮验收就栽在这上面 —— 一次 reset 落在"登录门"那一步，
    后面 5/8/12 张页全成了 0，连带 9 条断言全红，看起来像功能坏了，其实不是）。
    重试带退避、成功路径零额外开销，换来的是**一次抖动不再污染整轮结论**。
    """
    last = None
    for k in range(tries):
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            return json.load(op.open('http://127.0.0.1:%s%s' % (PORT, path), timeout=15))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.2 * (2 ** k))
    raise RuntimeError('CDP HTTP %s 连续 %d 次失败：%s' % (path, tries, last))


def _find(url_part, kind='page', tries=8, delay=0.5):
    """
    在 /json/list 里找目标 —— **带时间窗**，不是"问一次没有就判死"。

    为什么要有这个时间窗（两次真机验收换来的教训）：
      * 第 4 阶段第一轮：/json/list 一次连接 reset，把"登录门"整段带走；
      * 第 4 阶段第二轮回归：2-B 那套在 Electron 窗口**刚被确认存在**的几毫秒后调 `page()`，
        拿到了一份"只有 devtools、没有应用页"的列表 → 直接 NO_PAGE 判死。
        /json/list 在浏览器进程忙的时候给不出完整目标列表，这是端点本身的性质，
        不能当成"窗口没了"。
    所以这里改成：窗口期内反复问，问到了就走。找不到再抛，并把最后看到的列表带上，
    便于事后判断到底是"真没窗口"还是"端点抖动"。
    """
    last_seen = None
    for k in range(tries):
        try:
            lst = _http('/json/list')
            last_seen = [(t.get('type'), t.get('url')) for t in lst]
            for t in lst:
                if kind and t.get('type') != kind:
                    continue
                if url_part in (t.get('url') or ''):
                    return t
        except Exception as e:  # noqa: BLE001
            last_seen = 'HTTP 失败：%s' % e
        time.sleep(delay * (2 ** k) if k < 4 else delay * 8)
    raise RuntimeError('NO_%s for %s（窗口期内都没出现；最后看到的目标=%s）'
                       % (kind.upper(), url_part, last_seen))


def page(url_part=MATCH, tries=8):
    # 找不到目标时抛 RuntimeError 而**不是** SystemExit：本模块现在主要是被验收脚本
    # 当库 import 的，SystemExit 属于 BaseException，`except Exception` 兜不住它，
    # 会把"一次找不到目标"升级成"整轮验收直接退出"。
    return _find(url_part, kind='page', tries=tries)


def any_target(url_part, tries=8):
    """连到任意目标（含 webview 访客）——用来在内嵌页里跑 JS（验 cookie 隔离）。"""
    return _find(url_part, kind=None, tries=tries)


# 连接类异常：只有"对面把连接关掉/重置"才重试。
# 故意**不包括** WebSocketTimeoutException —— 超时可能意味着对面正忙着执行一个
# 有副作用的调用（点击、输入），重做一遍会变成"点两次"，那不是稳健，是制造新问题。
_RETRYABLE = (websocket.WebSocketConnectionClosedException, ConnectionResetError,
              ConnectionAbortedError, BrokenPipeError)


class Cdp:
    def __init__(self, t=None, tries=3):
        self.i = 0
        self._t = t
        self._connect(tries)

    def _connect(self, tries=3):
        """
        连一次并启用 Runtime —— **握手整体可重试**。

        第二轮回归里 Phase 3 就是栽在这里：ws 连上了，可紧接着 `Runtime.enable` 的
        recv 报 "Connection to remote host was lost."。上一版只对 create_connection
        做了重试，握手半途掉线就漏过去了 —— 结果一次抖动 = 1 条失败断言。
        现在把"连 + 启用"当成一个整体重做。
        """
        last = None
        for k in range(tries):
            try:
                target = self._t or page()
                self.ws = websocket.create_connection(target['webSocketDebuggerUrl'],
                                                      timeout=90, suppress_origin=True)
                self._t = target          # 记住目标，掉线后能原地重连
                self.i += 1
                self.ws.send(json.dumps({'id': self.i, 'method': 'Runtime.enable', 'params': {}}))
                while True:               # 同名/无关通知直接丢，等自己的 id
                    msg = json.loads(self.ws.recv())
                    if msg.get('id') == self.i:
                        break
                return
            except Exception as e:  # noqa: BLE001
                last = e
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.25 * (2 ** k))
        raise RuntimeError('CDP 连接+握手连续 %d 次失败：%s' % (tries, last))

    def send(self, method, **params):
        """一次调用；连接被对面关掉时换新连接重做（最多 3 次）。"""
        last = None
        for k in range(3):
            try:
                self.i += 1
                self.ws.send(json.dumps({'id': self.i, 'method': method, 'params': params}))
                while True:
                    msg = json.loads(self.ws.recv())
                    if msg.get('id') == self.i:
                        if 'error' in msg:
                            # 抛 RuntimeError 而不是 SystemExit：调用方（验收脚本）
                            # 用 `except Exception` 兜异常，SystemExit 会直接穿过去把整轮带走。
                            raise RuntimeError('CDP error: %s' % msg['error'])
                        return msg.get('result', {})
            except _RETRYABLE as e:
                last = e
                if k == 2:
                    break
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.4 * (2 ** k))
                self._connect(tries=2)
        raise RuntimeError('CDP 调用 %s 连续 3 次掉线：%s' % (method, last))

    def js(self, expr, await_promise=False):
        r = self.send('Runtime.evaluate', expression=expr, returnByValue=True,
                      userGesture=True, awaitPromise=await_promise)
        res = r.get('result', {})
        if r.get('exceptionDetails'):
            return {'__error': str(r['exceptionDetails'].get('text')) + ' ' +
                    str((r['exceptionDetails'].get('exception') or {}).get('description'))}
        return res.get('value')

    def jsf(self, expr):
        return self.js('(async () => { %s })()' % expr, await_promise=True)

    def click_rect(self, sel):
        r = self.js("(() => { const e=document.querySelector(%s); if(!e) return null;"
                    " e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect();"
                    " return {x:b.x+b.width/2, y:b.y+b.height/2, w:b.width, h:b.height}; })()" % json.dumps(sel))
        if not r:
            return 'NO_ELEM ' + sel
        for kind in ('mousePressed', 'mouseReleased'):
            self.send('Input.dispatchMouseEvent', type=kind, x=r['x'], y=r['y'],
                      button='left', clickCount=1)
        return 'clicked %s at (%.0f,%.0f)' % (sel, r['x'], r['y'])

    def click_at(self, x, y):
        for kind in ('mousePressed', 'mouseReleased'):
            self.send('Input.dispatchMouseEvent', type=kind, x=x, y=y, button='left', clickCount=1)

    def type_text(self, text, sel=None, replace=True):
        if sel:
            self.click_rect(sel)
            time.sleep(0.25)
        tag = self.js('document.activeElement ? document.activeElement.tagName : ""')
        if sel and tag != 'INPUT' and tag != 'TEXTAREA':
            self.js('document.querySelector(%s).focus()' % json.dumps(sel))
            time.sleep(0.15)
        if replace:
            for kind in ('rawKeyDown', 'keyUp'):
                self.send('Input.dispatchKeyEvent', type=kind, modifiers=2,
                          windowsVirtualKeyCode=65, key='a', code='KeyA')
            time.sleep(0.1)
            self.send('Input.dispatchKeyEvent', type='rawKeyDown', windowsVirtualKeyCode=8, key='Backspace', code='Backspace')
            self.send('Input.dispatchKeyEvent', type='keyUp', windowsVirtualKeyCode=8, key='Backspace', code='Backspace')
            time.sleep(0.1)
        self.send('Input.insertText', text=text)
        time.sleep(0.3)
        return self.js('document.activeElement ? document.activeElement.value : null')

    def shot(self, path):
        r = self.send('Page.captureScreenshot', format='png', captureBeyondViewport=False)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))
        return path


WEBVIEWS_JS = r"""
(() => {
  const list = [...document.querySelectorAll('webview')].map((w) => {
    const b = w.getBoundingClientRect();
    let wc = null;
    try { wc = w.getWebContentsId(); } catch (e) { wc = 'ERR'; }
    return { partition: w.getAttribute('partition'), src: w.getAttribute('src'),
             wcId: wc, x: Math.round(b.x), y: Math.round(b.y),
             w: Math.round(b.width), h: Math.round(b.height),
             cls: w.className,
             url: (() => { try { return w.getURL(); } catch (e) { return null; } })(),
             title: (() => { try { return w.getTitle(); } catch (e) { return null; } })() };
  });
  return { count: list.length, list };
})()
"""

TABS_JS = r"""
(() => {
  const who = document.querySelector('.browserPanel__who');
  const tabs = [...document.querySelectorAll('.browserTab')].map((t) => ({
    on: t.className.includes('--on'),
    label: (t.querySelector('.browserTab__label') || {}).textContent || '',
    run: Boolean(t.querySelector('.browserTab__run')),
    title: (t.querySelector('.browserTab__label') || {}).title || '',
  }));
  const bar = document.querySelector('.browserPanel');
  const bb = bar ? bar.getBoundingClientRect() : null;
  return {
    who: who ? who.textContent : null,
    tabCount: tabs.length,
    tabs,
    countLabel: (document.querySelector('.browserPanel__count') || {}).textContent || null,
    warn: (document.querySelector('.browserPanel__warn') || {}).textContent || null,
    url: (document.querySelector('.browserPanel__url') || {}).value || null,
    panelRect: bb ? { x: Math.round(bb.x), y: Math.round(bb.y), h: Math.round(bb.height) } : null,
  };
})()
"""

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'targets':
        print(json.dumps([{'type': t.get('type'), 'title': t.get('title'), 'url': t.get('url')}
                          for t in _http('/json/list')], ensure_ascii=False, indent=1))
        sys.exit(0)
    if cmd in ('gjs', 'gjsf'):
        g = Cdp(any_target(sys.argv[2]))
        print(json.dumps(g.jsf(sys.argv[3]) if cmd == 'gjsf' else g.js(sys.argv[3]), ensure_ascii=False))
        sys.exit(0)
    if cmd == 'quit':
        # 优雅关掉整个应用（走 CDP 的 Browser.close，等于用户点关闭窗口）：
        # localStorage 会正常落盘，之后可以用同一个 user-data-dir 重开验「直接进工作台」。
        ver = _http('/json/version')
        ws = websocket.create_connection(ver['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
        ws.send(json.dumps({'id': 1, 'method': 'Browser.close', 'params': {}}))
        print('CLOSE_SENT')
        sys.exit(0)
    if cmd == 'gjsall':
        # 对所有 url 命中 sys.argv[2] 的目标各跑一次（用来对比两个分区的同一站点）
        out = []
        for t in _http('/json/list'):
            if sys.argv[2] not in (t.get('url') or ''):
                continue
            g = Cdp(t)
            out.append({'title': t.get('title'), 'url': t.get('url'),
                        'value': g.js(sys.argv[3])})
        print(json.dumps(out, ensure_ascii=False, indent=1))
        sys.exit(0)
    c = Cdp()
    if cmd == 'url':
        print(c.js('location.href'))
    elif cmd == 'tabs':
        print(json.dumps(c.js(TABS_JS), ensure_ascii=False, indent=1))
    elif cmd == 'webviews':
        print(json.dumps(c.js(WEBVIEWS_JS), ensure_ascii=False, indent=1))
    elif cmd == 'login':
        with open(sys.argv[2], 'r', encoding='utf-8') as f:
            tok = f.read().strip()
        print(c.js("localStorage.setItem('workbench.token', %s); 'set'" % json.dumps(tok)))
        c.send('Page.reload')
        time.sleep(7)
        print(json.dumps(c.js("({url: location.href, head: document.body.innerText.slice(0,200)})"),
                         ensure_ascii=False))
    elif cmd == 'send':
        text = sys.argv[2]
        ok = False
        for attempt in range(4):
            c.click_rect('.inputBar input')
            time.sleep(0.3)
            tag = c.js('document.activeElement ? document.activeElement.tagName : ""')
            if tag != 'INPUT':
                c.js("document.querySelector('.inputBar input').focus()")
                time.sleep(0.2)
            c.type_text(text)
            val = c.js("document.querySelector('.inputBar input').value")
            if val == text:
                ok = True
                break
            print('attempt %d failed, value=%r' % (attempt + 1, val))
        if not ok:
            print('SEND_ABORT: 输入框内容不等于期望文本')
            sys.exit(1)
        print(c.js("(() => { const b=document.querySelector('.inputBar button');"
                   " if(!b) return 'NO_SEND_BTN'; b.click(); return 'sent:'+b.textContent; })()"))
        prev = None
        same = 0
        for _ in range(60):
            time.sleep(1.2)
            cur = c.js('document.body.innerText.length')
            busy = c.js("document.body.innerText.includes('打字中') || document.body.innerText.includes('正在想')")
            if cur == prev and not busy:
                same += 1
                if same >= 3:
                    break
            else:
                same = 0
            prev = cur
        print('done, innerText len =', cur)
    elif cmd == 'eval':
        print(json.dumps(c.js(sys.argv[2]), ensure_ascii=False))
    elif cmd == 'evalf':
        print(json.dumps(c.jsf(sys.argv[2]), ensure_ascii=False))
    elif cmd == 'click':
        print(c.click_rect(sys.argv[2]))
    elif cmd == 'type':
        print(c.type_text(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None))
    elif cmd == 'shot':
        print(c.shot(sys.argv[2]))
    else:
        print('UNKNOWN_CMD ' + cmd)
