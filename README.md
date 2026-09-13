# AI 工作台（ai-workbench）

Electron + React + TypeScript + Vite 的桌面应用，npm workspaces monorepo 结构。

当前进度：**第 3 步「遥控器先通（本地驾驶）」已完成**。

一条命令同时拉起 Vite 和 Electron，主窗口是一个**简易聊天界面**（左联系人「小助」/ 中聊天 / 右控制区 + 任务卡片），
右侧那一栏**内嵌一个 `<webview>`**，能直接显示真实网页（默认 example.com）—— 不是独立窗口，也不是 iframe。

第 3 步让程序能**驾驶这块内嵌页**：打开网址 / 点击 / 输入 / 滚动 / 读页面 / 暂停。
驱动方式是主进程 `webContents.debugger`（CDP），右栏底部有一块**很丑的调试区**用来验证。
**不接大模型**（`ask_user` / `done` 只定义了类型）。

数据全部只活在内存里（刷新即丢）；尚未接入 AI、登录、数据库。

---

## 目录结构

```
ai-workbench/
├── package.json                    # 根 workspace，统一 dev / build / typecheck 入口
├── tsconfig.base.json              # 共享 TS 编译基线
├── scripts/
│   └── clean.mjs                   # 清理各包构建产物
├── apps/
│   ├── desktop/                    # 前端 + Electron
│   │   ├── package.json
│   │   ├── index.html              # Vite 入口 HTML
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json           # 渲染进程（DOM + JSX）
│   │   ├── tsconfig.electron.json  # 主进程 / preload（CommonJS + Node）
│   │   ├── scripts/
│   │   │   └── start-electron.mjs  # Electron 启动包装器（见「关于启动包装器」）
│   │   ├── electron/
│   │   │   ├── main.ts             # 主进程：建主窗口、注册 IPC（浏览器区域靠 IPC 转发驱动）
│   │   │   ├── driver.ts           # 第 3 步：本地驾驶执行器（webContents + CDP）
│   │   │   └── preload.ts          # 安全桥：contextBridge 白名单
│   │   └── src/
│   │       ├── main.tsx            # React 挂载
│   │       ├── App.tsx             # 简易聊天界面（假数据 / 内存态）+ 任务卡片 + 第 3 步调试区
│   │       ├── styles.css
│   │       └── global.d.ts         # window.workbench 类型声明
│   └── server/                     # 后端，暂为空（只有 README）
│       └── README.md
├── docs/
│   └── acceptance/                 # 各步验收证据（截图 + 报告）
└── packages/
    └── shared/                     # 跨端共享 TypeScript 类型
        ├── package.json
        ├── tsconfig.json
        └── src/index.ts            # ChatMessage / ChatSession / WorkbenchBridge / BrowserAction
```

---

## 环境要求

- Node.js ≥ 18（本项目在 Node 22 + npm 10 上验证通过）

---

## 安装

```bash
npm install
```

首次安装会下载 Electron 二进制（约 100MB），耗时可能几分钟，属于正常现象。

---

## 打包与本机安装（第 12 步）

桌面安装包只包含 Electron 主窗口和已经编译的桌面界面；**不会**打包 `apps/server`、Postgres 数据、`.env` 或任何 API Key。后端仍按 [`apps/server/README.md`](apps/server/README.md) 在用户本机单独启动，保持现有的 Postgres + `apps/server` 架构。

```bash
npm run package
```

该命令会先编译共享类型、Electron 主进程和 Vite 渲染页面，再由 `electron-builder` 为**当前操作系统**生成可安装产物。默认输出目录是 `apps/desktop/release/`（已忽略，不进 Git）：

| 当前系统 | 产物 | 打开方式 |
| --- | --- | --- |
| Windows | `AI-Workbench-<version>-win-<arch>.exe` | 双击 NSIS 安装程序，安装后从开始菜单打开“AI 工作台” |
| macOS | `AI-Workbench-<version>-mac-<arch>.dmg` | 打开 DMG，将“AI 工作台”拖进 Applications 后启动 |
| Linux | `AI-Workbench-<version>-linux-<arch>.AppImage` | `chmod +x <产物>.AppImage && ./<产物>.AppImage` |

只想检查打包后的目录布局、不生成安装器时可运行 `npm run package:dir`。打包后打开的是安装产物中的 `dist-electron/main.js` 与 `dist/index.html`，不依赖 `npm run dev` 或 Vite；它仍只创建一个主窗口，右栏网页仍由现有 `<webview partition="persist:workbench-browser">` 内嵌。

> 打开安装包前，请先按后端 README 起好 Postgres 和 `npm run dev:server`。桌面包连接本机 `http://127.0.0.1:8787`，后端未启动时会按现有登录界面给出连接提示，而不会在安装包中携带服务端密钥。

---

## 启动（开发模式）

```bash
npm run dev
```

这一条命令做了三件事：

1. 编译 `packages/shared`（共享类型先产出 `.d.ts`，desktop 才能引用）
2. 并行启动 **Vite Dev Server**（http://localhost:5173）和 **Electron**
3. Electron 等 5173 端口就绪后打开主窗口，加载 React 页面

窗口里应当看到三栏：

- **左**：联系人「小助」（头像占位 + 右上角红点，可用「切换红点」按钮开关）；底部一行 `桥：win32 · pong from electron 33.x.x` —— 这是渲染进程通过 preload 桥向主进程发 IPC 问回来的，说明整条链路是通的。
- **中**：聊天区，开场有 3 条写死的假消息；底部输入框**能发**，发送后气泡追加到列表（仅内存，刷新即丢；空消息回车不会追加）。
- **右**：顶部大字「AI 正在控制 / 你正在控制」；下面「暂停 / 继续 / 我来操作」三个按钮**只改这行文案**，同时决定内嵌网页能不能点，并**暂停 / 恢复驾驶**；再下面是任务卡片「示例任务 · running」，带「打开工作台浏览器 / 聚焦浏览器 / 显示 / 隐藏」四个按钮；再下面是**第 3 步调试区**（8 个按钮）；最下面是**内嵌浏览器区域**。

点「打开工作台浏览器」后，右栏下半部分会渲染真实网页（默认 example.com），**不会弹任何新窗口**。

**内嵌页任何时候都能用鼠标点。**「暂停 / 我来操作」只做一件事：让程序停止自动 `click` / `type`，
把页面交还给你；「继续」只恢复程序自动操作。**不要用 CSS 去挡 webview 的鼠标**（早期版本用
`pointer-events: none` 表示「AI 控制中」，结果是程序停了、用户也点不动，已废弃）。
内嵌页里的 `target=_blank` / `window.open` 也不会开新窗口，而是在**当前内嵌页**直接打开（见下节）。

第 3 步调试区（丑是故意的，UI 统一留给前端会话）从左到右：

| 按钮 | 做什么 |
| --- | --- |
| 1 打开百度 | `open_url` → 内嵌页跳到 `https://www.baidu.com` |
| 2 在搜索框输入 | `type` → 往可见的搜索框写入「AI 工作台」 |
| 3 点击搜索 | `click` → 点「百度一下」，页面跳到搜索结果 |
| 4 向下滚动 | `scroll` → 向下滚一屏 |
| 5 读取页面 | `read_page` → 把 url / title / 可见按钮 / 链接 / 输入框文字显示在主窗口 |
| 6 暂停驾驶 / 7 继续驾驶 | 暂停后 `click` / `type` 不再自动执行，把页面交还给用户 |
| 8 截图 | `screenshot` → CDP 截图，只放内存（缩略图显示在调试区） |

关闭窗口即退出；终端 `Ctrl + C` 会同时结束 Vite 和 Electron。

> 改 `electron/main.ts` 或 `preload.ts` 后需要重启 `npm run dev`（主进程不做热重载）；改 `src/` 下的 React 代码会即时热更新。

---

## 其他命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式：Vite + Electron 一起起 |
| `npm run build` | 编译共享包 + 主进程 + 渲染进程产物 |
| `npm run start` | 先构建，再以生产模式打开窗口（加载 `dist/index.html`） |
| `npm run package` | 编译桌面端并用 electron-builder 生成当前系统的安装包到 `apps/desktop/release/` |
| `npm run package:dir` | 编译桌面端并生成 unpacked 目录（不产出安装器），用于检查包内文件布局 |
| `npm run typecheck` | 全量 TypeScript 类型检查 |
| `npm run clean` | 清理各包的 `dist` / `dist-electron` |

---

## 安全设计

主进程创建窗口时使用：

```ts
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,   // 渲染进程与 preload 上下文隔离
  nodeIntegration: false,   // 渲染进程拿不到 Node
  sandbox: true,            // 开启 Chromium 沙箱
  webSecurity: true,
}
```

渲染进程**没有** `require` / `process` / `ipcRenderer`，只能用 `preload.ts` 里白名单暴露的 `window.workbench`：

```ts
contextBridge.exposeInMainWorld('workbench', {
  platform,                                       // 平台标识
  appVersion,                                     // 版本号
  ping: () => ipcRenderer.invoke('app:ping'),     // 自检
  openBrowser: (url?: string) => ipcRenderer.invoke('workbench:open', url),
  showBrowser: () => ipcRenderer.invoke('workbench:show'),
  hideBrowser: () => ipcRenderer.invoke('workbench:hide'),
  focusBrowser: () => ipcRenderer.invoke('workbench:focus'),
  // 第 3 步：驾驶内嵌页（动作进 → 结果出）
  drive: (action, targetWebContentsId?) => ipcRenderer.invoke('workbench:drive', action, targetWebContentsId),
  readPage: (targetWebContentsId?) => ipcRenderer.invoke('workbench:read-page', targetWebContentsId),
  pauseDriving: () => ipcRenderer.invoke('workbench:pause-driving', true),
  resumeDriving: () => ipcRenderer.invoke('workbench:pause-driving', false),
  // 订阅主进程转发过来的 UI 指令，返回取消订阅函数
  on: (event, cb) => { /* ipcRenderer.on(`workbench:browser:${event}`, ...) */ },
});
```

新增能力时三处齐了才算打通：主进程 `ipcMain.handle('xxx', ...)` 注册 → preload 加一个方法转发 → `packages/shared` 的 `WorkbenchBridge` 接口补类型。

主进程另外做了两件防护：外链一律交给系统浏览器（`setWindowOpenHandler` 拒绝应用内开窗），并阻止**主窗口**被导航到外部站点（`will-navigate`）。

---

## 内嵌工作台浏览器

主窗口的 `webPreferences` 里开了 `webviewTag: true`，右栏那个 `<webview>` 就是这个开关的直接产物：

```tsx
<webview
  src={browserUrl}
  partition="persist:workbench-browser"   // 独立持久化会话，与主窗口隔离
  style={{ display: browserVisible ? 'flex' : 'none', pointerEvents }}
/>
```

四个实现要点：

1. **主进程不建窗口，只做转发**。渲染进程发 `openBrowser(url)` → 主进程 → `mainWindow.webContents.send('workbench:browser:open', url)` → 渲染层订阅到之后显示/导航。
   绕这一圈是为了将来让任务系统、快捷键或主进程侧逻辑也能驱动这块区域。
2. **`display` 必须是 `flex`，不能是 `block`**。`<webview>` 内部靠 flex 才能把 guest 视图撑开；一旦被覆盖成 `block`，
   guest 会永久卡在默认的 **150px** 高（元素量出来 489px 也没用，给死高度都救不回来）。踩过一次，详见验收报告。
3. **webview 的 `pointer-events` 恒为 `auto`**。曾经的写法是「AI 控制中 → `none`」，看起来合理，
   实际后果是**程序停了自动操作，用户也一起点不动**（命中测试直接跳过 guest）。
   「谁能操作网页」不是 CSS 说了算，而是主进程执行器里的 `paused` 开关：它只拦程序自己的
   `click` / `type`，不碰用户的鼠标。
4. **会话隔离靠 `partition`**。guest 的 session 既不是主窗口的 session，又正好等于 `persist:workbench-browser` 分区。
5. **内嵌页要能像浏览器一样开新链接**。`<webview>` 带 `allowpopups`，主进程对所有 webview guest
   注册 `setWindowOpenHandler`：只放行 `^https?://`，`setImmediate` 后让**当前 guest** `loadURL(url)`，
   然后 `deny`。这样点 `target=_blank` 的结果链接是在右栏当前页打开，**不会冒出新窗口**。
   两个细节都不能省：不加 `allowpopups` 请求根本到不了主进程；不放 `setImmediate` 而在处理函数里
   同步 `loadURL`，导航会被丢弃（表现就是「点了没反应」）。

`openBrowser` / `showBrowser` / `hideBrowser` / `focusBrowser` 都在主进程侧只做一次 `webContents.send`，渲染进程碰不到 `BrowserWindow`。

---

## 第 3 步：本地驾驶（遥控器先通，不接 AI）

目标：让程序能驾驶**上面那块内嵌 webview**（不是独立窗口、不是云端浏览器、不引入 Playwright / Puppeteer）。

### 链路

```
渲染层  window.workbench.drive(action, webviewId?)
          ↓ ipcRenderer.invoke
主进程  ipcMain.handle('workbench:drive')  →  electron/driver.ts
          ↓ webContents.fromId(webviewId)   ← 拿 guest webContents
          ↓ webContents.debugger.attach('1.3')   ← CDP
内嵌页  Runtime.evaluate / Input.dispatchMouseEvent / Page.captureScreenshot
          ↓
返回    { ok, action, detail?, pageSnapshot?, error?, screenshot? }
```

- 驾驶目标 = 内嵌 webview 的 **guest webContents**。渲染层用 `webview.getWebContentsId()` 拿 id 传过来；
  主进程校验 `getType() === 'webview'` 才用，拿不到就回退为扫描 `getAllWebContents()`。
- 渲染进程**全程没有** `require('electron')`；`contextIsolation: true` 保持不变，能力只从 preload 白名单进来。
- 全程**不创建任何 BrowserWindow**。

### 动作表

| action | 含义 | 备注 |
| --- | --- | --- |
| `open_url` | 内嵌页跳转到指定 url | 等 `did-stop-loading`，超时 30s |
| `click` | 按 target 点击 | 先做命中测试，命中走真实鼠标事件；命不中退化为页面侧 `el.click()` |
| `type` | 按 target 输入文字，可选 submit | 三层兜底 + 读回校验，详见下文 |
| `scroll` | 上/下滚一屏 | |
| `wait` | 等待 n 秒 | 上限 30s |
| `read_page` | 返回 url / title / 可见按钮、链接、输入框文字 | |
| `screenshot` | CDP 截图 | 只放内存的 data URL，不落库 |
| `ask_user` / `done` | **只定类型，未接业务** | 第 3 步不接大模型 |

`target` 支持：CSS 选择器（**可以是逗号列表**，天然降级）→ placeholder / aria-label / name / id / title 精确匹配
→ 可见文字精确 / 包含匹配。选择器会遍历**所有**匹配取第一个**可见**的（真实站点常把不可见的旧版控件排在前面）。

### ⚠️ 本机驾驶的三个真实坑

1. **CDP 文本注入会静默失败**。在本机（虚拟机环境）上，`Input.insertText`、逐字符
   `Input.dispatchKeyEvent`、`DOM.focus + insertText` 全都执行成功但不报错、值仍为空。
   所以 `type` 是「三层兜底 + 每次写回后读回 `el.value` 校验」：
   `Input.insertText` → `document.execCommand('insertText')` → 原生 setter + `InputEvent`；
   实际用了哪种会写在回执的 `detail` 里，三种都失败就返回 `ok:false`。
   （**鼠标**事件不受影响，`Input.dispatchMouseEvent` 正常。）
2. **点击必须先做命中测试**。内嵌页视口只有约 551px 宽，站点横向溢出时按钮会跑到视口外面，
   此时鼠标事件命不中任何元素、点击静默失败但回执仍是 `ok:true`。
   现在用 `elementFromPoint` 判定，命不中就退化并在 `detail` 里说明。
3. **选择器要取第一个可见的匹配**。`querySelector` 会返回不可见的元素（百度首页隐藏的
   `#kw` / `#su` 排在可见的新版搜索框前面），导致误判"找不到元素"。

### 暂停

- 主进程持 `paused` 开关；暂停后 `click` / `type` 直接拒绝执行并回报原因
  （`open_url` / `scroll` / `read_page` / `screenshot` 不受影响）。
- 界面上的「暂停 / 我来操作」按钮只负责把控制权交给你；内嵌页本来就是可点的，不需要「恢复」。

验收证据见 `docs/acceptance/step-3-main-window.png`、`step-3-driven-page.png`
与 `docs/acceptance/step-3-验收报告.md`；暂停/手点的复验见
`docs/acceptance/step-3-p0-input-验收报告.md`。

### 已知问题（第 3 步未解决）

- **百度结果里的蓝色标题，用户手点点不进去**。根因是内嵌页视口只有约 551px 宽，
  而百度那排搜索 UI 有 771px 宽，标题被挤到视口右侧外面，命中测试过不了。
  程序自己驾驶时有 `el.click()` 降级可以绕过，用户手点没有降级——要根治只能加宽右栏（属前端 UI）。
- `read_page` 只取 url / title / 可见按钮 / 链接 / 输入框，正文抽取偏弱。

---

## 关于启动包装器

`apps/desktop/scripts/start-electron.mjs` 是一个约 60 行的启动包装器，dev 和 start 都走它。

**为什么需要**：部分虚拟机 / 远程桌面 / 容器环境缺少初始化 Chromium 沙箱所需的系统能力，Electron 会在启动 1~2 秒后直接崩掉：

```
FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
```

**它做什么**：先按上面的默认（安全）参数启动；**只有**确认命中这种环境时，才自动加一次 `--no-sandbox` 重试，并在终端打印醒目提示。普通桌面环境永远不会走到这个分支，安全设置保持默认；走到时也不会静默降级。

回退时渲染进程依然拿不到 Node —— `contextIsolation: true` 和 `nodeIntegration: false` 不受影响，被放宽的只是 Chromium 的进程级沙箱。

---

## 进度与下一步

已完成：

- [x] **第 1 步** 骨架跑通：`npm run dev` 一条命令起 Vite + Electron，IPC 链路通
- [x] **第 2 步「脸和门」**：简易聊天界面（内存态假数据）+ 右栏内嵌 `<webview>` 显示真实网页
      验收证据见 `docs/acceptance/step-2-main-window.png` 与 `docs/acceptance/step-2-验收报告.md`
- [x] **第 3 步「遥控器先通」**：用主进程 `webContents.debugger`（CDP）驾驶内嵌 webview
      （`open_url` / `click` / `type` / `scroll` / `read_page` / `screenshot` + 暂停开关），右栏加调试区按钮
      验收证据见 `docs/acceptance/step-3-main-window.png`、`step-3-driven-page.png`
      与 `docs/acceptance/step-3-验收报告.md`

尚未实现：

- [ ] 接入大模型 API，流式返回（目前聊天是纯本地假数据，发出去不会有人回）
- [ ] 任务编排真正驱动驾驶（`ask_user` / `done` 目前只定义了类型）
- [ ] 会话持久化与历史列表
- [ ] `apps/server` 后端服务
- [ ] 生产环境补充 CSP（目前 `index.html` 未加，避免打断 Vite HMR；Electron 在 dev 下会打印一条 CSP 提示，打包后自动消失）
- [ ] 打包分发（electron-builder / electron-forge）

**待定**：内嵌页视口只有约 551px 宽（右栏 50vw），很多站点会横向溢出。
后续若要驾驶"完整桌面版"页面，需要先决定是加宽右栏（属前端 UI）还是接受窄视口。

---

## 排查提示

非交互式反复启停（自动化 / 验收脚本）容易攒下孤儿进程，症状是下次 `npm run dev` 报
`Port 5173 is already in use`，同时 Electron 因为单实例锁「1 秒内静默退出、退出码 0」。
两者叠加看起来像启动失败，其实只是旧实例还在。清理方式：

```bash
taskkill /F /IM electron.exe
PID=$(netstat -ano | grep ":5173.*LISTENING" | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill /F /T /PID "$PID"
```
