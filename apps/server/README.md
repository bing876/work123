# apps/server —— AI 工作台最小后端（第 5 步 · 重做版）

负责「手机号 + XYZ 号登录」、数据库表、DeepSeek 流式聊天和“一步一问”的驾驶员大脑：Node + **Fastify 5** + **PostgreSQL** + **JWT**，
接且只接 DeepSeek 聊天（只说话、不指挥浏览器），**没有邮箱登录、没有真微信**。
（早先按邮箱/用户名做的版本已整体作废，本目录是按新账号说明重写的。）

## 先起数据库（本机 Docker）

```bash
npm run db:up          # = docker compose -f apps/server/docker-compose.yml up -d
```

库没起时服务**不会崩**：`/health` 报 `db:"down"`，`/auth/*` 回 503 并用人话提示先 `npm run db:up`。

## 环境变量（全部必填项在 apps/server/.env.example；只提交模板，真实 .env 不入库）

```bash
cd apps/server
cp .env.example .env
# .env 至少填两个（生成命令见 .env.example 注释）：
#   JWT_SECRET=<≥32 字符随机串>     # 签 JWT
#   DATA_KEY=<64 位 hex（32 字节）>  # AES-256-GCM 加密 messages.content / 手机号密文列
# 可选：
#   PHONE_PEPPER=<随机串>            # 手机号哈希胡椒（「一手机一用户」靠它）；没配回退用 DATA_KEY
#   SMS_MOCK=1                       # 开发：验证码只写服务器日志（生产模式下无效）
#   DEEPSEEK_API_KEY=sk-...          # 第 6 步聊天用；不填不崩，/chat/stream 明确回「未配置模型」
#   DEEPSEEK_BASE_URL / DEEPSEEK_MODEL  # 可选，默认 https://api.deepseek.com / deepseek-chat
#   SMS_HTTP_URL=https://...         # 生产：POST {phone, code} 的短信网关
```

这三个密钥**只从环境变量来**，缺失则服务拒绝启动；绝不写进代码或提交进 git。

## 本地跑

```bash
npm install                  # 仓库根，一次装齐所有 workspace
npm run dev:server           # tsx watch，监听 127.0.0.1:8787
npm run typecheck            # 三个 workspace（shared/desktop/server）全部过编译
npm run build                # 含 tsc 编译 server → apps/server/dist/
node apps/server/dist/index.js   # 生产式启动（先在 .env 里 NODE_ENV=production）
```

## 接口面

| 方法与路径 | 登录 | 说明 |
| --- | --- | --- |
| `GET /health` | 免 | `{ok:true, db:'up'/'down', sms:'mock'/'http'}`；库挂了也返回 200 |
| `POST /auth/sms/send` | 免 | `{phone}`。6 位码 5 分钟有效；同号码 60 秒防连发 + 每小时 10 条；每 IP 每分钟 20 次。**响应不含验证码**：开发模式码只进服务器日志（`[sms:mock]` 行），生产必须配 `SMS_HTTP_URL`，没配回 503 人话 |
| `POST /auth/login/sms` | 免 | `{phone, code}`。验证码正确即登录；**未注册手机号自动建号**（分配 `XYZ+5位数字`、建默认项目 + Agent「小助」，同事务）；错 5 次作废 |
| `POST /auth/login/xyz` | 免 | `{xyz, password}`（`xyz` 支持 `xyz10001` 或 `10001`）。**没设过密码 → 明确失败** `code:"password_not_set"`，不是含糊的“密码错误” |
| `POST /auth/password/set` | **要 JWT** | `{new_password, old_password?}`。≥8 位 scrypt 哈希入库；已有密码必须带正确 `old_password` |
| `GET /auth/me` | **要 JWT** | `{user{id, xyz_id, has_password, phone_masked}, project, agents}`；无/坏 token 401 |
| `POST /agent/next-action` | **要 JWT** | 第 7 步“云端驾驶员”：`{goal, stepsSummary[], snapshot, paused?}` → 用驾驶员提示词调 DeepSeek（JSON 模式），**只回一个** BrowserAction。模型乱说/坏 JSON/坏网址 → 一律转 `ask_user`；`paused:true` 时服务端也物理拦 click/type/open_url |
| `POST /agent/task/start` | **要 JWT** | `{goal}` → tasks 表记一条 running（payload.steps 只存一步一句的人话摘要，**绝不存整页 HTML**），返回 `{taskId}` |
| `POST /agent/task/step` | **要 JWT** | `{taskId, summary, ok}` 追加一步摘要（失败自动带「（失败）」） |
| `POST /agent/task/status` | **要 JWT** | `{taskId, status: running\|paused\|done\|failed}` |
| `GET /agent/task/current` | **要 JWT** | 我最近一条任务（含 `unread` 红点、短结论、文档标题——桌面刷新后原样还原） |
| `POST /agent/task/finish` | **要 JWT** | 第 8 步 done 收尾：调模型整理一次（JSON：summary/文档标题/Markdown/红点提示）；**没配 Key 或模型乱答 → 用已有字段兜底生成，绝不卡死也绝不编造**；文档 AES 密文进 `tasks.result_enc`，`unread=true`，然后调通知桩 |
| `GET /agent/task/doc` | **要 JWT** | `?taskId=` 解密回传整份 Markdown（下载用；只认自己的任务） |
| `POST /agent/task/read` | **要 JWT** | 看完结果标已读：`unread=false`（红点熄灭；刷新后仍是已读） |
| `GET /auth/wechat/status` | 免 | 恒为 `{enabled:false}` —— 本步只预留 |
| `POST /chat/stream` | **要 JWT** | `{conversationId?, message}`。**SSE 流式**：`meta`(带会话号) → 若干 `{"delta"}` → `done`；助手全文完成才写库，中断只回 `error` 事件、绝不留半截“成功”。未配 `DEEPSEEK_API_KEY` → 503 `llm_not_configured`（不装样子）|
| `GET /chat/history` | **要 JWT** | `?conversationId=` 可省（默认你最近一条会话）；返回解密后的 `messages`，桌面重启后还原用 |
| `POST /auth/wechat/login` | 免 | 恒为 `501 {code:'wechat_not_enabled'}`，**绝不发 JWT** |

三个登录成功接口（login/sms、login/xyz）返回同一形状：

```json
{ "token": "<JWT，7 天>", "user": { "id": 1, "xyz_id": "XYZ10001", "has_password": false, "phone_masked": "138****8000" },
  "project": { "id": 1, "name": "默认项目" }, "agents": [ { "id": 1, "name": "小助" } ] }
```

## 表（启动时自动 `CREATE TABLE IF NOT EXISTS`，幂等）

- `users`：`xyz_id` TEXT UNIQUE（对外号，用户不能自选）｜`phone_hash` UNIQUE（HMAC(pepper,手机号)——一手机一用户）｜`phone_enc` AES 密文（仅备展示）｜`password_hash` **可空**｜`wechat_openid` UNIQUE 可空 + `wechat_unionid` 可空（**本步预留，永远空**）｜`created_at`
- `sms_codes`：`code_hash = sha256(salt$code)`——**库里只存哈希**，每行随机 salt；`expires_at`（5 分钟）/`attempts`（>5 作废）/`used`；60 秒冷却按 `MAX(created_at)` 判
- `projects` / `agents` / `conversations` / `tasks` / `memories`：带外键 + 索引，`tasks` 有 `updated_at` 列，本步只建表不开发业务接口
- `messages`：正文列是 `content_enc`（AES-256-GCM 密文），写入路径留给后续步骤

**手机号、短信验证码、密码都不存明文**：日志只打 `[sms:mock] → 138****8000 验证码 123456（仅开发模式）`，全号与凭证不进日志、不进响应。

## 与桌面的联调

1. 终端 A：`npm run dev:server`（127.0.0.1:8787）；确认日志出现「短信模式：mock」；
2. 终端 B：`npm run dev` → 桌面**先显示登录页**（手机验证码 / XYZ+密码 / 微信「即将开通」三个入口）；
3. 登录页填 `13800138000` → 点「获取验证码」→ 回终端 A 抄 `[sms:mock]` 那行的 6 位码 → 登录；
4. 未注册手机号当场建号：欢迎条显示你的 `XYZ` 号 → 进原来的三栏工作台（左栏「我的账号」可设密码、查号）；
5. 设完密码后可退出、用 `XYZ+密码` 再登；没设过密码的号走这条路会收到明确失败提示；
6. 点微信入口只会弹「即将开通」，不会进工作台（服务端对应接口 501，不发 token）；
7. 第 7 步：聊天里问「帮我打开百度搜天气」→ 小助回「这需要用工作台浏览器，确认后我开始操作」→
   点气泡下的「确认 · 用工作台浏览器开始」（或输入框写好目标点「开始任务」）→ 主进程循环开始：
   每轮 read_page → `/agent/next-action` 拿**一个**动作 → driver 执行 → 记一步摘要。
   「暂停/我来操作」立刻停手；「继续」先读当前真实页再问下一步（不重放旧动作）；
   模型没配 Key 时开始任务会收到明确错误，不崩、不瞎点；
8. 第 8 步：任务 done 后小助头像亮红点（`tasks.unread`，跟登录用户走），任务卡「查看结果」→
   展开短结论 + 「下载文档（.md）」，看过即红点灭；通知只打 `[notify:noop]` 日志
   （想验证通知挂了任务仍算成：`.env` 设 `NOTIFY_STUB_FAIL=1`）。
