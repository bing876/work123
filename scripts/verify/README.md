# scripts/verify —— 子阶段 A 的真机验收工具

这套东西是**验收用**的，不参与产品运行；留着是为了子阶段 B（资源监控 / 动态限流）能直接复跑同一套取证。

| 文件 | 干什么 |
|---|---|
| `fake-llm.mjs` | 零依赖（只用 `node:http`）的**假模型 + 静态测试页**。每次响应固定延迟 `FAKE_DELAY_MS`，所以「两路循环到底有没有真的重叠」由请求日志的进入/离开时间戳直接看出来；不烧 token、不依赖外网。同时提供 `/page-*`、`/form`（含密码/验证码/支付按钮，供安全红线复验）。 |
| `server-tests.mjs` | **服务端侧**验收：改造点 2（状态按 wcId 分片不串位、任务轮不再覆写 `conversations`、读侧兜底）+ 改造点 3（`advance()` 重入被拒）+ 跨智能体 409 硬闸。**2.x / 8.x 需要数据库**（要读 `conversations` 原始行、要查智能体归属）；库不在时这几条会明确标 `SKIP`，不冒充通过。 |
| `desk-tests.py` | **桌面侧**真机验收：真并发时间线、按 target 暂停、跨智能体、fail-fast、敏感闸、多实例资源占用、并发闸开关回归。 |
| `cdp-probe.py` | CDP 探针（原第 20 步的 `wb20probe.py`，原样留档）。连 `--remote-debugging-port` 上的渲染进程跑 JS / 真键盘输入 / 截图。 |

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
