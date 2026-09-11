# 第 2 步验收报告（内嵌 webview 版）：脸和门

日期：2026-09-11
范围：把上一版的「独立第二窗口」改成**主窗口右侧内嵌 `<webview>`**，直接显示真实网页。
不做：第 3 步、不接 AI / 登录 / 数据库、不动生产 CSP、不用 Playwright / CDP。

> 上一版（独立 BrowserWindow）已**整体废弃**，相关代码与截图已删除，避免两套方案并存造成混淆。

---

## 一、带回总控（已填）

| 项 | 结果 |
| --- | --- |
| 使用 | **webview**（不是 BrowserView）。`webviewTag: true` 已开，主窗口仍是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` |
| 独立窗 | **已去掉**。`createWorkbenchBrowser()` 整段删除，全程 `BrowserWindow.getAllWindows().length === 1` |
| 前端调用 | `window.workbench.openBrowser(url?)` / `showBrowser()` / `hideBrowser()` / `focusBrowser()` / `on(event, cb)` |
| 结论 | **可进入第 3 步** |

验收步骤逐条对照：

| 验收步骤 | 结果 |
| --- | --- |
| `npm run dev` | ✅ 一条命令起 Vite + Electron |
| 主窗口内右侧能渲染 example.com | ✅ guest 实际 URL = `https://example.com/`，视口 581×489 占满右栏 |
| 点「打开/查看浏览器」只显示/聚焦右侧区域，不再弹独立窗口 | ✅ 全程窗口数 = 1 |
| 聊天可发 | ✅ 气泡 3 → 4，输入框自动清空 |
| 暂停/继续/我来操作切换文案 | ✅ AI 正在控制 / 你正在控制 正确切换 |
| 暂停时右侧不可点击，继续后可点击 | ✅ 见下方「命中测试」 |
| `npm run build` | ✅ 通过 |
| `npm run start`（生产模式，额外验证） | ✅ 通过。走 `loadFile` 而不是 dev server，内嵌 webview 同样正常渲染 example.com |

截图：

- `docs/acceptance/step-2-main-window.png` —— 开发模式（含手打消息）
- `docs/acceptance/step-2-prod-main-window.png` —— **生产模式**（`npm run start`）。左下角那行
  `桥：win32 · pong from electron 33.4.11` 是渲染进程通过 preload 桥问回主进程的，证明生产模式下
  preload + IPC 也是通的；右侧是内嵌 webview 里的 example.com。

---

## 二、代码变更清单

| 文件 | 变更 |
| --- | --- |
| `apps/desktop/electron/main.ts` | 主窗口 webPreferences 加 `webviewTag: true`（其余安全项不动）；**删除**整个独立窗口模块（`createWorkbenchBrowser` / `openWorkbenchBrowser` / `focusBrowser` / `workbenchWindow`）；4 条 IPC 改为把指令转发回渲染层 |
| `apps/desktop/electron/preload.ts` | 桥新增 `openBrowser(url?)` / `showBrowser` / `hideBrowser` / `focusBrowser` / `on(event, cb)`（`on` 返回取消订阅函数） |
| `packages/shared/src/index.ts` | `WorkbenchBridge` 同步扩展；新增 `BrowserEvent = 'open' \| 'show' \| 'hide' \| 'focus'` |
| `apps/desktop/src/global.d.ts` | 补 `JSX.IntrinsicElements.webview` 类型（React 不认识这个标签） |
| `apps/desktop/src/App.tsx` | 右栏改为「文案 + 控制 + 任务卡 + 内嵌浏览器区域」；新增 `browserVisible` / `browserMounted` / `browserUrl` 状态与 4 个订阅；`pointerEvents` 由 controller 决定 |
| `apps/desktop/src/styles.css` | `.right` 改为 `flex: 0 1 50vw`（浏览器区域要占满），新增 `.browserArea*` 样式 |

主进程侧只做转发：

```ts
function sendToMainWindow(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

ipcMain.handle('workbench:open',  (_e, url?: string) => sendToMainWindow('workbench:browser:open', url));
ipcMain.handle('workbench:show',  () => sendToMainWindow('workbench:browser:show'));
ipcMain.handle('workbench:hide',  () => sendToMainWindow('workbench:browser:hide'));
ipcMain.handle('workbench:focus', () => sendToMainWindow('workbench:browser:focus'));
```

---

## 三、踩到的坑（本步最值钱的一条）

**把 `<webview>` 的 `display` 覆盖成 `block`，guest 视图会永久卡在 150px 高。**

症状：元素 `getBoundingClientRect()` 明明是 581×489，但网页只画在上面一小条里，右边还挂着滚动条。
一开始怀疑是截图工具（PrintWindow 截不到 OOPIF），换整屏截图对照后确认是**真实渲染问题**。

实测对照（同一元素，只改 CSS）：

| 写法 | 元素高 | guest 视口高 |
| --- | --- | --- |
| `display: block`（原写法） | 489 | **150** ❌ |
| `display: flex` | 489 | **489** ✅ |
| `display: inline-flex` | 489 | **489** ✅ |
| `display: block` + 内联 `height: 489px` | 489 | **150** ❌ |
| `display: block` + 尺寸微调 nudge | 489 | **150** ❌ |

结论：`<webview>` 内部要靠 flex 才能把 guest 撑开，`block` 会让它退化成默认的 150px，且**给死高度也救不回来**。
所以最终写法是 CSS 里不写 `display`，由内联 style 控制 `display: flex / none`：

```tsx
style={{ display: browserVisible ? 'flex' : 'none', pointerEvents }}
```

显隐往返、换 URL 往返之后，guest 视口都稳定保持在 489（见下方 `sizing` 证据）。

---

## 四、验收证据（探针从真实进程读回，验完已删除）

### 1. 桥 + 安全

```json
{
  "bridgeKeys": ["appVersion","focusBrowser","hideBrowser","on","openBrowser","ping","platform","showBrowser"],
  "leakedRequire": false, "leakedProcess": false, "leakedIpc": false,
  "webviewTagEnabled": true, "webviewCtorName": "WebViewElement"
}
```

### 2. 内嵌网页 + 独立分区

```json
{
  "webviewSrcAttr": "https://example.com",
  "webviewPartitionAttr": "persist:workbench-browser",
  "webviewGuestUrl": "https://example.com/",
  "webviewGuestId": 3,
  "guest": { "sessionIsMainSession": false, "sessionIsWorkbenchPartition": true }
}
```

guest 的 session 既**不是**主窗口的 session，又**正好等于** `persist:workbench-browser` 分区 —— 独立会话成立。

### 3. 尺寸（修复后）

```json
{
  "afterMount":        {"elementW":581,"elementH":489,"guestW":581,"guestH":489},
  "afterHideShow":     {"elementW":581,"elementH":489,"guestW":581,"guestH":489},
  "afterUrlRoundTrip": {"elementW":581,"elementH":489,"guestW":581,"guestH":489},
  "final":             {"elementW":581,"elementH":489,"guestW":581,"guestH":489}
}
```

### 4. 命中测试（暂停时不可点 / 继续后可点）

在 webview 正中心取点，读 Chromium 的命中结果：

| 状态 | 大字文案 | `pointer-events` | `elementFromPoint(中心)` |
| --- | --- | --- | --- |
| 初始 / 点「继续」 | AI 正在控制 | `none` | `div`（**跳过 webview**） |
| 点「我来操作」/「暂停」 | 你正在控制 | `auto` | `webview`（**命中 webview**） |
| 再点「继续」 | AI 正在控制 | `none` | `div` |

同一坐标、唯一变量是 controller，命中结果在 `div` ↔ `webview` 之间切换 —— 说明 `pointer-events: none` 真的改变了浏览器命中测试，不只是改了个属性值。

**量具校准**：先往 guest 里塞一个合成点击，计数器 `1`；说明计数器本身有效，上面那组结果不是「量具坏了」。

### 5. 显隐 / 聚焦 / 带 url 打开（全走 preload → IPC → 主进程 → 渲染层）

```json
{
  "hideResult": "ok", "displayAfterHide": "none",
  "showResult": "ok", "displayAfterShow": "flex",
  "focusResult": "ok",
  "openWithUrlResult": "ok",
  "urlAfterOpenWithUrl": "https://example.org/",
  "urlRestored": "https://example.com/"
}
```

`openBrowser(url)` 的 url 参数确实一路传到了 webview 并触发导航。

### 6. 不再有独立窗口

```json
{ "windowCountAfterBoot": 1, "windowCountAfterAll": 1, "windowTitles": ["AI 工作台"] }
```

### 7. 收尾状态（截图时）

```json
{ "redDot": true, "banner": "AI 正在控制", "pointerEvents": "none", "display": "flex" }
```

---

## 五、一个说清楚的局限

**「真实鼠标点到 webview 上」这条链路没能端到端注入验证。** 原因：

- `webContents.sendInputEvent` 注入到主窗口时**不会穿透到 OOPIF guest**（这是 Electron 的合成输入路径限制，实测 AI 态和用户态都是 0 次点击）；
- 这台机器桌面被其它应用抢前台，OS 级鼠标点击本身就不可靠（点 4 次按钮全落空过）。

所以命中测试改用 `document.elementFromPoint()` —— 它走的**就是** Chromium 的命中测试逻辑，和真实鼠标同一套代码路径。
另外说明一点：这类「负向」断言（点击**不应该**生效）即使做成 OS 级点击也无法证伪，因为「被挡住」和「压根没点到」无法区分；`elementFromPoint` 反而是更严谨的证据。

如果你在真机上手动点一下发现行为不一致，请告诉我，我再补 `BrowserView` 或遮罩层方案。

---

## 六、已知限制

- ⚠️ **本报告里「`pointer-events: none` 表示 AI 控制中」是第 2 步的设计，第 3 步已废弃。**
  那个写法会让 Chromium 命中测试跳过 guest，导致「程序停了自动操作，用户也一起点不动」。
  现在 webview 恒为 `pointer-events: auto`，「停自动操作」只由主进程执行器的 `paused` 开关负责。
  详见 `step-3-p0-input-验收报告.md`。
- 消息只活在内存里，刷新即丢（本步要求如此）。
- 内嵌区域没有任何导航 UI（地址栏 / 后退），换页面只能通过 `openBrowser(url)`。
- 隐藏时用 `display: none`，webview 的 guest 进程仍在（不重新加载），但会随 `browserMounted` 保留挂载。
- 生产 CSP 仍未加（沿用第 1 步结论，避免打断 Vite HMR）。
- `apps/server` 依然是空占位。
