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
| `2a-api-tests.mjs` | **接口真机验收（54 条）**：自己起 8799 后端 → 用 `SMS_MOCK` 登录**本次新建的测试账号**（手机号自动挑库里没有的）→ 打真实 HTTP 验证 `/projects` 增列改切、母鸡不可删（前端 `deletable=false` + 后端 400 + 库里那行还在 + 正对照普通智能体删得掉）、权限 403/200 可逆、`GET /agents` 按项目过滤、知识库项目隔离；**跑完整体删除测试账号**并断言活库行数与逐表 id 集合回到初始状态。 |
| `2a-migrate-replay.mjs` | **知识库 `project_id` 迁移的迁移前/后对照**：新建 `workbench_2a_check` → 用 **`git show HEAD:.../db.ts` 的真实旧 DDL** 建「迁移前」结构（先断言 4 个新列都不存在）→ 把**活库真实数据**按旧结构搬进去 → 另加**按 owner 的合成放大样本**（活库只有 1 个 owner 有资料，证明不了多账号不串）→ 调 `dist/db.js` 里真正的 `migrate()` → 对照行数、**逐 owner 条数**、**内容 sha256**、逐条归属、NOT NULL 收紧、幂等、不覆盖已选的当前项目。活库**全程只读**，跑完 `DROP DATABASE`（`--keep` 可保留）。 |
| `2a-regression-existing-account.mjs` | **老账号只读回归（13 条）**：用活库里真实存在的老账号（自签 JWT）只发 GET，确认登录项目、`GET /agents`（不带参数 = 改造前行为）、按项目过滤、知识库按项目各归各家、`/memory/user` 都正常；最后断言 11 张表**行数与逐表 id 集合一行没变**。 |
| `db-snapshot.mjs` | **只读数据快照**（`node scripts/verify/db-snapshot.mjs out.json`）：逐表行数 + 迁移目标列是否存在 + `project_id` 空值分布 + 项目/智能体清单。迁移前后取基线的通用工具。 |

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
- **迁移对照必须用「上一个提交的真实 DDL」建迁移前结构**，不能手写近似版，
  也不能拿活库比 —— 活库在开发中**已经跑过一次**迁移了，直接比等于「迁移后 vs 迁移后」。
  脚本里第一步就断言 4 个新列**都不存在**，就是为了证明这份快照确实是真的迁移前。
