# MEMORY.md — work123 长期记忆

仓库 `bing876/work123`，工作区 `C:\Users\bing\workbuddy-ai\work123`。
只留「会反复用到的规矩/坑」；实现细节见 git log / docs / 当天日志。

## 一、git（本机有坑）
- 分支固定 `arena/01a09b16-work123`；`main` 只作基线，不合并/不推送/不 force。
  开工前核对 `git rev-parse HEAD` == 用户给的基线；**下一轮基线由用户给，别自己认**。
- **本机 git 写不了带 `/` 的 ref**：commit / push / fetch / checkout -b / update-ref / reset --hard
  之后 `refs/heads/arena/...` 被静默抹掉（fetch 还抹 remote ref）。绕法：
  `git add -A && tree=$(git write-tree) && sha=$(git commit-tree $tree -p <parent> -F <msgfile>)`，
  **最后一步**再 `printf '%s\n' $sha > .git/refs/heads/arena/<名>`（remote ref 按 `ls-remote` 补，
  先 `mkdir -p`）。**写 ref 的命令都排在补 ref 之前**，之后只跑只读命令。
  禁止 `git branch --set-upstream-to`（直接删本地分支 ref）。sha 丢了从 `.git/logs/HEAD` 捞。
- `git commit-tree -F` 不认 MSYS 路径（`/c/...`），要传 `C:/...`。
- **`git add` 手写清单会漏文件**（漏过 `driver.ts`）。暂存后必须 `git diff --cached --stat` 数一遍；
  提交后 `git diff HEAD --name-only` 应为空。
- 证明没 force：push 输出无 `+` + `ls-remote`/本地 ref/HEAD 三者一致 + `merge-base --is-ancestor <基线> HEAD`。
- 拉 GitHub 走 Clash，四个变量都要导出（小写会盖掉大写并 502）：
  `export http_proxy=http://127.0.0.1:7897 https_proxy=$http_proxy HTTP_PROXY=$http_proxy HTTPS_PROXY=$http_proxy`

## 二、命令与环境
- `npm run dev:server`（Fastify 8787，tsx watch 重载）、`npm run db:up`、`npm run dev`、`npm run typecheck`。
  查本机服务一律加 `--noproxy '*'`。
- **`npx tsx src/index.ts` 起的服务不重载**，改完必须手动重启，否则拿旧代码得错误结论。
- **`docker` CLI 在本机被 SIGTERM 拦掉**（无输出）→ 查库写 node 脚本直连：`pg` 提升在**根**
  `node_modules`（`apps/server/node_modules` 是空的）+ 手工解析 `apps/server/.env`，
  `require('<repo>/node_modules/pg')`。
- **绝不打印 / Read `.env`、JWT、DEEPSEEK_API_KEY**。开发手机号 `18665594441`；短信码是
  `randomSixDigits()` 只进服务端日志 → 本机登录一律走自签 JWT。
- **同一个文件一次只发一个 Edit**（并发 Edit 会静默丢改动，工具仍回 success），改完立刻复查。

## 三、桌面启停（本机）
- 杀进程：`electron.exe` + `AI 工作台.exe` 两个名都杀，再按 PID 补杀，静置 10~15s 复查；
  只杀端口监听者不够（npm→cmd→concurrently→vite 是一条链）。
- `Port 5173 already in use` + wait-on 成功 + electron 1s code=0 退出 → 先怀疑孤儿实例，别改代码。
- 进程数=0 仍报「已有实例在运行」→ 单实例锁残留，换 `--user-data-dir` 绕。
- 本机 electron 必先撞 GPU 崩溃、包装器自动回退 `--no-sandbox` —— 正常现象。
- **优雅关窗后主进程变僵尸**（窗口没了但 `electron.exe` 还占着调试端口）→ **杀父包装器**
  （`scripts/start-electron.mjs` 的 node）；后台任务起的 `TaskStop` 即可。
  验收「关掉再开还在」必须优雅关窗（`taskkill /F` 会丢 localStorage）。
- 只跑 `start-electron.mjs` ≠ `npm run dev`：缺 `VITE_DEV_SERVER_URL` 会加载旧 `dist/index.html`；
  **改 `electron/**` 必须先** `npm run build:electron -w @ai-workbench/desktop`。
- 用户自己的实例（5173/9222/8787）一律不动。自己的验收实例：另起 vite（`--port 5273 --strictPort`）
  + electron（独立 `--user-data-dir` + `--remote-debugging-port 9333`），只清自己那棵。

## 四、验收桌面：CDP
- Python `websocket-client` 连 `/devtools/page/<id>` 跑 `Runtime.evaluate`；一个 `page` 目标 = 一个窗口，
  内嵌页是 `type:'webview'` 目标，可直接连上去跑 JS（读 cookie 才是分区隔离的硬证据）。
  python：`C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe`。
- **React 受控输入必须真键盘**：`Input.dispatchMouseEvent` 点进 → 确认 activeElement →
  `Input.insertText` → DOM `.click()`。聊天输入框认 `.inputBar input`；点进 URL 栏后**先 Ctrl+A**。
- `evalf` 里要 `await` 必须包 `(async () => {…})()` + `awaitPromise: true`。
- 探针在 `%TEMP%`（会被清）：`wb20probe.py`（eval/evalf/tabs/webviews/targets/gjs/gjsall/login/send/shot/quit；
  端口读 `WB20_PORT`、页面匹配读 `WB20_MATCH`）。批量造状态走 `window.workbench.openBrowser(url)`
  （= 主进程 open 桥，同一条代码路径），**别发 N 条聊天消息烧模型**。
  探针 `agentLanes()` 返回数组，必须用 `jsf`（`ev`）取；用 `js` 拿到的是 Promise → 序列化成 `{}`，
  会得出「一路都没起来」的错误结论。
- 登录态：用 `.env` 的 `JWT_SECRET` 自签 `{sub, xyz}`（HS256/7d）注入 `localStorage['workbench.token']`
  再 reload；密钥只进内存不回显。

## 五、稳定契约（已实现，改动易踩坏）
- **会话唯一性**：一个智能体只能有一条会话，建会话一律走 `ensureAgentConversation(pool, ownerId, agentId)`；
  全仓 `INSERT INTO conversations` 只应有三处；约束 `uniq_conversations_agent` 在 `db.ts migrate()`。
  Postgres 并发「找或建」：`FOR UPDATE` 等锁期间仍是旧快照 → 存在性检查塞进子查询必重复插入；
  正解是拿到锁后**另起一条语句**再查再 INSERT。
- **提示词/聊天**：`chats: Record<agentId,...>` 按发起时捕获的 agentId 落桶；`promptPolicy.ts` 优先级
  「本轮最新消息 > 已确认事项 > current_task > 长期记忆」；`llm.ts` 是模型调用唯一出口。
  **系统提示词的否定约束打不过上下文旧话复读 —— 先清历史再改措辞。**
- **浏览器工作区**：浏览器相关只写 `apps/desktop/src/browser/`（入口 `index.ts`）。开页判定
  `detectOpenUrl()` 纯本地；**开页成功不写聊天**；关 tab 只留一句人话；**纯开页不发车**；
  **「停」是唯一刹车**。分区 `persist:workbench-browser-agent-{id}`（`browser/url.ts:partitionFor`；
  主进程用 `AGENT_PARTITION_RE` 反解，**改一处要改两处**），下载落 `userData/browser-agents/{id}/downloads/`。
  tab 状态按智能体分桶（`pages: Record<agentId,...>`），切智能体只换可见桶、**webview 一律不卸载**；
  `BrowserPanel` 必须「只要**任意**智能体还有页就挂着」，否则切到空桶会卸掉别人的页。
  别的智能体的页用 **`--off` = `opacity:0` + `pointer-events:none`** 藏，**绝不能用 `display:none`
  或条件不渲染**：宽高变 0 会让后台那一轮点不中任何元素。
- **样式**：`.chat` 是高度确定的 `overflow:auto` column flex，内容超高时 `flex-shrink:1` 子项被压扁。
  **同优先级单类选择器，谁在文件后面谁赢**：「用样式藏掉」的规则一律放 `styles.css` 末尾。
- `driver.ts` 的 `PAGE_HELPERS` 是 TS 模板字符串里的 JS —— **注释里写反引号会截断字符串**；
  `__v` 改了必须同步改版本号。换页途中 `document.documentElement` 可能为 null，视口走 `viewport()`。

## 六、第 21 步契约：网页工具循环（脑在服务端，手在桌面）
- **一条分叉**：`/chat/stream` 带 `taskMode:true` = 任务轮 → **一次模型都不调**，只建循环
  （`toolLoop.ts`）并回 `loopId`，由桌面驱动；闲聊 / 知识库 / 问「你是谁」走原聊天路径且**不带 tools**。
- 工具只有 6 个：`open_url` / `read_page` / `click` / `type` / `scroll` / `stop`。
  `/agent/next-action` 只是同一引擎的单步适配器（同一提示词、工具表、校验）。
- 步数上限 `AGENT_LOOP_MAX_STEPS`（默认 10，`/health` 暴露 `loopMaxSteps`）；循环闲置 10 分钟回收、
  最多 32 路；**空闲保活一次都不调模型**。
- 循环按 `agentId + wcId` 校验，换智能体 / 换页 → **409**，绝不把动作打到别的 bot 的页上。
- 快照除 buttons/links/inputs 外还有 **`texts`（可见正文片段）** —— 没有它，「把这一页整理成列表」
  这类任务做不了。

## 七、CDP 命令会永不回包（本机硬约束）
`webContents.debugger.sendCommand()` **没有自带超时**。实测对内嵌页发
`Input.dispatchMouseEvent(type=mouseWheel)` 永不回包，`Page.captureScreenshot` 页面忙时也会。
一挂就是**整条循环死锁**（`liveLoops` 一直 1、`llmCalls` 不再增长），看起来像业务 bug。
修法已落地在 `driver.ts` 的 `ensureAttached()`（给 debugger 打补丁，每条 CDP 8 秒上限）
+ `scroll` 滚轮 2 秒后走 JS 兜底 + `agent.ts` 单工具 20 秒上限 + `agentPost` 90 秒上限。
**以后任何新动作都自动受这道闸保护，不要绕过 `ensureAttached` 直接 `wc.debugger.sendCommand`。**
滚动兜底要连「视口中心那个可滚动容器」一起滚，判「有没有动」也看容器 `scrollTop`
（很多站点正文在自己的 overflow 容器里，只看 `window.scrollY` 会误判成「滚不动」）。

## 八、第 22 步契约：多实例 / 按智能体隔离 / fail-fast
- 提交 `80cd92c`（step22）+ `d4d5875`（step22b 回退 Phase 3 UI）+ 后续 docs，父 `e222f20`，全部快进推送。
- **`driver.ts` 里没有任何驾驶状态是全局单例**：`phase/detail/step/paused/loopToken` 全在
  `Map<number, TargetTask>`（`taskOf(wcId)` 取或建、`phaseOf`/`pausedOf` **不建条目**）。
  新增驾驶状态**必须**进这个 Map，不许再起模块级 `let`。
- **`findWebviewGuest()` 已删除**。`resolveTarget(id?)`：没给 id → 抛「驾驶目标未指定」；
  id 失效 → 抛「指定的内嵌页已经不在了」。**绝不盲选第一张 webview。**
  所有 `drive/readPage/startTask/...` 都要显式带 `webContentsId`。现状：main.ts 只剩 3 处 `drive`
  调用且全部带 target；`App.tsx:getWebviewId` 已删；`focus_sensitive_field` 走已解析的 `wc`
  且只聚焦不读值；**渲染层完全不直接调 `workbench.drive`**。
- **聚合视图**（不传 id 时给左栏横幅用）：优先级 running > paused > 最近终止态 > idle，**按 `seq` 取最新**。
- **终态有三种**：`idle` / `done` / `paused`。判据只能写「**绝不停在 running**」。
  `finishLane` 的 `aborted` 分支收敛成 idle 时**必须**加 `lanes.get(wcId) === lane` 判断，
  否则会覆盖「最新指令优先」时刚起的新循环。停手后状态采样有竞态，多跑几次才看到全部三种。
- **配置**：`electron/settings.ts` 是权威（`userData/workbench-settings.json`），默认
  `{ maxConcurrentAgentTasks: 1, maxBrowserInstances: 4 }`，范围来自 shared 的 `SETTINGS_RANGE`（1–8 / 1–20）。
  渲染层 `App.tsx` 有**第二份兜底常量**（主进程 import 不到渲染层）。**配置全局唯一一份，不做 per-target**。
- **并发闸**在 `main.ts` 的 `startAgentLoop`，**只在 `!prev` 时判**（被新指令顶掉不算新路）。
  上限 1 时第二路被拒并给一句人话。**调大这个数就解锁真并行，数据结构不用动。**
- **D 上限闸**在 `useBrowserWorkspace.openUrl`（同站复用判断之后、新开之前），**跨智能体全局计数**；
  到顶**只拒开、绝不关页**。
- **卡片视图必须叠一层透明承接层** `.browserCard__catcher`（`position:absolute; inset:0`）：
  指针落在 `<webview>` 上时鼠标事件被 guest 吞掉，宿主 `:hover` 永不成立。承接层只在卡片视图渲染，
  **viewer 模式不渲染**。webview 父容器 `.browserCard__body` **任何模式都要渲染**（换父节点 = 页重载）。
- **验收前先验产物新鲜度**：`grep` `dist-electron/*.js` 有没有本步标记字符串 + 比对 mtime。

## 九、多实例融合：已拍板决策 + 流程教训
- 报告 `docs/browser-multiinstance-fusion-report.md` 是**批复与勘误的唯一出处**（§10 批复 / §11 勘误 /
  §12 前置项），**动手前先读它，别读 §1 的旧审计**。
- 已拍板：**A1.5**（TaskState 按 target 独立、禁全局单例；一期用并发数配置项限「同时 N 个 active
  agent task」，调大即解锁真并行、不改数据结构）、**B1**（partition 按智能体隔离）、
  **C1**（resting card 用 live webview 缩小，不用截图）、**D 默认 4** 且设置里可调、不许写死。
- **红线**：**密码/验证码不代填的敏感闸**每个 Phase 验收都要重新验一遍，任何改动不得弱化。
- Phase 编号：0 数据模型 / 1 partition / 2 路由整改 / 3 UI / 4 统一接入（已被 A1.5 覆盖）/ 5 回归。
  **Phase 3 已实现后回退**（等新 UI 设计稿）：回退只动 `browser/BrowserPanel.tsx` + `browser/styles.css`
  （还原到 `e222f20`），**完整实现保留在 `80cd92c`**。改 UI 时保持这两个文件与其余改动无耦合。
- **流程教训**：批复里「暂缓/不做」的项，**动手前先确认它是不是已经做完了**；遇到「指示与实际状态
  冲突」→ 如实报告 + 让总控定夺，绝不自己悄悄删或悄悄留。
- `apps/desktop/NVIDIA Corporation/`（驱动 umdlogs）已加 `.gitignore`；从未被跟踪，是运行时残留。

## 十、验收取证的习惯（省时间）
- **用 `/health` 计数器采样**证明「循环/保活」行为，而不是肉眼读聊天：`llmCalls`（累计模型调用）
  + `liveLoops`（只算 running）+ `pageStates`（按页分片条数）。采样要用**一个长驻 python 进程每秒一次**；
  bash + curl + 内联 python 每次 ~0.5s 开销，几秒就结束的循环根本采不到。采样前先读基线（重启后端会归零）。
- **验并发一律用假模型 + 毫秒时间戳**，别用真 LLM：真模型延迟抖动会把「有没有真重叠」掩盖掉。
  `scripts/verify/` 里那套（零依赖假模型固定延迟 + 请求 JSONL 日志 + 服务端/桌面两组用例）**直接复跑**，
  不烧 token、不依赖外网。**开页复用按 host 判**（含端口）—— 想同时开多张页必须用不同端口。
- **知识库本来是空的**（`knowledge_documents` / `knowledge_chunks` 0 行），「回答带来源」这条
  要**先传一份资料**才能抽查，别误判成自己把功能改坏了。
- 验收完清干净自己的实例：`TaskStop` + 按端口杀进程，**用户自己的 5173 / 8787 一律不动**。

## 十一、子阶段 A 契约：并发闸 / 状态按页分片 / advance 重入（易踩坏）
- 报告 `docs/acceptance/substage-a-验收报告.md`（+ 原始取证 `substage-a-evidence.json`）是本步唯一出处。
- **并发闸默认 20**：`shared` 的 `DEFAULT_SETTINGS.maxConcurrentAgentTasks`。
  **改默认值必须同时改 `SETTINGS_RANGE`**，否则 `settings.ts:normalizeSettings` 会把默认值夹回区间上限。
  闸本体在 `main.ts:startAgentLoop`（`lanes.size >= limit` 拒绝），**只在 `!prev` 时判**。
- **状态两个粒度，别混**：
  - **页级/任务级** → `apps/server/src/pageState.ts`（内存注册表，key = `wcId`，条目带 `userId`/`loopId`，
    TTL 10min、上限 64）。**唯一写入口是 `toolLoop.ts:syncPageState`（每步推进后）** 与
    `sessionState.ts:applyUserMessage({page})`（任务轮入口）。
  - **会话级/智能体级** → `conversations`（表结构一行未动）：`keepalive` 只在这里
    （**它没有 wcId 维度**，读写点是 `POST /chat/state` 与 `keepaliveOfAgent`，别搬进分片表）；
    `browser_confirmed` 作为聚合标志也留在这里。
  - 任务轮**不再覆写** `conversations` 的 `current_task/latest_user_intent/last_page_summary/login_required/sensitive_action`。
  - 分片表**只当缓存用**：首次用到某张页时才拿会话态当种子，之后**页级优先**，绝不被会话级覆盖回去。
  - 读口：`GET /agent/loop/state?wcId=`（要 JWT，别人的页 404）；不传 wcId 回自己名下全部。
- **`advance()` 有重入锁**：锁是 `LoopSession.advancing`（**粒度 = 一个 loopId 一把**，两条循环互不影响）。
  已锁 → 抛 `LoopBusyError` → 路由 **409 `code=loop_busy`**（不是 500）。
  外部**只能调 `advance`**；真实现是 `advanceInner`，别从外面直接调它（会绕过锁）。
- **IPC 三兄弟都支持点名 target**（子阶段 A 补的最后一公里）：`workbench:task:pause` / `resume` / `state`。
  不传 target 时行为与以前一致（`pause`→「此刻在跑/最近碰过的那张」；`state`→**聚合视图**）。
  ⚠️ **聚合视图读不出「1 号暂停、2 号还在跑」**（它按 running > paused 挑一条），验并发必须传 target。
- **渲染层三处旧值按边界没动**（UI 阶段要一起改）：`App.tsx:SETTINGS_FALLBACK=1`、设置面板 `max="8"`、
  提示文案「并发默认 1」。功能无影响（闸在主进程），但界面自相矛盾。
- **已落盘的 `userData/workbench-settings.json` 会盖住新默认值**：老 profile 存着 1 的话默认 20 不生效。
- **本机 C 盘会满**（`df` 看 `C:/` 那一行）：**磁盘 0 字节时 Electron 会静默 `code=1` 退出、无任何栈**。
  遇到「实例莫名退出」先 `df` 一眼，别急着怀疑代码。验收临时 profile 建议放 `%TEMP%` 并在结束前删。

