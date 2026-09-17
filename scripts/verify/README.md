# scripts/verify —— 真机验收工具

这套东西是**验收用**的，不参与产品运行；留着是为了后续子阶段能直接复跑同一套取证。

## 子阶段 A（并发 / 状态分片）

| 文件 | 干什么 |
|---|---|
| `fake-llm.mjs` | 零依赖（只用 `node:http`）的**假模型 + 静态测试页**。每次响应固定延迟 `FAKE_DELAY_MS`，所以「两路循环到底有没有真的重叠」由请求日志的进入/离开时间戳直接看出来；不烧 token、不依赖外网。同时提供 `/page-*`、`/form`（含密码/验证码/支付按钮，供安全红线复验）。 |
| `server-tests.mjs` | **服务端侧**验收：改造点 2（状态按 wcId 分片不串位、任务轮不再覆写 `conversations`、读侧兜底）+ 改造点 3（`advance()` 重入被拒）+ 跨智能体 409 硬闸。**2.x / 8.x 需要数据库**（要读 `conversations` 原始行、要查智能体归属）；库不在时这几条会明确标 `SKIP`，不冒充通过。 |
| `desk-tests.py` | **桌面侧**真机验收：真并发时间线、按 target 暂停、跨智能体、fail-fast、敏感闸、多实例资源占用、并发闸开关回归。 |
| `cdp-probe.py` | CDP 探针（原第 20 步的 `wb20probe.py`，原样留档）。连 `--remote-debugging-port` 上的渲染进程跑 JS / 真键盘输入 / 截图。 |

## 子阶段 2-A（项目层 / 母鸡 / 知识库归属）

三个 mjs 都是**自包含**的：自己起后端、自己收尾、自己删临时库/临时账号。
默认端口特意避开用户的 8787（验收用 8799 / 8798）。报告见 `docs/acceptance/substage-2a/验收报告.md`。

| 文件 | 干什么 |
|---|---|
| `2a-api-tests.mjs` | **接口真机验收（62 条）**：自己起 8799 后端 → 用 `SMS_MOCK` 登录**本次新建的测试账号**（手机号自动挑库里没有的）→ 打真实 HTTP 验证 `/projects` 增列改切、母鸡不可删（前端 `deletable=false` + 后端 400 + 库里那行还在 + 正对照普通智能体删得掉）、**`asAgentId` 必填（不传/0/'abc'/null 一律 400 且不落数据）**、权限 403/200 可逆、**新智能体归属跟调用者项目走（正反两向对照）**、`GET /agents` 按项目过滤、知识库项目隔离；**跑完整体删除测试账号**并断言活库行数与逐表 id 集合回到初始状态。 |
| `2a-migrate-replay.mjs` | **知识库 `project_id` 迁移的迁移前/后对照**：新建 `workbench_2a_check` → 用 **「加新列之前那个提交」的真实 DDL**（脚本从 HEAD **自动回溯**找到第一个 `db.ts` 里不含新列的提交，可用 `MIGRATE_BASE_COMMIT=<sha>` 覆盖；选中的提交写进证据 JSON）建「迁移前」结构（先断言 4 个新列都不存在）→ 把**活库真实数据**按旧结构搬进去 → 另加**按 owner 的合成放大样本**（活库只有 1 个 owner 有资料，证明不了多账号不串）→ 调 `dist/db.js` 里真正的 `migrate()` → 对照行数、**逐 owner 条数**、**内容 sha256**、`created_at` 指纹、逐条归属、NOT NULL 收紧、幂等、不覆盖已选的当前项目。活库**全程只读**，跑完 `DROP DATABASE`（`--keep` 可保留）。 |
| `2a-regression-existing-account.mjs` | **老账号只读回归（13 条）**：用活库里真实存在的老账号（自签 JWT）只发 GET，确认登录项目、`GET /agents`（不带参数 = 改造前行为）、按项目过滤、知识库按项目各归各家、`/memory/user` 都正常；最后断言 11 张表**行数与逐表 id 集合一行没变**。 |
| `db-snapshot.mjs` | **只读数据快照**（`node scripts/verify/db-snapshot.mjs out.json`）：逐表行数 + 迁移目标列是否存在 + `project_id` 空值分布 + 项目/智能体清单。迁移前后取基线的通用工具。 |

## 子阶段 2-B（最小化前端验证）

`2b-desktop-tests.py` **一条命令跑完全部四条验收**：自己起假模型+假页面(8899) / 验收后端(8799) /
vite(5273) / 真 Electron(9333)，用 CDP 真点真敲，跑完自删测试账号、断言活库零污染、杀进程、删临时 profile。
报告见 `docs/acceptance/substage-2b/验收报告.md`。

| 文件 | 干什么 |
|---|---|
| `2b-desktop-tests.py` | **真机验收（35 条）**，对应四条标准：①「＋ 添加」自动推断调用者（当前项目里 `canCreateAgents=true` 的那个）且归属正确；②建 2 个项目来回切 6 次，名单互不串、且每次 `GET /agents` 都带 `projectId`；③**【最关键】项目 A 里起一个耗时浏览器任务 → 切到项目 B → 等 12s+ → 切回 A**，用「服务端步数/主进程司机步数/`llmCalls` 在 B 里还在涨」「`performance.timeOrigin` 没变（页没被重载）」「guest 计数器在后台继续跑」「相邻模型调用最大间隔 < 8s」证明任务全程没被打断；④知识库按项目归属、两个项目互不可见。 |
| `2b-cleanup.mjs` | `node 2b-cleanup.mjs <userId>`：级联删测试账号，并给出 11 张表**删除前/后**行数指纹，供「活库零污染」取证。 |
| `dbq.mjs` | `node dbq.mjs "<SELECT ...>"`：**只读** SQL 工具（只放 SELECT/WITH），从 `apps/server/.env` 读连接串、输出 JSON，密钥不打印。验收里「直连库读原始行」全靠它。 |

```bash
# 一条命令跑 2-B 全部验收（自己起自己收）
PYTHONIOENCODING=utf-8 C:/Users/bing/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
  scripts/verify/2b-desktop-tests.py
# 证据写到 docs/acceptance/substage-2b/desktop-tests.json + run.log + 截图
```

### 子阶段 2-B 新增的坑

- **flex 挤压这类「DOM 里有、点不到」最坑**：2-B 真踩到两次，都是**布局裁剪**而不是逻辑错。
  第一次：`.sidebar` 是 flex 子项、`min-height:auto` 不肯缩，760px 窗口下内容超出被 `body{overflow:hidden}` 切掉
  → 给 `.sidebar` 加 `overflow-y:auto`。
  第二次：`.agentList` 自己是 `overflow-y:auto`，于是它的 `min-height:auto` 解析成 **0**，左栏一超高就被压成 0 高，
  整颗「＋ 添加」按钮被裁掉（`elementFromPoint` 命中到的是 `.sidebar`）→ 给它加 `flex-shrink:0`，要滚让左栏滚。
  **教训：`overflow:auto` 的 flex 子项在空间不够时会缩到 0，验「按钮点得到」必须用 `elementFromPoint` 命中自检，
  不能只看 `querySelector` 找得到。**
- **开发模式会多一个 `devtools://` 调试目标**：主进程 `openDevTools({mode:'detach'})` 也占一个 CDP page 目标，
  数「应用窗口只有一个」时要把 `devtools://` 排掉，否则会误报「多开窗口」。
- **pg 的 `bigint` 回包是字符串**：`project_id="24"` 跟 int `24` 比会假失败，取回来一律先 `int()`。
- **活库零污染要用「跑前基线」当参照**：拿清理脚本自带的「删除前」去比，那份里含测试账号，怎么比都不等。
  正确做法是主脚本在**跑任何写操作之前**先拍一份 `liveBefore`，最后跟「删完」对。
- dev 模式渲染层由 vite 直供源码，**改 `App.tsx` / `styles.css` 不用重新 build**（只有改主进程才要）。

## Phase 3（浏览器登录态隔离粒度：agentId → projectId）

**只动「登录态 / cookie 存储」这一层**：同项目的多个智能体共用一套 cookie/localStorage/session；
**标签页、任务执行状态、暂停继续仍然按 agentId 隔离**（桶键没动）。不迁移旧的 `agent-*` 分区，允许自然作废。
报告见 `docs/acceptance/substage-3/验收报告.md`。

| 文件 | 干什么 |
|---|---|
| `3-partition-tests.py` | **真机验收（91+ 条）**：自己起登录态测试站+假模型(8897) / 验收后端(8797) / vite(5272) / 真 Electron(9332)，CDP 真点真敲。四条标准：①同项目内 A1 登录后 A2 打开同站就是登录态（页面侧 + 服务端侧双向取证）；②**跨项目隔离**：B1 打开同站是游客，且在 B 里登录过之后 A 的会话不被冲掉，再逐请求核对全程没有一次交叉；③下载物理目录按项目合并、但 `_downloads.jsonl` 每条记录仍带 `agentId`；④回归：标签页归属 / 两路并发 / 暂停继续互不影响 / 切项目切智能体不打断。另含「改造前 vs 改造后」分区目录对照与活库零污染。 |
| `partitions-snapshot.mjs` | `node partitions-snapshot.mjs <userData目录> [out.json]`：只读扫 `<userData>/Partitions/`，把每个分区目录名归类成 `project` / `agent`(旧) / `global-legacy` / `other`，顺带列出 `browser-projects` / `browser-agents` 下的下载目录。**开工前先跑一次留基线**，这是「改造前后对照」的唯一证据来源。 |

```bash
# 一条命令跑 Phase 3 全部验收（自己起自己收；会另建临时 profile，跑完删掉）
PYTHONIOENCODING=utf-8 C:/Users/bing/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
  scripts/verify/3-partition-tests.py
# 证据写到 docs/acceptance/substage-3/desktop-tests.json + run.log + site.jsonl + 截图

# 开工前的分区目录快照（改造前对照基线）
node scripts/verify/partitions-snapshot.mjs "C:/Users/bing/AppData/Roaming/@ai-workbench/desktop" \
  docs/acceptance/substage-3/partitions-before.json
```

`fake-llm.mjs` 在 Phase 3 里**纯增量**多了三个路由（2-A/2-B 用的既有路由一行没动）：
`/sid/<name>`（真的下发 `wbsid` cookie）、`/whoami/<name>`（把 cookie / localStorage / 服务端视角三样都摆出来）、
`/dl/<name>`（回 attachment，触发 Electron 的 `will-download`）。
**身份标记走路径不走 query** —— 「打开 <地址>」的识别正则不含 `?`，带 query 的地址会被截断。

### Phase 3 新增的坑

- **登录态测试页登录后必须「重新请求一次自己」，不能只 `render()`**：站点侧的证据是「请求实际带了什么 cookie」，
  页面只重绘的话服务端永远收不到第二条请求，`/whoami/<name>` 就只有「登录前游客」那一条 ——
  断言会报「站点侧没记录到这次登录」（第一版就是这么假失败的）。改成 `location.reload()` 后，
  页面侧与服务端侧才是**同一次事实**。
- **`guest_state()` 的 `sid` 在 `site` 底下，不在顶层**：结构是
  `{site:{name,cookie,local,sid,href,at}, cookie, local, href, t0}`。第一版 7 处都写成 `s.get('sid')`，
  恒为 `None` → 页面明明已登录（cookie、服务端日志都能证明），断言却报「没登录 / sid=None」。
  统一走 `s_sid(s)`，别再直接 `.get('sid')`。
- **一个分区分给多个智能体后，`will-download` 的归属不能再取闭包里的 `contents`**（这是 Phase 3 的**真 bug**）：
  以前一个智能体一个分区，`contents` 就是「那一只」；改成按项目后同项目多个智能体共用一个 session，
  而 `will-download` 是在 **session** 上挂的，闭包捕获的 `contents` 只是**第一个**创建这个 session 的页 ——
  结果 A2 的下载被记成 A1。**必须取回调的第三个参数**（真正发起下载的那个 guest webContents）：
  `ses.on('will-download', (_e, item, fromWc) => ownerAgentOf((fromWc ?? contents).id))`。
  真机取证一眼就看出来了（同一个项目目录下两个文件，记录里的 agentId 却一样）。
- **删临时 profile 必须「先杀进程再删目录」**：Electron 还在跑的时候 profile 下的
  `Cookies` / `Local Storage` 等文件是被占用的，`shutil.rmtree(ignore_errors=True)` 会**静默留下一半**，
  断言就报「没删掉」。正确顺序：`kill_all()` → 等一下 → 带重试地 `rmtree`。原来这条写在 `finally` 的 `kill_all()` 之前，所以必假失败。
- **「暂停」不能撤掉已经发出去的模型调用**：HTTP 已经在路上，所以暂停瞬间**在途的那一步会落地**（+1 步是正常的）。
  验「暂停真的生效」要看**观测窗内是否还在推进**（多次采样的首尾是否相同）+ 上限（≤ 暂停前 +1）+ `phase == 'paused'`，
  不能要求「暂停后步数一个都不许涨」。
- **「从隔离改共享」最容易改过头**：验收要**双向**证 ——既证同项目共享（A2 拿到 A1 的会话），
  也证跨项目不串（B1 是游客、且 B 登录后冲不掉 A）。再加一条「逐请求核对每一页带的 sid 都落在它自己该有的集合里」，
  比只挑几对来比更难糊弄。身份标记的 `selftest`（脚本直接探站那一下）不在任何分区里，核对时要排掉。
- **截图必须兜底，绝不能拖垮整轮验收**：`Page.captureScreenshot` 页面多 / 页面忙时会不回包（CDP 已知抖动）。
  第一版 `shot()` 没 try，一次超时直接把后面「并发 / 暂停 / 前后对照 / 零污染」全打断 ——
  日志停在「68 条通过」看起来像功能坏了，其实只是那张图没拍到。
  截图是**辅助证据、不参与断言**，所以只记录成功/失败（并重试一次 + 拍之前先 `sleep 0.8`），失败就跳过继续。
- **证据要用「现读」，别用早先那一刻的快照**：`site_who_b1` 是「B1 刚打开时」抓的 list 快照，
  只含"登录前游客"那一条；拿它去证「B1 登录前后各一条」等于用半句真话糊弄（而且断言名还在声称两件事）。
  凡是要当证据的列表，都在**断言处**重新从日志现读一遍。
- **🔴 清理不能只挂在「跑到底」那条路径上**（这条差点毁掉一整轮）：中途抛异常 → 直接跳 `except`/`finally`，
  **section 9 的删账号整个被跳过** → 测试账号连同它的项目/智能体/消息留在**活库**里 →
  下一轮「测试账号是干净的」前提失败，整轮跑废（第三轮截图超时就是这么把 user 22 留下的）。
  两道保险：①**开跑前**按固定手机号回收同号残留（幂等，见 `phone_hash_of()`：纯 Python 算
  `HMAC-SHA256(PHONE_PEPPER 或 DATA_KEY, phone)`，与服务端 `crypto.ts` 同一套，密钥只进内存不打印）；
  ②`finally` 里**再回收一次**，异常路径也兜住。
  顺带一条自检：登录后断言「算出的 hash 正好唯一命中本次账号」——否则回收可能一直在对着空气删。

## 复跑步骤

```bash
# 0) 依赖：python 装 websocket-client；本机 python 在
#    C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe

# 1) 假模型 + 测试页（页面端口要与 desk-tests.py 里的 urls 一致）
node scripts/verify/fake-llm.mjs                      # 8899
FAKE_PORT=8898 node scripts/verify/fake-llm.mjs       # 8898（第二个站点：同站复用是按 host 判的）

# 2) 自己的后端（**不要动用户的 8787**），指向假模型
cd apps/server && PORT=8799 DEEPSEEK_BASE_URL=http://127.0.0.1:8899 DEEPSEEK_API_KEY=any npx tsx src/index.ts

# 3) 登录拿 JWT（验证码只进上面那条命令的日志），存到 token 文件（别回显）
curl -X POST 127.0.0.1:8799/auth/sms/send -d '{"phone":"18665594441"}' -H 'content-type: application/json'
curl -X POST 127.0.0.1:8799/auth/login/sms -d '{"phone":"18665594441","code":"<日志里的 6 位>"}' -H 'content-type: application/json'

# 4) 自己的桌面实例：另起 vite（5273）+ electron（独立 profile + 9333）
cd apps/desktop && npx vite --port 5273 --strictPort
VITE_DEV_SERVER_URL=http://localhost:5273 node scripts/start-electron.mjs \
  --user-data-dir=<自己的临时目录> --remote-debugging-port=9333
# 在渲染进程里把后端指到 8799：localStorage['workbench.apiBase']='http://127.0.0.1:8799'，再注入 token 后 reload

# 5) 跑（server-tests.mjs 跑之前把里面的 BASE 指到 8799）
node scripts/verify/server-tests.mjs
python scripts/verify/desk-tests.py setup|concurrency|pause|crossagent|failfast|sensitive|resources|gate
```

## 子阶段 2-A 复跑（零手工，自己起自己收）

```bash
# 迁移前后对照：自建 workbench_2a_check、跑完自删（--keep 可留库排查）
node scripts/verify/2a-migrate-replay.mjs

# 接口真机验收：自建 8799 后端 + 新建测试账号，跑完删账号并断言活库零残留
node scripts/verify/2a-api-tests.mjs

# 老账号只读回归：自建 8798 后端，自签 JWT 只发 GET，断言 11 张表零改动
node scripts/verify/2a-regression-existing-account.mjs [userId]

# 任意时刻取只读基线
node scripts/verify/db-snapshot.mjs docs/acceptance/substage-2a/db-before.json
```

前提：`npm run typecheck && npm run build -w @ai-workbench/shared && npm run build -w @ai-workbench/server`
（`2a-migrate-replay` 读的是 `apps/server/dist/db.js`，**构建产物必须比 src 新**）。

## 注意（都是踩过的）

- `desk-tests.py` / `server-tests.mjs` 里的**绝对路径是写死的**（`C:/Users/bing/AppData/Local/Temp/subA/`），换机器要改。
- **`server-tests.mjs` 的 2.x 断言直连数据库**（`require('<repo>/node_modules/pg')` + 手工解析 `apps/server/.env`）：
  因为 `GET /chat/state` 现在会做「读侧兜底合并」，拿它当「`conversations` 有没有被覆写」的证据等于自证自话。
  密钥只进内存、绝不打印。库没起时这几条标 `SKIP`。
- **起 Electron 必须清掉 `ELECTRON_RUN_AS_NODE`**：本机会话环境会设它，Electron 会被当成普通 Node 跑，
  启动 0 秒就崩（`Cannot read properties of undefined (reading 'isPackaged')`，退出码 1）——
  很容易误判成「刚改坏了」。正确起法：
  `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node scripts/start-electron.mjs ...`
- **开页复用按 host 判**（`sameSite` 比的是 `host`，含端口）——想同时开多张页就得用不同端口/域名，否则会复用同一张 tab。
  （`desk-tests.py` 的 `resources` 用例因此要 8892–8899 八个端口都在。）
- **`liveLoops` 会被「建了循环但没人驱动」的条目读歪**：一个循环只在 `advance()` 被调用时才会离开 `running`，
  所以任务轮建了循环而桌面没去驱动、或者某一路放下时没来得及 `/agent/loop/stop`，它都会以 `running`
  挂到 10 分钟 TTL 到期。取证前最好**重启后端**拿到干净基线，别把 7~8 当成真实并发路数。
- `Page.captureScreenshot` 在页面多 / 页面忙时**会不回包**（见 `MEMORY.md` 第七节），截图失败不代表功能坏。
- 验收实例要单独 `--user-data-dir`：否则会撞上单实例锁，静默退出（退出码 0）。
- 跑完记得清自己的进程与临时目录；**用户自己的 5173 / 8787 一律不动**。

### 子阶段 2-A 新增的四条坑

- **脚本自己起的后端必须确认端口是空的**。2-A 的脚本第一版异常退出时没杀干净子孙进程
  （`spawn(taskkill)` 之后立刻 `process.exit`，taskkill 根本没跑），残留实例占着 8799；
  下一轮新起的实例直接 `EADDRINUSE`，而健康检查却打到了**残留实例**上 ——
  测试「跑得下去」但日志是空的（验证码读不到），很容易误判成功能坏了。
  现在脚本会**先探端口**、收尾用 `spawnSync(taskkill /F /T)` 并复验端口已释放。
- **等日志里的验证码（`SMS_MOCK=1`）不能用 `Atomics.wait` 同步睡**：主线程被锁死，
  stdout 管道数据永远刷不进日志文件，等 20 秒也等不到。必须 `await setTimeout` 让出事件循环。
- **`users.current_project_id` 是「用户选过的」，迁移只补空值、绝不覆盖**。
  验这条得先手工把它设成非默认项目再跑迁移（脚本已内置）。
- **迁移对照必须用「加新列之前那个提交的真实 DDL」建迁移前结构**，不能手写近似版，
  也不能拿活库比 —— 活库在开发中**已经跑过一次**迁移了，直接比等于「迁移后 vs 迁移后」。
  脚本里第一步就断言 4 个新列**都不存在**，就是为了证明这份快照确实是真的迁移前。
- **⚠️ 别把基线写死成 `HEAD`**（这是 2-A 修正时才暴露的：改动没提交时 `HEAD` 恰好 = 改动前，
  脚本「碰巧正确」；一提交进历史，`HEAD` 就变成改动后，`git show HEAD:db.ts` 的 DDL 自带新列 →
  验收库的「迁移前」结构其实已经是迁移后，**整条对照静默失效**，只剩那条「列不存在」的断言在报警）。
  现在改成从 HEAD **自动回溯**找第一个不含新列的提交，并把选中的 sha 写进证据 JSON。
- **内容指纹别把 `created_at` 算进去**：那是「往一次性验收库里插入的时刻」，每轮都不同，
  带上它摘要就跨轮不可复现（同一个库内容相同、摘要却变），没法当跨轮证据。
  写入时刻是否被迁移改动，用另一个 `id+created_at` 指纹做**同一轮内**的前后对比。
- **`POST /agents` 现在必须带 `asAgentId`**（2-A 修正把默认回落删了，属**故意的不兼容改动**）：
  桌面端 `App.tsx` 那句 `body: '{}'` 暂时会拿到 400，等 2-B 接项目层时补上调用者。
