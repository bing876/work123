# TOOLING.md — 本机命令 / 环境 / 取证工具（从 MEMORY.md 拆出）

> 为什么拆出来：MEMORY.md 每次会话都会整份注入，超限就被截断。
> 这里是「本机怎么跑、怎么取证」的工具类细节，**开工前读一次**即可；项目契约在 `MEMORY.md`。
> 更细的操作手册在技能里：`electron-ui-verify`、`llm-prompt-capture-verify`、`db-race-verify`。

## 一、常用命令
- `npm run dev:server`（Fastify 8787，tsx watch 重载）、`npm run db:up`、`npm run dev`、`npm run typecheck`。
- 查本机服务一律加 `--noproxy '*'`。**`npx tsx src/index.ts` 起的服务不重载**，改完必须手动重启，
  否则会拿旧代码得错误结论。
- 起自己的验收实例：`npm run build -w @ai-workbench/shared && npm run build:electron -w @ai-workbench/desktop`，
  再 `npx vite --port 5273 --strictPort` + `VITE_DEV_SERVER_URL=http://localhost:5273 node scripts/start-electron.mjs
  --user-data-dir=<临时目录> --remote-debugging-port=9333`。**用户自己的 5173 / 8787 一律不动。**
- **起 Electron 必须清掉 `ELECTRON_RUN_AS_NODE`**（本机会话环境会设它）：
  `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node scripts/start-electron.mjs ...`。
  带上它 Electron 会以普通 Node 身份跑主进程，**启动 0 秒崩**：
  `Cannot read properties of undefined (reading 'isPackaged')`，退出码 1、无其它栈 ——
  极容易被误判成「刚改坏了代码」。
- **`taskkill` 要按端口找 PID**：`netstat -ano | grep ":<port>.*LISTENING"` 取 PID 再
  `MSYS_NO_PATHCONV=1 taskkill /F /T /PID <pid>`。**只 TaskStop 后台任务不会杀掉 node/electron 本体**
  （会留着占端口，下一次启动直接 `EADDRINUSE`）。

## 二、本机环境坑
- **`docker` CLI 被拦掉**（无输出）→ 查库写 node 脚本直连：`pg` 提升在**根** `node_modules`
  （`apps/server/node_modules` 是空的）+ 手工解析 `apps/server/.env`，`require('<repo>/node_modules/pg')`。
- **绝不打印 / Read `.env`、JWT、DEEPSEEK_API_KEY**。开发手机号 `18665594441`；短信码是
  `randomSixDigits()` 只进服务端日志 → 本机登录走自签 JWT，或起自己的后端从日志里捞码。
- **同一个文件一次只发一个 Edit**（并发 Edit 会静默丢改动，工具仍回 success），改完立刻复查。
- **C 盘会满**：`df -h` 看 `C:/` 那一行。**磁盘 0 字节时 Electron 会静默 `code=1` 退出、无任何栈** ——
  遇到「实例莫名退出」先 `df`，别急着怀疑代码。验收临时 profile 放 `%TEMP%` 并在结束前删。
- 大体积临时目录别留：`%TEMP%` 下的 `wb*profile` / `wb*verify` 都是历次验收的 Electron profile。

## 三、CDP 命令会永不回包（硬约束）
`webContents.debugger.sendCommand()` **没有自带超时**。实测对内嵌页发
`Input.dispatchMouseEvent(type=mouseWheel)` 永不回包，`Page.captureScreenshot` 页面忙时也会（页多时尤其）。
一挂就是**整条循环死锁**（`liveLoops` 一直 1、`llmCalls` 不再增长），看起来像业务 bug。
修法已落地在 `driver.ts` 的 `ensureAttached()`（给 debugger 打补丁，每条 CDP 8 秒上限）
+ `scroll` 滚轮 2 秒后走 JS 兜底 + `agent.ts` 单工具 20 秒上限 + `agentPost` 90 秒上限。
**以后任何新动作都自动受这道闸保护，不要绕过 `ensureAttached` 直接 `wc.debugger.sendCommand`。**
滚动兜底要连「视口中心那个可滚动容器」一起滚，判「有没有动」也看容器 `scrollTop`
（很多站点正文在自己的 overflow 容器里，只看 `window.scrollY` 会误判成「滚不动」）。
探针侧没有这道闸，所以表现为超时（`scripts/verify/cdp-probe.py`）；**截图失败不代表功能坏**。

## 四、验收取证的习惯
- **用 `/health` 计数器采样**证明「循环/保活」行为，而不是肉眼读聊天：`llmCalls`（累计模型调用）
  + `liveLoops`（只算 running）+ `pageStates`（按页分片条数）。采样要用**一个长驻进程每秒一次**；
  bash + curl + 内联 python 每次 ~0.5s 开销，几秒就结束的循环根本采不到。采样前先读基线（重启后端会归零）。
- **验并发一律用假模型 + 毫秒时间戳**，别用真 LLM（真模型延迟抖动会把「有没有真重叠」掩盖掉）——
  见技能 `llm-prompt-capture-verify` 第七节，工具在 `scripts/verify/`（含复跑 README）。
- **`liveLoops` 会被「建了循环但没人驱动」的条目读歪**：循环只在 `advance()` 被调用时才离开 `running`，
  所以任务轮建了循环而桌面没驱动、或某一路放下时没来得及 `/agent/loop/stop`，都会以 `running`
  挂到 10 分钟 TTL 到期（不烧模型、不吃 CPU，只是指标读歪）。**取证前先重启后端拿 `liveLoops=0` 的干净基线**。
- **接口一旦带「兜底合并」，就不能再拿它当原始证据**：例如 `GET /chat/state` 会用页级状态补空字段，
  于是「`conversations` 有没有被覆写」只能**直连库读原始行**（`createRequire('<repo>/')('pg')` + 手工解析 `.env`，
  密钥只进内存）。同理，验「空值才会被补」要用**全新实体**（老数据里的旧值会把结论盖住），验完即删。
- 写用例时两个常踩的坑：`DELETE` 带 `content-type: json` 却空 body 会被 Fastify **400**（无 body 就别带该头）；
  按 id 分片/缓存的键（如 `wcId`）**每轮要换新值**，复用旧键会读到上一轮留下的条目。
- **知识库本来是空的**（`knowledge_documents` / `knowledge_chunks` 0 行），「回答带来源」这条
  要**先传一份资料**才能抽查，别误判成自己把功能改坏了。
- 验收完清干净自己的实例：`TaskStop` + 按端口杀进程，复查端口已释放。
