# 第 3 步 P0 复验：暂停后内嵌页不能点 / 链接要能打开

日期：2026-09-12（凌晨）
范围：只修「暂停后用户点不动内嵌页」和「点链接打不开」。未做多标签、真浏览器外壳、AI、抖店，未重做 UI。

---

## 根因

1. **主根因（`apps/desktop/src/App.tsx`）**：`controller === 'ai'` 时给 `<webview>` 写了
   `pointer-events: none`。这会让 Chromium 命中测试直接跳过 guest —— 页面看得见，但鼠标点不到。
   结果是「程序停了自动点击，用户也一起被锁死」。
2. **链接打不开（`apps/desktop/electron/main.ts` + webview 属性）**：搜索结果常带
   `target="_blank"`。webview 不带 `allowpopups` 时，这个请求根本到不了主进程；到得了若只是
   `deny`，页面看起来就是「点了没反应」。
3. **同步导航会被丢**：在处理函数里直接 `loadURL(url)`（不放到下一个 tick）时导航经常被丢弃，
   同样表现为「点了没反应」。

## 改动（最终留在代码里的就这三处）

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/App.tsx` | webview 恒为 `pointer-events: auto`；加 `allowpopups` |
| `apps/desktop/electron/main.ts` | `app.on('web-contents-created')` 中对 `getType() === 'webview'` 的 guest 设 `setWindowOpenHandler`：只放行 `^https?://`，`setImmediate` 后 `contents.loadURL(url)`，一律 `deny` |
| `apps/desktop/electron/driver.ts` | 第 3 步的 CDP 执行器（`type` 三层兜底 + 读回校验；`click` 先命中测试再降级） |

「停止自动 click/type」只由主进程执行器的 `paused` 开关负责，**不再用 CSS 挡用户鼠标**。

## 代码审查清单

- [x] 全仓检索 `pointer-events` / `ignoreInputEvents` / `setIgnoreMouseEvents` / `ignore-mouse`
- [x] 暂停与「我来操作」走同一条路径：主进程 `pauseDriving()` + UI 控制权转用户
- [x] 「继续驾驶」只恢复程序自动操作，不抢用户输入
- [x] 黄框调试区、截图缩略图、示例任务卡都在正常 flex 流中，没有 absolute/fixed 覆盖层
- [x] 没有给整个右栏加 `pointer-events: none`
- [x] 主窗口的 `will-navigate` 拦截**只作用于主窗口**，不影响 guest
- [x] 全程 `BrowserWindow` 数量 = 1，没有系统 Edge / Chrome

---

## 证据口径（重要，请先看这个）

| 验证方式 | 用过 | 结论能否代表「真人手点」 |
| --- | --- | --- |
| 从主窗口 DOM 触发按钮 → React → preload → IPC → 主进程 → CDP | ✅ | 代表**程序自己驾驶**这条链路 |
| 对 guest `webContents.sendInputEvent` 送鼠标/键盘/滚轮 | ✅ | ❌ **不代表**。这是注入事件，用户已明确不认 |
| 真鼠标（SendInput / mouse_event / Playwright） | 试过 | ❌ 用户已禁止，相关脚本已删除 |
| **用户本人手点** | ✅ 用户反馈 | ✅ 唯一有效口径 |

所以下表的「过」指**程序链路可用**；「用户手点」一栏以用户自己的反馈为准。

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 程序能 `open_url` 直接打开指定网站 | ✅ | open_url → 百度 / example.com，标题正确 |
| 读页面能读到新网址 | ✅ | `read_page` 返回新 url + title |
| 不弹窗（`BrowserWindow` = 1） | ✅ | 全程与结束时均为 1 |
| 暂停后程序不再自动 click/type | ✅ | 回执 `ok:false` + 明确文案 |
| 暂停后输入/滚动能进 guest | ✅（注入口径） | guest 焦点与 `value` 读到手输内容；`scrollY 0→960` |
| **用户手点 example.com 的 Learn more** | ✅ | **用户确认：「example.com 的 Learn more 能进」** |
| 用户手点百度结果蓝色标题 | ❌ | 用户确认仍停在搜索页 → 见「已知问题」 |

## 三态

| 状态 | 程序自动 click/type | 用户手点内嵌页 |
| --- | --- | --- |
| 暂停驾驶 | 被主进程执行器拒绝 | 可点（webview 恒可接收鼠标） |
| 我来操作 | 同上，同一条路径 | 可点 |
| 继续驾驶 | 恢复 | 仍然可点（不再被 CSS 抢走） |

---

## 已知问题（不挡收工）

1. **百度结果蓝色标题，用户手点点不进去。**
   根因：内嵌页视口只有约 **551px** 宽（右栏 50vw），而百度那排搜索 UI 固定 **771px** 宽，
   标题被挤到视口右侧外面，命中测试过不了。
   程序自己驾驶时有 `el.click()` 降级可以绕过；**用户手点没有降级**。
   要根治只能加宽右栏——属于前端 UI，第 3 步不动。
2. `read_page` 只返回 url / title / 可见按钮 / 链接 / 输入框，正文抽取偏弱。
3. 右栏窄导致很多桌面站点横向溢出（同 #1）。

## 事故记录（必须留在案）

验证过程中我写过一段「关闭干扰窗口」的代码，按窗口类名 `Chrome_WidgetWin_1` 批量关窗，
**误关了用户正在使用的浏览器 / VS Code / WorkBuddy 窗口**。该代码已删除。
约束：以后任何关窗逻辑只能限定为「同一进程 + 标题精确匹配本应用窗口」。

## 结论

按用户改定的收工标准：**open_url ✅、读页面能读新网址 ✅、不弹窗 ✅、用户手点 example.com 链接 ✅（用户亲测）**。
百度蓝标题记为已知问题，不挡收工。
