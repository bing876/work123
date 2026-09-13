# apps/server —— AI 工作台最小后端（第 5 步 · 重做版）

负责「手机号 + XYZ 号登录」、数据库表、DeepSeek 流式聊天和“一步一问”的驾驶员大脑，以及第 11 步资料知识库：Node + **Fastify 5** + **PostgreSQL** + **JWT**，
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
| `POST /agent/next-action` | **要 JWT** | 第 7 步“云端驾驶员”：`{goal, stepsSummary[], snapshot, paused?}` → 用驾驶员提示词调 DeepSeek（JSON 模式），**只回一个** BrowserAction（含第 9 步 `fill_form` / `focus_sensitive_field`）。模型乱说/坏 JSON/坏网址 → 一律转 `ask_user`；`paused:true` 时服务端物理拦 click/type/open_url/fill_form；第 9 步服务端第二道闸：`type`/`fill_form` 命中敏感字段（快照分类或关键词）→ 自动换成 `focus_sensitive_field`（值即弃）、`click` 命中支付最终确认 → 拒 |
| `POST /agent/task/start` | **要 JWT** | `{goal}` → tasks 表记一条 running（payload.steps 只存一步一句的人话摘要，**绝不存整页 HTML**），返回 `{taskId}` |
| `POST /agent/task/step` | **要 JWT** | `{taskId, summary, ok}` 追加一步摘要（失败自动带「（失败）」） |
| `POST /agent/task/status` | **要 JWT** | `{taskId, status: running\|paused\|done\|failed}` |
| `GET /agent/task/current` | **要 JWT** | 我最近一条任务（含 `unread` 红点、短结论、文档标题——桌面刷新后原样还原） |
| `POST /memories/extract` | **要 JWT** | 第 10 步：桌面「结束」按钮触发一次会话记忆整理（同会话 10 分钟去重窗口）。preference 静默 active；decision/有行为影响的 fact 进 pending 上确认卡；写入前先过敏感闸（密码/验证码/证件/卡号等整条丢弃）；规范化同句不重复入库 |
| `GET /memories` | **要 JWT** | {active:[…], pending:[…]}（「我的记忆」列表 + 确认卡数据源，均本人） |
| `POST /memories/confirm` / `reject` | **要 JWT** | 整卡或逐条：pending→active / →rejected；**确认前绝不注入**，rejected 不再重弹 |
| `POST /memories/forget` | **要 JWT** | active→archived，立即从注入源消失（不提供编辑） |
| `GET /knowledge` | **要 JWT** | 第 11 步：只列当前账号自己的已入库资料元信息（解密后的文件名、类型、段数）；不回传正文 |
| `POST /knowledge/upload` | **要 JWT** | `multipart/form-data` 的 `file` 字段，仅 `.txt/.md/.pdf`、最大 12 MB。txt/md 按 UTF-8 读取，PDF 用 `pdf-parse` 抽文字层；按段落优先、每段最多 900 字切块，文件名和正文片段均 AES-256-GCM 加密入库；原文件不落盘 |
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
- `knowledge_documents`（第 11 步，**独立于 `memories`**）：`owner_id` 账号隔离、`filename_enc`（AES 密文）、`file_kind`（txt/md/pdf）、`byte_size`、`chunk_count`、`created_at`；上传原文件不保存到磁盘或表中
- `knowledge_chunks`（第 11 步）：`document_id`、冗余的 `owner_id`（查询隔离索引）、`chunk_index`、`content_enc`（每个资料原文段的 AES-256-GCM 密文）、`created_at`；`UNIQUE(document_id, chunk_index)`

第 11 步聊天检索只在 `/chat/stream` 的系统提示词末尾追加独立的「知识库检索结果」块：从**当前用户**的加密片段在服务端内存解密后，以本轮消息中 2~6 字中文片段及英文/数字连续词做大小写无关的字面 `includes` 匹配，取最多 4 段。**没有 embedding、向量库、相似度计算，也不会把资料写入 `messages` 或 `memories`，更不会进入 `/agent/next-action` 的驾驶员 JSON。**无命中或检索失败时该块为空，普通聊天照常继续。

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
   （想验证通知挂了任务仍算成：`.env` 设 `NOTIFY_STUB_FAIL=1`）；
9. 第 9 步：非敏感资料（姓名/地址…）——AI 先 `ask_user(reason=need_info)` 在聊天里问，你在聊天里
   答，答完自动继续驾驶并 `fill_form` 代填；敏感资料（密码/验证码/支付/身份证）——AI 一律不代填：
   `focus_sensitive_field` 把窗口前置、光标定位到那个框，聊天只给一句人话提示；你输完并提交，
   driver 检测到导航/标题变化或敏感框消失即自动恢复驾驶（检测不到时 2 分钟提示手动「继续」兜底，
   最长观察 10 分钟）。敏感值全程不进模型、不进 messages/memories/日志。
10. 第 11 步：登录后点左栏「知识库」→「上传资料」，选择 `.txt`、`.md` 或带文字层的 `.pdf`；
    成功提示会显示「已入库，共 N 个片段」，下方列表也会显示文件和段数。随后在聊天中问资料出现过的关键词，
    `/chat/stream` 才会把当前账号命中的资料片段作为独立参考上下文给模型；换账号的资料互不可见。

## 第 9 步：字段分类的敏感关键词表（判不准就来改这里）

单一来源 `apps/desktop/electron/fieldClass.ts`（服务端另有关键词自检兜底）：

| 判定 | 条件 |
| --- | --- |
| password | `input[type=password]`（无条件） |
| otp_guess | 文案含 验证码/校验码/动态口令/短信码/一次性密码/verification/verif/otp/captcha；或含 code **且**是短数字输入（maxlength≤8 / inputmode=numeric|tel / type=tel|number） |
| payment_guess | 文案含 支付/付款/银行卡/信用卡/借记卡/卡号/CVV/CVC/安全码/payment/pay now/checkout/card number/收银台/收款 |
| id_guess | 文案含 身份证/id card/idcard |
| 不代点的按钮 | click 文案命中 立即支付/确认支付/确认付款/去支付/去付款/提交订单/确认订单/pay now/checkout/place order |

已知误伤：`zipcode` 这类「code+短数字」会被判 otp——按“宁可多判”原则保留；被误判的框用户可以自己点。
