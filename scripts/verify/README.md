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

## Phase 4（资源守护者：持续资源监控）

**只加"看"，不加"管"**：持续采集 Electron 应用整体的内存/CPU，两档阈值（健康线内完全不打扰、
警戒线发一条人话提示并附「最久未使用实例」排序）——**不设写死数量上限、不自动强制关页、
提示也不阻止任何操作**；监控自身的落盘只留 60s 汇总，默认不落 5s 原始点。
报告见 `docs/acceptance/substage-4/验收报告.md`。

| 文件 | 干什么 |
|---|---|
| `4-resource-guard-tests.py` | **真机验收（101 条）**：自己起假模型+测试站(8898) / 验收后端(8798) / vite(5273) / 真 Electron(9333)。四条标准：①逐档开 5/8/12 张页（每张都验"真的加载完成"），采集值 vs **系统真值**（`tasklist` 工作集 + `typeperf` 逐进程 CPU，另加一条**不依赖自身清单**的独立口径复核），并验采样间隔真的是 5s、CPU 是整机口径；②灰区不打扰、越警戒线触发提示、「最久未使用」排序正确（真鼠标点的先后顺序必须体现在排序里）、「有未结束任务」被标注、提示不阻止操作；③开/关监控的 CPU 对照（同一批 pid，PDH 逐进程求和口径）+ 单次查询代价；④回归（`WITH_REGRESSION=1` 时把 Phase 3 / 2-B 两套整轮重跑）。**另有第 7 节**（补充取证，默认就跑）：自然负载下 CPU 警戒线能否触发，见下。 |
| `resource-query.mjs` | `node resource-query.mjs [userData目录]`：**只读**查 `<userData>/resource-guard/` 的落盘（60s 汇总点 / 提示事件 / 原始采样），不经 UI、不起 Electron。 |

```bash
# 一条命令跑 Phase 4 全部验收（自己起自己收；另建临时 profile，跑完删掉）
C:/Users/bing/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
  scripts/verify/4-resource-guard-tests.py
# 想连「验收标准④回归」一起跑（会再拉起 Phase 3 / 2-B 两套，耗时明显变长）：
WITH_REGRESSION=1 ... scripts/verify/4-resource-guard-tests.py
# 调试时想跳过第 7 节（自然负载，约 6 分钟）：
SKIP_NATURAL_LOAD=1 ... scripts/verify/4-resource-guard-tests.py
# 证据写到 docs/acceptance/substage-4/desktop-tests.json + 截图

# 随时只读看落盘
node scripts/verify/resource-query.mjs "<userData目录>"
```

### 第 7 节：自然负载能不能顶到 CPU 警戒线（补充取证）

前四条标准里的"越线提示"是**把阈值人工压低**逼出来的 —— 那验的是「判定 → 提示」这条链路，
**回答不了**"35% 这条警戒线在定案值下，一个用得很重但不算离谱的场景能不能碰到它"。
第 7 节补的就是这个缺口，三条自我约束缺一条结论就不可信：

1. **阈值全程取定案值，一个都不改**。s4 为了验提示把内存阈值压到 512/300、CPU 抬到 100/1，
   s5 只恢复了开关和频率 —— 所以本节开头先**复位到定案值**，之后不再碰，**结尾回读核对**
   （"没碰过"要能被验证，不是嘴上说说）。
2. **负载必须自然**：真开页（走应用自己的 `openBrowser`，开到配置上限 20 张）+ 真跑任务
   （走应用自己的 `agentStart`，与服务端工具循环、主进程驾驶员是同一套代码），**不拿忙循环凑数**。
3. **负结果也必须可信**：先证"负载确实起来了"（页数 / 并发路数 / 服务端 `liveLoops`），
   再报"没触发" —— 否则"没触发"这三个字分不清是负载不够还是功能坏了。

逐档加码 **4 / 12 / 20 路并发任务**（每档 45s，**峰值与系统真值同一时间窗**），再补第四档
**「同一并发（20 路）+ 重页」**：驱动员的 `read_page` 每步要抽最多 **1500 个正文节点**
（`h1..p/li/td` + cap 1500），而验收页只有 3~4 个 —— 真实站点通常几百到几千，
所以只拿 5 行的验收页去量"跑任务要多少 CPU"，量到的是**下界**。
测试站为此加了 `/page-heavy-<n>`（默认 2000 个正文节点，正好吃满 1500 的 cap），
换页仍走应用自己的 `openBrowser`（同 host → 复用那张页改道 = 原地换掉）。

最后附一段**标定**（辅助证据，不是验收判据）：用可控 Worker 把负载顶到线以上，确认**同一套定案阈值**下
提示真的会出现 —— 这样"到警戒线要几个核"就从推算变成了实测，也把"没触发 = 负载不够"
和"没触发 = 提示坏了"彻底分开。

**六条"负结果不可信"的坑（本轮全踩了一遍）**：

- **每张页必须独占一个 host**。应用的开页规则是「同站 → 复用那张页，不新开」（复用不占额度），
  而第一版循环里只用了 12 个元素的 `PAGE_HOSTS` → 第 13 张开始 host 重复 → **应用把已有页改道了**，
  "开到上限 20 张"实际只开出 12 张，并发路数也被压成 12。回环地址整段 `/8` 都是回环，
  按序生成即可（这里从 `.30` 起跳，避开 s3 已占的 `.2 ~ .13`）。
- **补完路要"立刻回看"，且一轮只打一次 CDP 往返**。重负载下一次 CDP 建连 + 往返实测要好几秒
  （重试的截图连续超时就是同一个原因），一轮里打两次快照 + 一次 `/health`，迭代周期被拖到 ~10 秒；
  而一路循环才活 ~12 秒 —— 于是每次都恰好采到"补路之前"的低点，`lanesMax` 被系统性低估成 12
  （假模型侧明明记到 20 个不同目标）。合并成一次往返 + 补完立即回看，才拿得到真峰值。
- **`/health` 的 `liveLoops` 不适合当"负载是真的"证据**：它只统计 `status === 'running'` 的循环
  （工具循环在两步之间不是 running），本轮全程读到 0。要证"模型真的被调了 N 次"，
  用**假模型自己的请求日志**（`llm.jsonl`：调用次数 + 不同 goal 数）—— 应用改不了它，这才叫独立。
- **探测失败 ≠ 没有路在跑**：`lanes_now()` 必须把"问到空列表"和"没问到（`None`）"分开。
  混成一个的话，一次 CDP 抖动就被读成"所有路都停了"，接着重复发车 → 旧循环作废 + 新循环重建，
  采到的"负载"里混了一堆重启噪声。（同理，收尾的 `wait_until(lambda: lanes_now() == [])`
  不能写成 `not lanes_now()` —— 后者在探测失败时会**假通过**。）
- **重负载下别截图**：CDP 截图在 20 路满载时基本必然超时，两次重试白等好几分钟，
  而截图只是辅助证据 —— 只在最高档留一张就够。
- **补路的节奏要跟着"探测有多慢"走**：补路逻辑挂在采样循环上时，重负载下（重页档探测实测 ~15s/次）
  补路被拖慢 → 并发路数塌到 11/20，看起来像"页变重反而更省 CPU"。除了把补路拆进**独立线程**，
  还要加一层：探测耗时 > 3s 就**按时间盲补**（门槛 13s ≥ 一路的自然寿命 ~12s），
  不再以"已经过期 15 秒的探测结果"为准。另外：**峰值必须除以该档实际维持住的路数**
  （`peakPctPerLane`）——否则"路数少"会被误读成"负载更轻"。

调试时可用 `SECTIONS_ONLY=s1,s2,s7` 只跑前置小节 + 第 7 节（约 10 分钟），
但**正式取证的日志必须是完整一轮**（否则汇总条数少，容易被误读）。

**本轮实测结论（第 8 轮，定案阈值 35% 全程未动）**：

| 档位 | 维持住的并发 | 采集峰值 | 折合核数 | 平均 | 系统真值（同口径） |
|---|---|---|---|---|---|
| 轻页 4 路 | 4/4 | 1.05% | 0.13 | 0.62% | 1.69% |
| 轻页 12 路 | 12/12 | 3.20% | 0.38 | 1.86% | 3.30% |
| 轻页 20 路 | 20/20 | 9.41% | 1.13 | 6.45% | 9.86% |
| 重页 20 路 | 20/20 | **14.68%** | **1.76** | 10.28% | 16.32% |

- **配置允许的最大自然负载够不到线**：峰值 14.68% vs 警戒线 35%，差 **20.32pp（≈2.44 核）**；
  按实测 ≈0.088 核/路，要凑到线需**约 48 路并发**，而 `maxBrowserInstances` / `maxConcurrentAgentTasks` 都夹在 20。
- **线本身是通的**：标定段 5 个 Worker → 峰值 41.77%（≈5.01 核）→ 提示触发，`reasons=["cpu"]`、`cpuWarnPct=35`。
- 换重页（2000 正文节点）后峰值 **+56%**（9.41% → 14.68%），说明这一档确实在量更接近真实的负载。
- 注意 `lanesSeen` 会是"满档 → 掉到 0 → 爬回满档"的锯齿：**20 路是一起发车、也一起到期**（一路 ~12s），
  补路按 13s 的时间表走，所以每个周期末尾有个短缺口。**峰值取的就是 20 路同时在跑的那一刻**，
  平均（avg）则含这个缺口 —— 两个数都记下来，不做取舍。

### Phase 4 新增的坑

- **🔴 CDP 端点会偶发 reset，一次抖动足以毁掉整轮**：第一轮验收里 `/json/list` 被
  `ConnectionResetError [WinError 10054]` 打了一下，**正好落在"写 token + 刷新"那一步** →
  token 没写进去，界面一直停在登录页 → 没有浏览器面板 → 5/8/12 张页全变 0 →
  9 条断言连锁失败。**看日志像"资源采集坏了"，其实功能一行没错。**
  两道修法：①`cdp-probe.py` 的 `_http()` / ws 握手都带重试（成功路径零开销）；
  ②`4-*.py` 里所有 CDP 往返过 `_cdp_call()` 再兜一层，**且登录门单独做最多 3 轮重试**
  （它是整轮的咽喉，不能一次定生死）。
- **`page()` 不能再抛 `SystemExit`**：`SystemExit` 属于 `BaseException`，`except Exception` 兜不住，
  「一次找不到目标」会被升级成「整轮验收直接退出」。改成 `RuntimeError`。
- **单次查询代价别把 CDP 建连算进去**：第一轮报 `ipcAvgMs=42.66`（判 FAIL），实际是
  「每次 `guard_snapshot()` 都新开一条 CDP 连接 + 握手」的耗时。产品开销要**在同一条已建立的
  连接上连打 20 次**再取平均，建连代价单独记一笔。修完这一项的数值才有意义。
- **🔴 CPU 口径：`percentCPUUsage` 已经是"整机口径"，别再除核数**（第一版真错在这里，而且错得隐蔽）：
  想当然以为它是"占一个核的百分比"，于是把"各进程之和"又除以一次 `logicalCores` ——
  12 核机器上把判定灵敏度**缩小 12 倍**（配的 20% 警戒线实际要 240% 才可能到，等于 CPU 这条线废掉）。
  真相在 Electron 源码里：`cpu_dict.Set("percentCPUUsage", GetPlatformIndependentCPUUsage() / processor_count)`
  —— 它已经除过核数了，**一个核跑满读出来是 8.33（=100/12）**。所以：
  `cpuPct` = 各进程之和 = 本应用占整机多少（100% = 所有逻辑核跑满），与任务管理器里"进程 CPU"一致；
  另外给一个 `cpuCoresUsed`（相当于几个核）只用于文案。
  真机取证时就是这么抓到的：一个内嵌页跑满一个核，单进程读数 8.25 ≈ 100/12。
- **🔴 但真值那一侧恰好相反：`typeperf "\Process(*)\% Processor Time"` 是"逐核累加口径"，必须 ÷ 核数**。
  微软文档明说该计数器在 SMP 上可以超过 100%（12 核理论最大 1200%）。第三轮验收把两边**直接相除**，
  得到 `采集 16.58% / 真值 167.02% / ratio=10.07` —— 看着像"采集少了 10 倍"，
  其实 k≈核数正是"口径差一个核数"本身；采集侧那个 16.58% 反而是**对的**
  （2 个 Worker 满载 → 2/12 = 16.67%，实测 16.58%）。
  教训：**"两边都是百分比"不等于"两边同口径"**，凡是拿外部计数器做真值，先问一句"它的 100% 是谁跑满"。
  现在的做法是把换算系数**实测出来**而不是引用文档：
  断言 `k = PDH求和 ÷ 采集整机值` 落在 `[0.45×核数, 2.2×核数]`，再断言换算到同一口径后比值 ∈ 0.5~2.0。
- **CPU 负载要造得"可控"，而且必须与真值"同时"测**（第一版两条都错）：
  ① 负载原本跑在**内嵌页**里 —— 后台页可能被 Chromium 降速/冻结、转不满一个核，"采到的负载"来路不明；
  改成在**主窗口渲染层**里开 2 个 Web Worker 转 40 秒：进程可见、一定吃满、Worker 在独立线程不阻塞 UI
  （界面不假死、CDP 照常能查）。
  ② 采样与 `typeperf` 必须是**真的同时**（不是写成"同时"）—— 第一版是先后执行，忙循环 15 秒早结束了，
  typeperf 才开始量，"真值"读到 0.39%，得出"采集没看见负载"的**错误结论**；
  第二版把两件事塞进**同一个线程**里顺序调用（注释写着"同时测"），实际仍是串行：
  26 秒采样跑完才轮到 typeperf，40 秒的负载只剩最后几秒，真值 6 个采样点里只有 1 个有载。
  正确做法：**两个线程同时 start**（一个读 IPC、一个跑 PDH），负载时长 ≥ 两侧窗口之和。
- **🔴 "开/关监控对比 CPU"这个测法本身会被污染，而且会给出反直觉的负差值**：第四轮红了两条，
  数值是 `关=2.522% 开=0.494%`（差 **-2.028pp**，"开着反倒更省"）。原因不是开销，是 **s4 起的那个真任务在 s5 开始时还没收干净** ——
  服务端工具循环还在跑，正好背在"关监控"那一段上（`maxTotal=8.43%`）：
  一侧背着别人的负载，A/B 就废了。
  三道修法：① 测量前**等真的安静**（`agentLanes` 空 + `/health` 的 `liveLoops=0`）+ 静置几秒让收尾余波落地；
  ② 改成**交替四窗口**（关/开/关/开，各 30s）比**中位数**，把机器漂移摊到两侧；
  ③ **主证据换成"占空比"**：`单次采集耗时 ÷ 采样周期`（实测 0.95ms / 5000ms = 单核 0.019%）。
  这一条是根本 —— 这台机器 30~60s 窗口的噪声可达 ±2pp，比监控真实开销大两个数量级，
  **差值法在这种噪声下本来就测不出来**，能直接归因到采集本身的量才配当判据。
- **"不会变成磁盘负担"要给出量级，不能只说"只有 60s 汇总"**：把落盘换算成
  `一条汇总 N B → 一天约 X KB → 保留 7 天约 Y MB`（实测一条 ~200B 量级），断言 Y 有个上界。
- **断言别照着自己脑补的期望数组比**：「最久未使用」排序那条连红两轮，两次都是期望写错：
  忘了"正在被驾驶的页会被『此刻在用』规则排到最末"（那是刻意的设计），也忘了后面还陆续开了 7 张页。
  正确做法是**只断言我能控制、并且真的做过的事实**：排序单调（非驾驶实例 `lastActiveAt` 非递减）、
  驾驶实例全排在最后、**真鼠标点过两张的先后顺序必须体现在排序里**、列表不剔除任何实例、每一项都指得出是哪张页。
- **`ev_safe` 走的是 async 包装体，里面必须显式 `return`**：`(() => ({...}))()` 当**语句**写，值会被丢掉，
  结果恒为 `None`（`ui_state()` 的 detail 一直是 `ui=null` 就是这么来的）。要写成 `return (() => ({...}))()`。
- **断言里的期望值要用"配置回读值"，不要用"我请求写入的值"**：阈值区间会夹（`maxBrowserInstances` 上限 20、
  `resourceMemWarnMB` 下限 512），拿请求值 30 / 500 去比必然假红。顺带这也是条好断言：越界值被夹到允许区间、且不冲掉别的字段。
- **"Tab 型进程数 ≥ 页数"是个错误前提**：Electron/Chromium 会复用渲染进程 —— 实测开 12 张页只有 3 个 Tab 型进程，
  内存也只从 699MB 涨到 709MB（"每页一个渲染进程"的假设根本不成立）。
  要证"没漏算进程"，得换一个**不依赖被测实现自己那份清单**的口径：系统里所有 `electron.exe` 的进程集合与内存总和
  （`tasklist`）跟采集值对 —— 这才叫独立性复核。
- **`/json/list` 会给一份"不完整的目标列表"**：目标刚建好、浏览器进程忙的时候，它会回一份只有 devtools、
  没有应用页的列表；而"问一次没有就判死"的 `page()` 会把它判成"窗口没了"（2-B 那套就栽在这里）。
  修法：`page()` / `any_target()` 改成**带时间窗**反复问（拿到了就走），超时再抛并把最后看到的目标列表带上，便于事后判断。
- **"连上了"不等于"握手成功"**：Phase 3 那套回归是 ws 连上后 `Runtime.enable` 的 recv 报
  `Connection to remote host was lost.` —— 上一版只对 `create_connection` 做重试，握手半途掉线就漏过去了。
  现在"连 + 启用"当成一个整体重做。另外 `send()` 里遇到连接被关掉会用**新连接把这次调用重做一遍** ——
  只对**连接类异常**重试，**故意不含超时**（超时可能意味着对面正在执行一个有副作用的调用，重做会变成"点两次"）。
- **两套老脚本的汇总格式不一样**：Phase 3 是 `汇总：18 条断言，17 通过，1 失败`，2-B 是 `全部通过（17 条断言）` /
  `N 条失败（共 M 条）`。用同一个正则去解析必然"没解析到汇总行"——`parse_suite_summary()` 三种都认，最后还能数 PASS/FAIL 行兜底。
- **系统真值取证走 `tasklist` / `typeperf`，不走 PowerShell**：本会话实测内置 PowerShell 工具回显恒空、
  从 bash 调 PS 被安全策略拦；`tasklist /FO CSV`（内存工作集，与任务管理器"内存"列同口径）
  与 `typeperf "\Process(<实例>)\% Processor Time"`（CPU，**逐核累加口径，记得 ÷ 核数**）实测可用。
  （`wmic` 本机已不存在，`Get-CimInstance` 那条路走不通，别指望拿命令行过滤进程。）
- **回归套件里的"被取代的期望值"要改，别硬扛**：2-B 那条
  「分区仍按智能体隔离（`persist:workbench-browser-agent-<id>`）」在 Phase 3 之后**必然红** ——
  Phase 3 已验收的改动就是把规则换成 `persist:workbench-browser-project-<projectId>`，
  而且 Phase 3 那套还专门断言"老规则不再产生任何新目录"。这是**期望值过期**，不是回归。
  处理方式：改断言 + 在注释里写明"被哪个阶段取代、语义哪部分不变"，
  别为了让套件变绿而把断言删掉或放宽成恒真。
- **回环地址别名可以造"多个不同站"**：开页复用按 host 判（含端口），而 `127.0.0.0/8` 整段都是回环，
  所以 `127.0.0.2 ~ 127.0.0.13` 是 12 个**真的不同站** —— 不用起 12 个端口。
- **`old_string`/注释紧贴 `export interface` 时 Edit 会不匹配**：`shared/src/index.ts` 里
  `ResourceGuardSnapshot` 的文档注释和 `export interface` 实际是**同一行**（注释后没有换行），
  照"两行"去写 `old_string` 必然失败 —— 先 `Read` 确认再改。

### Phase 4 的三层自清理（**第一版就写进去**，不等出问题再补）

Phase 3 的最后一条教训是"清理不能只挂在跑到底那条路径上"，Phase 4 直接把它做成脚本骨架：

1. **第 1 层 · 跑前清残留**：`purge_leftovers()` 回收同号测试账号 + `kill_stray()` 杀上一轮遗留的
   electron/crashpad + 删临时 profile + 断言四个验收端口空着 —— **每一轮都从零开始**，
   不依赖"上一轮恰好干净"。
2. **第 2 层 · 每节独立 try/except**：`SECTIONS` 里任一小节抛异常只记一条 FAIL，**不打断整轮**
   （Phase 3 那次截图超时把后面 3 个小节全带走了，就是缺这一层）。
3. **第 3 层 · finally 必然复位**：杀进程 → 带重试删 profile → 回收账号 → 回收端口，
   并把"环境已复位"做成断言（profile 不存在 / 11 张表 id 集合回基线 / 端口全空）。

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
