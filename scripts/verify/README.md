# scripts/verify —— 子阶段 A 的真机验收工具

这套东西是**验收用**的，不参与产品运行；留着是为了子阶段 B（资源监控 / 动态限流）能直接复跑同一套取证。

| 文件 | 干什么 |
|---|---|
| `fake-llm.mjs` | 零依赖（只用 `node:http`）的**假模型 + 静态测试页**。每次响应固定延迟 `FAKE_DELAY_MS`，所以「两路循环到底有没有真的重叠」由请求日志的进入/离开时间戳直接看出来；不烧 token、不依赖外网。同时提供 `/page-*`、`/form`（含密码/验证码/支付按钮，供安全红线复验）。 |
| `server-tests.mjs` | **服务端侧**验收：改造点 2（状态按 wcId 分片不串位）+ 改造点 3（`advance()` 重入被拒）。 |
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
- **开页复用按 host 判**（`sameSite` 比的是 `host`，含端口）——想同时开多张页就得用不同端口/域名，否则会复用同一张 tab。
- `Page.captureScreenshot` 在页面多 / 页面忙时**会不回包**（见 `MEMORY.md` 第七节），截图失败不代表功能坏。
- 验收实例要单独 `--user-data-dir`：否则会撞上单实例锁，静默退出（退出码 0）。
- 跑完记得清自己的进程与临时目录；**用户自己的 5173 / 8787 一律不动**。
