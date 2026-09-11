import { webContents } from 'electron';
import type {
  BrowserAction,
  BrowserActionType,
  DriveResult,
  PageSnapshot,
} from '@ai-workbench/shared';

/**
 * 第 3 步「遥控器先通」——本地驾驶执行器。
 *
 * 目标：让程序能驾驶**主窗口右栏那块内嵌 webview**（不是独立窗口、不是云端浏览器）。
 * 手段：主进程拿到该 webview 的 guest `webContents`，挂上 `webContents.debugger`（CDP 1.3），
 *      用 `Runtime.evaluate` + `Input.dispatchMouseEvent` 这类协议命令去操作页面。
 *
 * 明确不做的事：
 *   - 不用 Playwright / Puppeteer / 再下一份 Chrome（那会多出一个浏览器进程，违背“驾驶现有内嵌页”）
 *   - 不创建任何 BrowserWindow（第 2 步已经把独立窗口砍掉了）
 *   - 渲染进程不 require('electron')，所有能力只从 preload 的 window.workbench.* 进来
 *
 * 执行器形态：传入一个动作 → 在内嵌页执行 → 返回 { ok, pageSnapshot }。
 */

/** 暂停开关：为 true 时 click / type 一律不执行，把页面交还给用户 */
let paused = false;

export function setDrivingPaused(value: boolean): boolean {
  paused = value;
  return paused;
}

export function isDrivingPaused(): boolean {
  return paused;
}

type Target = Electron.WebContents;

/** 被暂停拦截的动作（其余动作如 open_url / scroll / read_page 仍然允许） */
const PAUSED_BLOCKED: ReadonlySet<BrowserActionType> = new Set<BrowserActionType>(['click', 'type']);

// ---------------------------------------------------------------------------
// 找到要驾驶的那块内嵌页
// ---------------------------------------------------------------------------

/** 兜底：从所有 webContents 里挑出类型为 webview 的 guest */
function findWebviewGuest(): Target | null {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (wc.getType() === 'webview') return wc;
  }
  return null;
}

/**
 * 解析驾驶目标。
 * 渲染层传来的 id 是首选（精确、不受“有多个 webview”影响），
 * 拿不到或已失效时回退到自动寻找内嵌 webview。
 */
function resolveTarget(id?: number): Target {
  if (typeof id === 'number') {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed() && wc.getType() === 'webview') return wc;
  }
  const auto = findWebviewGuest();
  if (!auto) {
    throw new Error('没有找到内嵌 webview 的 webContents —— 请先在右栏打开工作台浏览器');
  }
  return auto;
}

// ---------------------------------------------------------------------------
// CDP 基础能力
// ---------------------------------------------------------------------------

function ensureAttached(wc: Target): Electron.Debugger {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  return dbg;
}

interface CdpEvalResponse {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

/** 在页面里执行一段脚本，拿回可序列化的值 */
async function evaluate<T>(wc: Target, expression: string): Promise<T> {
  const dbg = ensureAttached(wc);
  const res = (await dbg.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    // 让页面里的 click()/submit() 被当成用户手势，绕过部分站点的手势限制
    userGesture: true,
  })) as CdpEvalResponse;

  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        '页面脚本执行异常',
    );
  }
  return res.result?.value as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 注入到页面里的辅助脚本
//
// 作用：把「按 target 找元素」和「读页面快照」这两件事统一在页面侧实现。
// 幂等（带版本号），每次动作前注入一次即可。
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `(() => {
  if (window.__wbHelper && window.__wbHelper.__v === 4) return;
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const text = (el) => {
    if (!el) return '';
    let raw = el.innerText || el.textContent || '';
    // <input type="submit"> 之类的按钮，文字在 value 上
    if (!raw && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) raw = el.value || '';
    raw = raw || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return String(raw).replace(/\\s+/g, ' ').trim();
  };
  const SELECTABLE = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const find = (target) => {
    if (!target) return null;
    const t = String(target).trim();
    // 1) 当成 CSS 选择器试。注意要遍历**所有**匹配、取第一个可见的：
    //    真实站点常有「元素在 DOM 里但被 display:none 的祖先藏起来」的情况
    //    （百度首页就是：隐藏的经典搜索框 #kw / #su 排在新版 AI 搜索框前面），
    //    只取 querySelector 的第一个匹配会误判成「找不到元素」。
    //    选择器写成逗号列表即可天然降级，例如 '#kw, textarea#chat-textarea'。
    try {
      const all = document.querySelectorAll(t);
      for (let i = 0; i < all.length; i += 1) {
        if (visible(all[i])) return all[i];
      }
    } catch (_) { /* 不是合法选择器，继续走文本匹配 */ }
    const low = t.toLowerCase();
    const cands = Array.prototype.filter.call(document.querySelectorAll(SELECTABLE), visible);
    // 2) placeholder / aria-label / name / id / title 精确命中
    let hit = cands.find((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title')]
      .some((v) => v && v.trim().toLowerCase() === low));
    if (hit) return hit;
    // 3) 可见文字精确命中
    hit = cands.find((el) => text(el).toLowerCase() === low);
    if (hit) return hit;
    // 4) 可见文字包含
    hit = cands.find((el) => text(el).toLowerCase().indexOf(low) >= 0);
    if (hit) return hit;
    // 5) 兜底：任意可见叶子节点文字包含
    hit = Array.prototype.find.call(document.querySelectorAll('*'),
      (el) => visible(el) && el.children.length === 0 && text(el).toLowerCase().indexOf(low) >= 0);
    return hit || null;
  };
  const snapshot = () => ({
    url: location.href,
    title: document.title,
    buttons: Array.prototype.filter.call(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'), visible)
      .map(text).filter(Boolean).slice(0, 40),
    links: Array.prototype.filter.call(document.querySelectorAll('a[href]'), visible)
      .map(text).filter(Boolean).slice(0, 40),
    inputs: Array.prototype.filter.call(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]'), visible)
      .map((el) => {
        const ph = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
        const nm = el.getAttribute('name') || el.id || '';
        const val = el.value || '';
        return [ph && ('placeholder=' + ph), nm && ('name=' + nm), val && ('value=' + val)]
          .filter(Boolean).join(' | ') || '(无标识输入框)';
      }).slice(0, 40),
  });
  window.__wbHelper = { __v: 4, visible, text, find, snapshot };
})();`;

/** 组合一段「注入 helper + 执行动作」的脚本 */
function pageScript(body: string): string {
  return `${PAGE_HELPERS}\n${body}`;
}

/** 读一次页面快照 */
async function readSnapshot(wc: Target): Promise<PageSnapshot> {
  return evaluate<PageSnapshot>(wc, pageScript('(() => window.__wbHelper.snapshot())()'));
}

// ---------------------------------------------------------------------------
// 各个动作的实现
// ---------------------------------------------------------------------------

/** open_url：让内嵌页真的跳过去，并等它加载完 */
async function navigate(wc: Target, url: string): Promise<void> {
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', onStop);
      wc.off('did-fail-load', onFail);
      err ? reject(err) : resolve();
    };
    const onStop = () => finish();
    const onFail = (
      _e: Electron.Event,
      code: number,
      desc: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // 子资源失败不算导航失败；-3 是 ERR_ABORTED（页面内跳转常出现），也放过
      if (!isMainFrame || code === -3) return;
      finish(new Error(`导航失败（${code}）${desc} ${validatedURL}`));
    };
    const timer = setTimeout(() => finish(), 30_000);

    wc.once('did-stop-loading', onStop);
    wc.on('did-fail-load', onFail);
    wc.loadURL(target).catch(() => {
      /* 真正的失败由 did-fail-load 汇报，这里避免 unhandled rejection */
    });
  });

  // 页面 onload 之后往往还有异步渲染，稍等一下再读快照
  await sleep(500);
}

/**
 * click：优先用 CDP 发真实鼠标事件点元素中心（最接近真人操作）。
 *
 * ⚠️ 但**坐标必须落在视口内**才算数。实测踩到过：内嵌页视口只有 551px 宽，
 * 而百度首页那排搜索 UI 固定 771px 宽、把「百度一下」按钮挤到了视口右侧外面，
 * 此时 `Input.dispatchMouseEvent` 发出去的坐标命不中任何元素 —— 点击**静默失败**，
 * 但回执看起来还是 ok:true，属于典型的"假成功"。
 * 所以这里先做一次命中测试（elementFromPoint），命中不了就退化为页面侧 `el.click()`，
 * 并把实际用的方式写进 detail 回报。
 */
async function clickTarget(
  wc: Target,
  target: string,
): Promise<{ label: string; method: string; hittable: boolean } | null> {
  const hit = await evaluate<{
    x: number;
    y: number;
    tag: string;
    label: string;
    hittable: boolean;
  } | null>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.find(${JSON.stringify(target)});
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const inside = cx >= 0 && cy >= 0 && cx < vw && cy < vh;
      let top = null;
      try { top = document.elementFromPoint(cx, cy); } catch (_) {}
      // 命中测试：落点必须在视口内，且真的压在这个元素（或它的子节点）上
      const hittable = inside && !!top && (top === el || el.contains(top));
      return {
        x: Math.round(cx), y: Math.round(cy),
        tag: el.tagName, label: window.__wbHelper.text(el).slice(0, 60),
        hittable: hittable,
      };
    })()`),
  );

  if (!hit) return null;

  if (hit.hittable) {
    const dbg = ensureAttached(wc);
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hit.x, y: hit.y, button: 'none', clickCount: 0,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1,
    });
    await sleep(900);
    return { label: `${hit.tag}「${hit.label}」`, method: 'cdp-mouse', hittable: true };
  }

  // 元素不在视口内（或被别的东西盖住）：真实鼠标点不到，退化为页面侧 click()
  const done = await evaluate<boolean>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.find(${JSON.stringify(target)});
      if (!el) return false;
      el.click();
      return true;
    })()`),
  );
  await sleep(1200);
  return done
    ? { label: `${hit.tag}「${hit.label}」`, method: 'page-el.click', hittable: false }
    : null;
}

/**
 * type：聚焦输入框 → 清空 → 写入文字 → 可选提交。
 *
 * ⚠️ 为什么是「三层兜底 + 读回校验」而不是直接 Input.insertText：
 * 实测本机（虚拟机 / 远程桌面环境）**所有 CDP 文本注入路径都会静默失败** ——
 * `Input.insertText`、逐字符 `Input.dispatchKeyEvent`、`DOM.focus + insertText`
 * 执行后输入框的值仍然是空字符串，但**不报错**，非常容易误判成「输入成功了」。
 * （鼠标事件不受影响：`Input.dispatchMouseEvent` 靠命中测试路由，点击是正常的。）
 * 所以这里每写一次都读回 `el.value` 校验，失败就换下一种方式，并把实际用到的
 * 方式写进 `detail` 回报，避免"看着成功其实没输入"。
 */
async function typeInto(
  wc: Target,
  target: string,
  value: string,
  submit: boolean,
): Promise<{ ok: true; label: string; method: string } | { ok: false; reason: string }> {
  const found = await evaluate<{ tag: string; label: string; x: number; y: number } | null>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.find(${JSON.stringify(target)});
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      el.focus();
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        label: window.__wbHelper.text(el).slice(0, 60),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    })()`),
  );

  if (!found) return { ok: false, reason: `没找到可输入的输入框：${target}` };

  const dbg = ensureAttached(wc);

  /** 先补一次真实鼠标点击：不少站点（含百度的新版搜索框）靠 mousedown/focus 处理器才真正激活输入框 */
  if (found.x > 0 && found.y > 0) {
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1,
    });
  }

  /** 读回输入框当前的值，用于判断到底有没有写进去 */
  const readValue = async (): Promise<string> =>
    evaluate<string>(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.find(${JSON.stringify(target)});
        if (!el) return '';
        return String(('value' in el ? el.value : el.textContent) || '');
      })()`),
    );

  const written = async (): Promise<boolean> => (await readValue()).indexOf(value) >= 0;

  let method = 'none';

  // 1) CDP 真实输入：正常桌面环境下最接近真人操作
  await dbg.sendCommand('Input.insertText', { text: value });
  await sleep(250);
  if (await written()) method = 'cdp-insertText';

  // 2) 页面侧 execCommand：仍走 Chromium 编辑管线，beforeinput / input 事件都正常
  if (method === 'none') {
    await evaluate(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.find(${JSON.stringify(target)});
        if (!el) return false;
        el.focus();
        try { return document.execCommand('insertText', false, ${JSON.stringify(value)}); } catch (_) { return false; }
      })()`),
    );
    await sleep(250);
    if (await written()) method = 'page-execCommand';
  }

  // 3) 原生 setter + InputEvent：对 React 受控组件最稳的兜底
  if (method === 'none') {
    await evaluate(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.find(${JSON.stringify(target)});
        if (!el) return false;
        if ('value' in el) {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        } else if (el.isContentEditable) {
          el.textContent = ${JSON.stringify(value)};
        } else {
          return false;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`),
    );
    await sleep(250);
    if (await written()) method = 'native-setter';
  }

  if (method === 'none') {
    return {
      ok: false,
      reason: `输入框「${found.label}」找到了，但三种写入方式都没能写进去（读到的是空值）。`,
    };
  }

  if (submit) {
    const beforeUrl = wc.getURL();

    // 1) CDP 真实回车键（正常桌面环境下有效；本机键盘注入会静默失效）
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'char', key: 'Enter', text: '\r',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await sleep(1200);

    // 2) 页面侧合成 Enter 键事件（React 的 onKeyDown 认这个）
    if (wc.getURL() === beforeUrl) {
      await evaluate(
        wc,
        pageScript(`(() => {
          const el = window.__wbHelper.find(${JSON.stringify(target)});
          if (!el) return false;
          const opts = {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true,
          };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          return true;
        })()`),
      );
      await sleep(1500);
    }

    // 3) 最后兜底：直接提交所属表单
    if (wc.getURL() === beforeUrl) {
      await evaluate(
        wc,
        pageScript(`(() => {
          const el = window.__wbHelper.find(${JSON.stringify(target)});
          const form = el && el.form;
          if (form && form.requestSubmit) { form.requestSubmit(); return true; }
          return false;
        })()`),
      );
      await sleep(1200);
    }
  }

  return { ok: true, label: `${found.tag}「${found.label}」`, method };
}

/** scroll：整屏滚动 */
async function scrollPage(wc: Target, direction: 'up' | 'down'): Promise<void> {
  await evaluate(
    wc,
    pageScript(`(() => {
      const step = Math.round(window.innerHeight * 0.85) * ${direction === 'down' ? 1 : -1};
      window.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    })()`),
  );
  await sleep(500);
}

/** screenshot：CDP 截图，只回内存里的 data URL */
async function captureScreenshot(wc: Target): Promise<string> {
  const dbg = ensureAttached(wc);
  const res = (await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })) as {
    data?: string;
  };
  if (!res?.data) throw new Error('截图失败：CDP 没有返回图像数据');
  return `data:image/png;base64,${res.data}`;
}

// ---------------------------------------------------------------------------
// 执行器入口
// ---------------------------------------------------------------------------

/** 传入一个动作 → 在内嵌页执行 → 返回 { ok, pageSnapshot } */
export async function drive(action: BrowserAction, targetWebContentsId?: number): Promise<DriveResult> {
  const actionName = action.action;

  if (paused && PAUSED_BLOCKED.has(actionName)) {
    return {
      ok: false,
      action: actionName,
      error: `驾驶已暂停，「${actionName}」不会自动执行；你可以在内嵌页上自己点。`,
    };
  }

  let wc: Target;
  try {
    wc = resolveTarget(targetWebContentsId);
  } catch (err) {
    return { ok: false, action: actionName, error: (err as Error).message };
  }

  try {
    /** 补充说明（例如 type 实际用了哪种写入方式），会一路带到调试区 */
    let detail: string | undefined;

    switch (action.action) {
      case 'open_url': {
        await navigate(wc, action.url);
        detail = `已跳转到 ${wc.getURL()}`;
        break;
      }
      case 'click': {
        const hit = await clickTarget(wc, action.target);
        if (!hit) {
          return {
            ok: false,
            action: actionName,
            error: `没找到可点击的元素：${action.target}`,
            pageSnapshot: await readSnapshot(wc),
          };
        }
        detail = hit.hittable
          ? `已用真实鼠标点击 ${hit.label}`
          : `点击了 ${hit.label}（该元素不在视口内，真实鼠标点不到，改用页面侧 click()）`;
        break;
      }
      case 'type': {
        const result = await typeInto(wc, action.target, action.text, Boolean(action.submit));
        if (!result.ok) {
          return {
            ok: false,
            action: actionName,
            error: result.reason,
            pageSnapshot: await readSnapshot(wc),
          };
        }
        detail = `已向 ${result.label} 写入「${action.text}」（方式：${result.method}）`;
        break;
      }
      case 'scroll': {
        await scrollPage(wc, action.direction);
        detail = `已向${action.direction === 'down' ? '下' : '上'}滚动一屏`;
        break;
      }
      case 'wait': {
        await sleep(Math.min(Math.max(action.seconds, 0), 30) * 1000);
        detail = `等待了 ${action.seconds}s`;
        break;
      }
      case 'read_page': {
        break;
      }
      case 'screenshot': {
        const dataUrl = await captureScreenshot(wc);
        return {
          ok: true,
          action: actionName,
          detail: '已截图（只放在内存里，没有落库）',
          pageSnapshot: await readSnapshot(wc),
          screenshot: dataUrl,
        };
      }
      case 'ask_user':
      case 'done': {
        // 第 3 步只定类型，不接业务（不接大模型）
        return {
          ok: false,
          action: actionName,
          error: `「${actionName}」在第 3 步只定义了类型，还没有接业务逻辑。`,
        };
      }
      default: {
        return { ok: false, action: actionName, error: `未知动作：${String(actionName)}` };
      }
    }

    return { ok: true, action: actionName, detail, pageSnapshot: await readSnapshot(wc) };
  } catch (err) {
    return { ok: false, action: actionName, error: (err as Error).message };
  }
}
