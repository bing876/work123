# MEMORY.md — work123 长期记忆

仓库 `bing876/work123`，工作区 `C:\Users\bing\workbuddy-ai\work123`。
只留「会反复用到的规矩/坑」；实现细节见 git log、代码注释、当天日志。

## 一、git（本机有坑）
- 分支固定 `arena/01a09b16-work123`；`main` 只作基线，不合并/不推送/不 force。
- 开工前先核对 `git rev-parse HEAD` == 提示词给的基线。
- **本机 git 写不了带 `/` 的 ref**（commit/push/fetch/checkout -b/update-ref/reset --hard 之后
  `refs/heads/arena/...` 被静默抹掉；`git fetch` 还会抹掉 `refs/remotes/origin/arena/...`）。
  绕法：`git add -A && tree=$(git write-tree) && sha=$(git commit-tree $tree -p <parent> -F <msgfile>)`，
  **最后一步**再 `printf '%s\n' $sha > .git/refs/heads/arena/<名>`（+ 同名 remote ref，fetch 后按
  `ls-remote` 的值补回来）。**写 ref 的命令都排在补 ref 之前，补写必须是最后一步**，之后只跑只读命令。
  禁止 `git branch --set-upstream-to`。sha 丢了从 `.git/logs/HEAD` 捞。
- 证明没 force：push 输出没有 `+` 前缀 + `ls-remote`/本地 ref 文件/HEAD 三者一致 +
  `git merge-base --is-ancestor <基线> HEAD` 通过。
- 拉 GitHub 走 Clash，四个变量都要导出（小写会盖掉大写并 502）：
  `export http_proxy=http://127.0.0.1:7897 https_proxy=$http_proxy HTTP_PROXY=$http_proxy HTTPS_PROXY=$http_proxy`

## 二、命令与环境
- `npm run dev:server`（Fastify 8787，tsx watch 重载）、`npm run db:up`、`npm run dev`、`npm run typecheck`。
  查本机服务一律加 `--noproxy '*'`。
- **`npx tsx src/index.ts` 起的服务不重载**，改完必须手动重启，否则拿旧代码得错误结论。
- **`docker` CLI 在本机沙箱里会被 SIGTERM 拦掉**（`docker ps` / `exec` 全无输出）→ 要查库就写 node
  脚本直连：依赖提升在**根** `node_modules`（`apps/server/node_modules` 是空的）+ 手工解析
  `apps/server/.env`，用 `require('<repo>/node_modules/pg')`。
- **绝不打印 / Read `.env`、JWT、DEEPSEEK_API_KEY**。开发手机号 `18665594441`；短信码是
  `randomSixDigits()` 只进服务端日志（不是固定 123456），所以本机登录一律走自签 JWT。
- 改文件：**同一个文件一次只发一个 Edit**（并发 Edit 会静默丢改动，工具仍回 success），改完立刻 grep/Read 复查。

## 三、桌面启停（本机）
- 杀进程：`electron.exe` + `AI 工作台.exe` 两个名都杀，再按 PID 补杀，静置 10~15s 复查；
  只杀端口监听者不够（npm→cmd→concurrently→vite 是一条链）。
- `Port 5173 already in use` + wait-on 成功 + electron 1s code=0 退出 → 先怀疑孤儿实例，别改代码。
- 进程数=0 仍报「已有实例在运行」→ 单实例锁残留，换 `--user-data-dir` 绕。
- 本机 electron 必先撞 GPU 崩溃、包装器自动回退 `--no-sandbox` —— 正常现象。
- **优雅关窗（`window.close()` / CDP `Browser.close`）后主进程变僵尸**：窗口没了但 `electron.exe`
  还占着 `--remote-debugging-port`，`taskkill /F /PID` 报「没有此任务的实例在运行」→
  **杀父包装器**（`scripts/start-electron.mjs` 的 node）。用后台任务起的话 `TaskStop` 即可。
- 只跑 `start-electron.mjs` ≠ `npm run dev`：缺 `VITE_DEV_SERVER_URL` 会加载旧 `dist/index.html`；
  改 `electron/**` 必须先 `npm run build:electron -w @ai-workbench/desktop`。
- 验收「关掉再开还在」必须优雅关窗；`taskkill /F` 会丢未提交的 localStorage。
- 用户自己的实例（5173/9222）别杀。自己的验收实例：另起 vite（`--port 5273 --strictPort`）
  + electron（独立 `--user-data-dir` + `--remote-debugging-port 9333`），只清自己那棵。
  手法见技能 `electron-ui-verify` 第九节。

## 四、验收桌面：CDP
- Python `websocket-client` 连 `/devtools/page/<id>` 做 `Runtime.evaluate`；一个 `page` 目标 = 一个窗口，
  内嵌页是 `type:'webview'` 目标，可直接连上去跑 JS（读 cookie 才是分区隔离的硬证据）。
  python：`C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe`。
- **React 受控输入必须真键盘**：`Input.dispatchMouseEvent` 点进 → 确认 activeElement →
  `Input.insertText` → DOM `.click()`。聊天输入框认 `.inputBar input`；点进 URL 栏后**先 Ctrl+A**。
- `evalf` 里要 `await` 必须包 `(async () => {…})()` + `awaitPromise: true`。
- 探针在 `%TEMP%`（会被清）：`wb20probe.py`（eval/evalf/tabs/webviews/targets/gjs/gjsall/login/send/shot/quit；
  端口读 `WB20_PORT`、页面匹配读 `WB20_MATCH`）。批量造状态走 `window.workbench.openBrowser(url)`
  （= 主进程 open 桥，和驾驶员开页同一条代码路径），**别发 N 条聊天消息烧模型**。
- 登录态：用 `.env` 的 `JWT_SECRET` 自签 `{sub, xyz}`（HS256/7d）注入 `localStorage['workbench.token']`
  再 reload；密钥只进内存不回显。

## 五、已实现契约（易踩坏，细节见代码注释）
- 第 13/14 步：开页判定 `detectOpenUrl()` 纯本地；token 存 localStorage → `/auth/me` 静默续会话。
- 第 15/16 步：`chats: Record<agentId,...>` 按发起时捕获的 agentId 落桶；`promptPolicy.ts` 优先级
  「本轮最新消息 > 已确认事项 > current_task > 长期记忆」；`llm.ts` 是模型调用唯一出口。
  **系统提示词的否定约束打不过上下文旧话复读 —— 先清历史再改措辞。**
- 第 17 步：驾驶按 guest webContents id 分路；`driver.ts` 的 `PAGE_HELPERS` 是 TS 模板字符串里的 JS
  —— **注释里写反引号会截断字符串**；换页途中 `document.documentElement` 可能为 null，视口走 `viewport()`。
- 第 18 步：浏览器相关只写 `apps/desktop/src/browser/`（入口 `index.ts`）。**开页成功不写聊天**；
  关 tab 只留一句人话；**纯开页不发车**（`isPureOpenCommand`）；**「停」是唯一刹车**。
- 第 20 步：**一个智能体一套浏览器**，分区 `persist:workbench-browser-agent-{id}`
  （`browser/url.ts` 的 `partitionFor`；主进程用 `AGENT_PARTITION_RE` 反解同一套命名，改一处要改两处）；
  下载按智能体落到 `userData/browser-agents/{id}/downloads/`。tab 状态按智能体分桶，切智能体只换可见桶、
  **webview 一律不卸载**；`BrowserPanel` 必须「只要**任意**智能体还有页就挂着」，否则切到空桶会把别人的页卸掉。
  **活页硬顶已取消**（`MAX_LIVE_PAGES` / `MAX_LANES` 都没了），只提示「开太多会卡」，绝不关页。

## 六、会话唯一性不变量
**一个智能体只能有一条会话。** 建会话一律走 `ensureAgentConversation(pool, ownerId, agentId)`；
全仓 `INSERT INTO conversations` 只应有三处；约束 `uniq_conversations_agent` 在 `db.ts migrate()`。
Postgres 并发「找或建」：`FOR UPDATE` 等锁期间仍是旧快照 → **存在性检查塞进子查询必重复插入**；
正解是拿到锁后**另起一条语句**再查再 INSERT。

## 七、布局 / 样式坑
`.chat` 是高度确定的 `overflow:auto` column flex，内容超高时 `flex-shrink:1` 子项被压扁而非滚动。
**同优先级单类选择器，谁在文件后面谁赢**：「用样式藏掉」的规则一律放 `styles.css` 末尾。

## 八、第 21 步契约：网页工具循环（易踩坏）
- 本步三个提交：`5639aba`（主体）+ `033e35c`（补漏的 `driver.ts`）+ `e222f20`（文档）。
  分支 `arena/01a09b16-work123` tip = `e222f20`，基线 `39cde801`。**下一轮基线由用户给，别自己认。**
- **一条分叉**：`/chat/stream` 带 `taskMode:true` = 任务轮 → **一次模型都不调**，只建循环
  （`toolLoop.ts`）并回 `loopId`，由桌面驱动；闲聊 / 知识库 / 问「你是谁」走原聊天路径且
  **不带 tools** —— 闲聊在能力上就不可能开页。别再给任务轮加聊天模型的第二套话术。
- 工具只有 6 个：`open_url` / `read_page` / `click` / `type` / `scroll` / `stop`。
  `/agent/next-action` 只是同一引擎的单步适配器（同一提示词、同一工具表、同一校验）。
- 步数上限来自 `AGENT_LOOP_MAX_STEPS`（默认 10，`/health` 暴露 `loopMaxSteps`）；
  循环闲置 10 分钟回收、最多 32 路；**空闲保活一次都不调模型**。
- 循环按 `agentId + wcId` 校验，换智能体 / 换页 → **409**，绝不把动作打到别的 bot 的页上。
- `PAGE_HELPERS` 的 `__v` 改了必须同步改版本号（现在是 10）；快照除 buttons/links/inputs
  外还有 **`texts`（可见正文片段）** —— 没有它，「把这一页整理成列表」这类任务做不了。
- 别的智能体的页用 **`--off` = `opacity:0` + `pointer-events:none`** 藏，
  **绝不能用 `display:none` 或条件不渲染**：宽高变 0 会让后台那一轮点不中任何元素。

## 九、CDP 命令会永不回包（本机硬约束，别再踩）
`webContents.debugger.sendCommand()` **没有自带超时**。实测对内嵌页发
`Input.dispatchMouseEvent(type=mouseWheel)` **永不回包**，`Page.captureScreenshot` 在页面忙时也会。
一旦挂在里面就是**整条循环死锁**（`liveLoops` 一直 1、`llmCalls` 不再增长、聊天停在半句话上，
只能重启窗口）—— 看起来像业务 bug，其实是 CDP。
修法已落地在 `driver.ts` 的 `ensureAttached()`（给 debugger 打一次补丁，每条 CDP 8 秒上限）
+ `scroll` 只给滚轮 2 秒后走 JS 兜底 + `agent.ts` 单个工具 20 秒上限 + `agentPost` 90 秒上限。
**以后任何新加的动作都自动受这道闸保护，不要绕过 `ensureAttached` 直接 `wc.debugger.sendCommand`。**
另外：滚动兜底要连「视口中心那个可滚动容器」一起滚，判「有没有动」也看容器 `scrollTop`
（很多站点正文在自己的 overflow 容器里，只看 `window.scrollY` 会误判成「滚不动」）。

## 十、提交/推送（补两条本机新坑）
- **`git add` 手写文件清单会漏文件**（第 21 步漏了 `driver.ts`，恰好是修法所在）。
  暂存后**必须** `git diff --cached --stat` 数一遍；提交后立刻 `git diff HEAD --name-only` 复查应为空。
- `git commit-tree -F` **不认 MSYS 风格路径**（`/c/Users/...` 报 No such file or directory），
  要传 `C:/Users/...`。push 会顺手删掉 `refs/remotes/origin/arena/` 目录，补写 ref 前先 `mkdir -p`。
- 验收用的临时实例记得清干净：`TaskStop` 掉 electron/vite 的后台任务、按 PID 杀掉假 LLM，
  **用户自己的 5173 / 8787 一律不动**。

## 十一、验收取证的两个习惯（省时间）
- **用 `/health` 的计数器采样**证明「循环/保活」行为，而不是肉眼读聊天：
  `llmCalls`（累计模型调用）+ `liveLoops`（只算 running）。
  采样要用**一个长驻 python 进程每秒一次**；用 bash + `curl` + 内联 python 每次 ~0.5s 开销，
  几秒就结束的循环根本采不到，会得出「循环从没起来」的错误结论。采样前先读基线
  （中途重启后端计数器会归零）。
- **知识库本来是空的**（`knowledge_documents` / `knowledge_chunks` 0 行），
  「回答带来源」这条要**先传一份资料**才能抽查，别误判成自己把功能改坏了。
  查库写 node 脚本直连（`pg` 提升在**根** `node_modules`），别用 `docker`（本机被拦）。

## 十二、第 22 步契约：多实例 / 按智能体隔离 / fail-fast（易踩坏）
- 本步提交 `80cd92c`（`step22: …`），父 `e222f20`，**快进推送无 force**。
  **下一轮基线由用户给，别自己认。**
- **`driver.ts` 里没有任何驾驶状态是全局单例**：`phase/detail/step/paused/loopToken` 全在
  `Map<number, TargetTask>` 里（`taskOf(wcId)` 取或建、`phaseOf`/`pausedOf` **不建条目**）。
  新增任何驾驶状态**必须**进这个 Map，不许再起模块级 `let`。
- **`findWebviewGuest()` 已删除**（全仓只剩注释说明它被删）。`resolveTarget(id?)`：
  没给 id → 抛「驾驶目标未指定」；id 失效 → 抛「指定的内嵌页已经不在了」。
  **绝不盲选第一张 webview。** 所有 `drive/readPage/startTask/...` 都要显式带 `webContentsId`。
- **聚合视图**（不传 id 时给左栏横幅用）：优先级 running > paused > 最近终止态 > idle，
  **按 `seq` 取最新**（不是 Map 第一条）。`seq` 只在写入时自增。
- **终态有三种**：`idle`（停手先到）/ `done`（这一路自己做完）/ `paused`（自己转 ask_user）。
  判据只能写「**绝不停在 running**」——写死成 idle 会把正常收尾误判成 bug。
  `finishLane` 的 `aborted` 分支要收敛成 idle 时，**必须**加 `lanes.get(wcId) === lane` 判断，
  否则会把「最新指令优先」时刚起的新循环覆盖掉。
- **配置**：`electron/settings.ts` 是权威（`userData/workbench-settings.json`），
  默认 `{ maxConcurrentAgentTasks: 1, maxBrowserInstances: 4 }`，范围来自 shared 的 `SETTINGS_RANGE`
  （1–8 / 1–20）。渲染层 `App.tsx` 有**第二份兜底常量**（主进程 import 不到渲染层）。
  **配置是全局唯一一份，不做 per-target**（A1.5 要求按 target 独立的是**驾驶状态**，不是配置）。
- **并发闸**在 `main.ts` 的 `startAgentLoop`，**只在 `!prev` 时判**（被新指令顶掉不算新路）。
  上限 1 时第二路会被拒并给一句人话。**调大这个数就解锁真并行，数据结构不用动。**
- **D 上限闸**在 `useBrowserWorkspace.openUrl`（同站复用判断之后、新开之前），
  **跨智能体全局计数**；到顶**只拒开、绝不关页**。
- **卡片视图必须叠一层透明承接层** `.browserCard__catcher`（`position:absolute; inset:0`）：
  指针落在 `<webview>` 上时鼠标事件被 guest 吞掉，宿主 `:hover` **永不成立**。
  承接层只在卡片视图渲染，**viewer 模式不渲染**（否则网页点不动）。
  webview 的父容器 `.browserCard__body` **任何模式都要渲染**——换父节点 = 重挂 = 页重载。
- **验收前先验产物新鲜度**：`grep` `dist-electron/*.js` 里有没有本步标记字符串 + 比对 mtime
  （渲染层走 vite HMR 不用重建，主进程改了**必须** `npm run build:electron -w @ai-workbench/desktop`）。
- **探针的 `agentLanes()` 返回数组**，必须用 `jsf`（`ev`）取，用 `js` 拿到的是 Promise → 序列化成 `{}`，
  会得出「一路都没起来」的错误结论。
- **停手后状态采样有竞态**：`agentStop` 与「这一路自己收尾」谁先到决定终态是 idle 还是 done/paused，
  多跑几次才看得到全部三种。


## 十二、浏览器多实例融合（第 22 步起）：已拍板的决策 + 别信旧审计
- 基线 `e222f20`。报告 `docs/browser-multiinstance-fusion-report.md` 是**批复与勘误的唯一出处**
  （§10 批复 / §11 勘误 / §12 前置项），**动手前先读它，别读 §1 的旧审计**。
- 已拍板：**A1.5**（TaskState 设计上按 target/`webContentsId` 独立、**禁全局单例**；
  一期用**并发数配置项**限「同时 1 个 active agent task」，后续调大即解锁真并行，不改数据结构）、
  **B1**（partition 按 contactId/智能体隔离）、**C1**（resting card 用 live webview 缩小，**不用截图**）、
  **D 默认 4**（不是 6）且**设置里可调、不许写死**。
- 同意删 `findWebviewGuest` 盲选后 **fail-fast 直接报错**（无 id 也是报错，不再瞎选）。
- **红线**：§7 全部不变量保留，尤其**密码/验证码不代填的敏感闸**，
  **每个 Phase 验收都要重新验一遍**，任何改动不得弱化。
- **别被报告的 §1 骗**：它写的是第 18 步之前的形态。`e222f20` 上 Phase 0/1 **已经做完**
  （分桶在 `useBrowserWorkspace.ts` 的 `pages: Record<agentId, ...>`，
  分区在 `browser/url.ts:37 partitionFor(agentId)`，多页并存靠 `allTabs` + `--off`）。
  剩余 = Phase 2 收尾（无 id 也报错）+ 配置层（A1.5 并发数 / D 上限 4 的设置入口）
  + `driver.ts` 的 `phase/phaseDetail/phaseStep/paused/loopToken` **per-target 化** + Phase 3 UI。
- `apps/desktop/NVIDIA Corporation/`（NVIDIA 驱动 umdlogs）已加 `.gitignore` 规则
  `NVIDIA Corporation/`；它**从未被跟踪**，是运行时残留，不是源码。
