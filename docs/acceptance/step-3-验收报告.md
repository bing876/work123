# 第 3 步验收报告 · 遥控器先通（本地驾驶，不接 AI）

日期：2026-09-11
范围：让程序能驾驶主窗口右栏那块**内嵌 webview**（打开网址 / 点击 / 输入 / 滚动 / 读页面 / 暂停）。
不接大模型、不登录、不做后端、不重做 UI。

---

## 一、结论速览（对照验收清单）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 点调试按钮后，右侧内嵌区域自己打开真实网页（离开 example.com） | ✅ | `open_url` → `https://www.baidu.com/`，标题「百度一下，你就知道」 |
| 能输入 | ✅ | 输入框 `value` 读回为 `AI 工作台`（独立于回执二次核对） |
| 能点击，且用户看得见页面在动 | ✅ | 点「百度一下」→ 跳到 `…/s?wd=AI+工作台…`，标题 `AI 工作台_百度搜索` |
| 能滚动 | ✅ | `window.scrollY` 由 `0` → `147` |
| 能读页面 | ✅ | 返回 url / title / 可见按钮 / 链接 / 输入框文字 |
| 点暂停后程序不再自动点 | ✅ | 暂停后 `click` 回执 `ok:false`，错误文案：「驾驶已暂停，「click」不会自动执行」 |
| 暂停后用户能在内嵌页上自己点 | ✅ | 暂停按钮同时把 `controller` 切到「你正在控制」，内嵌页 `pointer-events: auto` |
| 没有再弹出独立「工作台浏览器」窗口 | ✅ | `BrowserWindow.getAllWindows().length === 1`（驾驶全程与结束后都是 1） |

**产物**：

- `docs/acceptance/step-3-main-window.png` —— 主窗口整窗截图（三栏 + 调试区 + 右栏内嵌真实网页）
- `docs/acceptance/step-3-driven-page.png` —— 被驾驶页面的 CDP 截图（百度搜索结果，搜索框里就是程序输入的字）

---

## 二、驾驶是否成功

成功。执行器形态按约定实现：**传入一个动作 → 在内嵌页执行 → 返回 `{ ok, pageSnapshot }`**。

一次完整链路（用临时探针从**真实渲染进程**点调试区按钮，走
`DOM click → React handler → preload → ipcRenderer → 主进程 → CDP → 内嵌 webview`）：

```
open_url   https://www.baidu.com     → ok:true  title「百度一下，你就知道」
type       #kw, textarea#chat-textarea  text「AI 工作台」
           → ok:true  detail「已向 TEXTAREA「…」写入「AI 工作台」（方式：page-execCommand）」
           → 独立读回输入框 value = 「AI 工作台」   ← 不只看回执
click      #su, button#chat-submit-button
           → ok:true  URL 变为 https://www.baidu.com/s?...&wd=AI+工作台…
                      title 变为「AI 工作台_百度搜索」
scroll     down → scrollY 0 → 147
read_page  → url / title / 按钮(4) / 链接(40) / 输入框(1: value=AI 工作台)
screenshot → 得到 PNG data URL（只放内存，未落库）
```

另外单独验证了**真实鼠标点击**这条主路径（在 example.com 上点居中的链接）：

```
click  a  → ok:true  detail「已用真实鼠标点击 A「Learn more」」
          → https://example.com → https://www.iana.org/help/example-domains
```

---

## 三、调试用了哪个网站

- 主流程：**百度**（`https://www.baidu.com`）—— 打开 / 输入 / 点击搜索 / 滚动 / 读取 / 截图
- 真实鼠标点击路径：**example.com** → 点击后跳到 `iana.org/help/example-domains`（目标链接居中、必定在视口内）
- 默认落地页仍是 `example.com`，没有改动第 2 步的默认行为

---

## 四、pause 是否生效

生效，且是**双层**的：

1. **执行器层**：主进程持一个 `paused` 开关，暂停后 `click` / `type` 直接拒绝执行，
   回执 `ok:false`，错误文案明确告诉用户「你可以在内嵌页上自己点」。
   `open_url` / `scroll` / `read_page` / `screenshot` 不受影响（暂停的语义是"别再自己动手点/输入"）。
2. **界面层**：点「暂停」同时把控制权切到「你正在控制」，内嵌 webview 的 `pointer-events`
   恢复 `auto`，用户可以直接用鼠标点内嵌页。

实测：暂停后点「3 点击搜索」→ `ok:false` + 上述文案；点「7 继续驾驶」后状态回到「驾驶中」。

---

## 五、用的是 webview 还是 BrowserView

**webview**（延续第 2 步，未改）。

- 主窗口 `webPreferences.webviewTag: true`，右栏是 `<webview partition="persist:workbench-browser">`
- 驾驶目标是它的 **guest webContents**：渲染层用 `webview.getWebContentsId()` 拿 id，
  主进程 `webContents.fromId(id)` 取回，校验 `getType() === 'webview'` 后才挂 `debugger`（CDP 1.3）
- 取不到 id 时回退为扫描 `webContents.getAllWebContents()` 里的 `webview` 类型
- 全程**没有创建任何 BrowserWindow**，没有 Playwright / Puppeteer，没有第二份 Chrome

---

## 六、已知选择器 / CDP / 权限问题（本步最值钱的部分）

### 1. ⭐ 本机 CDP 文本注入会**静默失败**

在**内嵌 webview 的 guest** 上实测 7 种输入方式（写完后读回 `el.value` 判定）：

| 策略 | 结果 |
| --- | --- |
| `el.focus()` + `Input.insertText` | ❌ 值仍为空 |
| `guest.focus()` + `el.focus()` + `Input.insertText` | ❌ |
| `Page.bringToFront` + `el.focus()` + `Input.insertText` | ❌ |
| 逐字符 `Input.dispatchKeyEvent` | ❌ |
| `DOM.focus`（CDP）+ `Input.insertText` | ❌ |
| `document.execCommand('insertText', …)` | ✅ |
| 原生 setter + `InputEvent('input')` | ✅ |

关键点：失败的几种**都不报错**，回执看起来像成功了。所以 `type` 现在做成
「三层兜底 + 每次写回后读回校验」：

1. `Input.insertText`（正常桌面环境下最接近真人）
2. `document.execCommand('insertText')`（仍走 Chromium 编辑管线，`beforeinput` / `input` 事件正常）
3. 原生 setter + `InputEvent` + `change`（对 React 受控组件最稳）

三种都写不进去就返回 `ok:false`，并在 `detail` 里回报实际用的是哪一种 —— 避免"假成功"。

> 注意：CDP **鼠标**事件不受影响（`Input.dispatchMouseEvent` 靠命中测试路由，实测有效）。
> 只有**键盘 / 文本**注入受影响。另外 `Input.insertText` 并非 100% 失败，偶发能成（焦点状态相关），
> 所以不能靠"试一次成功"就断定可用，必须读回校验。

### 2. ⭐ 点击必须做命中测试，否则会"假成功"

内嵌页视口实测只有 **551px 宽**（右栏 50vw），而百度首页那排搜索 UI 固定 **771px 宽**，
把「百度一下」按钮挤到了视口**右侧外面**（页面自己也提示「请按"回车"键发起检索」）。

此时 `Input.dispatchMouseEvent` 发出的坐标命不中任何元素 —— 点击静默失败但回执仍是 `ok:true`。
现在 `click` 会先算元素中心的 `elementFromPoint`：

- 命中（落点在视口内且真压在目标上）→ 走真实鼠标事件，`detail` 写「已用真实鼠标点击 …」
- 命不中 → 退化为页面侧 `el.click()`，`detail` 明确写「该元素不在视口内，真实鼠标点不到，改用页面侧 click()」

### 3. ⭐ 选择器要"取第一个**可见**的匹配"

百度首页同时存在两套搜索 UI：隐藏的经典搜索框（`#kw` / `#su`，祖先 `display:none`，量出来 0×0）
排在**前面**，可见的新版 AI 搜索框（`#chat-textarea` / `#chat-submit-button`）排在后面。

- `document.querySelector('#kw, textarea#chat-textarea')` 会返回**不可见**的 `#kw` → 误判"找不到元素"
- 正解：遍历 `querySelectorAll` 的**所有**匹配，取第一个通过可见性检查的
- 调试区因此把选择器写成逗号列表 `'#kw, textarea#chat-textarea'`，两种版式都能命中

可见性判据：`getBoundingClientRect()` 宽高 > 0 且 `display !== none`、`visibility !== hidden`、`opacity > 0`。

### 4. 权限 / 其他

- 渲染进程全程**没有** `require('electron')`；`contextIsolation: true`、`nodeIntegration: false` 未动
- 新增能力只走 preload 白名单：`drive` / `readPage` / `pauseDriving` / `resumeDriving`
- `Runtime.evaluate` 带 `userGesture: true`，减少站点对"非用户手势"的限制
- 内嵌 webview 默认拒绝 `window.open`；本次驾驶全程 `setWindowOpenHandler` 未收到任何弹窗请求，
  说明不是被弹窗拦截挡住了跳转（这条排除了一个常见误判）
- 本机仍需 `--no-sandbox` 回退才能启动 Electron（环境限制，非代码问题，见用户级 MEMORY）

---

## 七、建议

**可以进入第 4 步。**

留给第 4 步的接口已经就位：`BrowserAction` 里 `ask_user` / `done` 只定义了类型、执行器返回
「只定义了类型，还没有接业务逻辑」，等第 4 步接上任务编排后再填实现。

进入第 4 步前建议顺手确认一件事：内嵌页视口只有 551px 宽，很多站点会横向溢出
（百度首页就是）。如果后面的步骤要驾驶"完整桌面版"页面，得先决定是
**加宽右栏**（属于前端 UI 的事）还是**接受窄视口**并在选择器/命中测试上继续兜底。
