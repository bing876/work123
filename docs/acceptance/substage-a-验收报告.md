# 子阶段 A 验收报告 —— 并发闸 / 状态按页分片 / advance 重入保护

> 范围：**只做这三件事**（+ 一个由改造点 2 直接引出的**读侧兜底**，见 §2.4 / §5.2）。
> 不做资源监控与动态限流（子阶段 B）、不改前端 UI、不改「按智能体分区」规则、
> 不引入第三方并发/消息队列依赖、不弱化敏感闸。
> 取证方式：**真机跑**（真后端 + 真 Electron + 真内嵌页 + 真 CDP），不是读代码推断。
> 原始取证：`docs/acceptance/substage-a-evidence.json`（八组用例的完整输出，**已合并复验结果**）
> + `substage-a-8-pages-and-settings.png`。
> 复跑工具与步骤：`scripts/verify/README.md`。

---

## 0. 结论速览

| # | 改造点 | 结论 |
|---|---|---|
| 1 | 并发闸默认 1 → **20**，开关本身保留 | ✅ 默认值已是 20；上限 8→20；把上限调回 1 时第 2 路**仍被明确拒绝**（开关没被拆掉） |
| 2 | 8 个字段从「一个智能体一条会话」拆出**按 wcId 分片** | ✅ 新建内存注册表 `pageState.ts`（选型理由见 §2.1）；任务轮不再覆写 `conversations` 的任务态列；两个并发任务的 `current_task` / `last_page_summary` 各是各的 |
| 3 | `advance()` 重入保护 | ✅ 同一条 loopId 并发两次 `next`：一次 200、一次 **409 `loop_busy`**，话术明确、不排队、不静默；被拒后循环仍可正常推进 |
| 3b | **读侧兜底**（由改造点 2 引出，非新增需求） | ✅ 任务轮不再写 `conversations.current_task`，桌面「当前任务」那一行改由 `GET /chat/state` 用页级状态**只填空不覆盖**地补上；直连数据库证明 `conversations` 任务态列一行未被覆写 |

8 条验收标准 **全部通过**，其中「真并发」「状态不串位」「重入被拒」有**毫秒级时间戳**级证据。
全部用例在**最终代码树**上又复跑过一遍（§4.9）。
另发现 **8 个审计时没预料到的问题**（§5），其中 3 个已在本阶段修掉，其余按边界留给后续阶段。

---

## 1. 改造点 1：并发闸默认值 1 → 20（开关保留）

### 1.1 改了什么

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | `DEFAULT_SETTINGS.maxConcurrentAgentTasks: 1 → 20`；`SETTINGS_RANGE.maxConcurrentAgentTasks: {min:1,max:8} → {min:1,max:20}` |
| `apps/desktop/electron/main.ts` | **未改**并发闸逻辑本身（`lanes.size >= limit` 时拒绝发车并给一句人话） |

**为什么必须同时放宽区间**：`electron/settings.ts` 的 `normalizeSettings()` 会把每个值**夹到区间里**。
只把默认值改成 20、区间仍写 8 的话，默认值会被自己夹回 8 —— 这是个很容易漏的坑。

**为什么不动渲染层**：`App.tsx` 里那份 `SETTINGS_FALLBACK` 只是首帧兜底，**并发闸的实际判定在主进程**
（`main.ts` 读 `settings.ts` 的权威副本）。子阶段 A 明确「不改前端 UI 代码」，所以那份旧值**原样保留**，
只在 §5 记为待办。

### 1.2 真机证据

```
window.workbench.getSettings()  →  {"maxConcurrentAgentTasks":20,"maxBrowserInstances":4}
设置面板两个数字输入框           →  ["20","8"]        （截图 substage-a-8-pages-and-settings.png）
```

**开关本身还在**（把上限调回 1，第 2 路必须被拒）——`gate.json`：

| 观测点 | 值 |
|---|---|
| 设 `maxConcurrentAgentTasks=1` | ✅ 生效 |
| 第 1 路发车 | `running`，`wcId=3` |
| 第 2 路发车 | **被拒**：`lanes = [3]`（没有第 4 路），第 2 张页的任务状态仍是 `idle` |

---

## 2. 改造点 2：状态归属重构（按 wcId 分片）

### 2.1 选型：内存注册表，不是新建数据库表

**新建 `apps/server/src/pageState.ts`**，按 `wcId` 分片的内存 `Map`。理由（与现状风格对齐）：

1. **生命周期和 `toolLoop.ts` 的 `LoopSession` 完全一致** —— 循环起来才有、闲置回收就没。
   `LoopSession` 本身就是内存 `Map` + TTL，文件头明确写着「进程重启即丢——本步明确不做重启恢复」。
   放数据库会出现「循环早没了、状态还留着」的孤儿行，还得额外写清理任务，**生命周期对不齐**。
2. **改动最小**：零 DDL、零迁移，也不给每一步工具回执加一次数据库往返（循环热路径原本根本不碰库）。
3. **同一套 id 体系**：key 就是 `LoopSession.wcId`，条目里还记着 `loopId`（= `LoopSession.id`），
   **没有引入第三套 id**。
4. 容量/TTL 与循环对齐：最多 64 条、闲置 10 分钟回收（对应 `MAX_LIVE_LOOPS=32` / `LOOP_TTL_MS=10min`）。
5. 将来若要「重启恢复」，只要把这一层的读写换成一张 `page_states` 表，接口形状不用动。

### 2.2 存哪 8 个字段

分片表里放**任务态 7 个**：`current_task` / `latest_user_intent` / `browser_confirmed` /
`login_required` / `sensitive_action` / `last_page_summary` / `already_told_user_login_themselves`。

**`keepalive` 刻意留在 `conversations`**，理由（这是唯一一处与「8 个字段」字面不完全一致的地方）：
它是**智能体级**的「启动并保活」开关 —— 写它的地方（`POST /chat/state`）与读它的地方
（`GET /agents` 列表的 `listening`，`keepaliveOfAgent`）**都没有 wcId 这一维**，一个智能体就一个值。
硬塞进按页分片只会变成「每张页一份、没人知道该读哪一份」。它本来就不是「某个具体浏览器任务的实时状态」，
与「`conversations` 不再承载浏览器任务实时状态」这条要求并不冲突。
（另外：`conversations` 的**表结构与唯一约束一行未动**，那几列继续存在，只是任务轮不再写它们。）

### 2.3 改了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `apps/server/src/pageState.ts` | **新增**。`pageStateOf` / `loadPageState` / `patchPageState` / `bindPageLoop` / `listPageStates` / `pageStateCount` / `summaryFromSnapshot` / `latestPageStateOfAgent`。条目带 `userId`（读接口只回自己的） |
| `apps/server/src/sessionState.ts` | `applyUserMessage` 新增 `opts.page`：**任务轮**传了 wcId 就把任务态写进分片、`conversations` 只更新 agent 级聚合（`browser_confirmed`）；**不传时行为与改造前逐字一致** |
| `apps/server/src/toolLoop.ts` | ① `startLoop` 的状态 brief 改由分片提供（`resolveLoopBrief`，会话态只当**首次**种子）；② `advance()` 每步把推进结果写回分片（`syncPageState`）；③ `LoopSession` 新增 `advancing`（改造点 3） |
| `apps/server/src/routes/chat.ts` | 任务轮把 `page:{wcId,userId,agentId}` 传给 `applyUserMessage`；wcId 解析提到前面复用一次。**另**：`GET /chat/state` 增加 `mergeLatestPageState()`（读侧兜底，见 §2.4 第 4 条 / §5.2） |
| `apps/server/src/routes/loop.ts` | 新增 `GET /agent/loop/state`（按页读分片状态的**诊断/取证接口**，JWT + 归属校验，别人的页 404） |
| `apps/server/src/index.ts` | `/health` 增加 `pageStates` 计数 |

### 2.4 「哪些读这些字段的路径需要同步改」——完整清单

| 现有读/写路径 | 处置 | 理由 |
|---|---|---|
| `/agent/loop/start`（`routes/loop.ts`）读会话状态喂循环 | **改**：循环状态改从按 wcId 分片取；`conversations` 那份只当**首次种子** | 这正是「同一智能体两个任务共用一份状态」的根因 |
| `/chat/stream` 任务轮（`routes/chat.ts`）写会话状态 | **改**：任务态写进分片；`conversations` 只留 agent 级 `browser_confirmed` | 任务轮本来就是「某一张页上的一个任务」，粒度错了 |
| `advance()`（`toolLoop.ts`）循环执行过程 | **改**：每步把任务态写回分片 | 原来循环**根本不写**这些字段 —— 所以 `last_page_summary` 永远是会话级那一个值，两个任务共用 |
| `/chat/stream` **闲聊轮**读会话状态拼系统提示词 | **不改** | 闲聊请求里没有 wcId，它本来就是「这个智能体」的粒度；改它就得先让桌面在闲聊时也报 wcId（前端改动，越界） |
| `GET /chat/state`（桌面「当前任务」那一行 + 重启恢复用） | **改**（`mergeLatestPageState`）：会话级**优先**，会话级为空时用该智能体名下**最近被碰过的那张页**补上 | 任务轮不再写 `conversations.current_task`，而桌面 `.taskState` 那一行读的就是它 —— 不改就会出现「下完网页任务、左栏当前任务反而空了」的**功能退步**。**只填空、不覆盖**：闲聊轮写进去的值照旧优先 |
| `POST /chat/state`（keepalive）/ `agents.ts:keepaliveOfAgent` | **不改** | `keepalive` 是智能体级，见 §2.2 |
| `apps/desktop/src/App.tsx` 的状态条显示 | **不改** | 前端 UI，本阶段边界外 |

> 一句话：**页级（任务态）走新存储，会话级（agent 级标志 + keepalive）继续走 `conversations`**；
> 两边的入口都还是 `sessionState.ts`，没有出现第二套写法。

### 2.5 真机证据（验收 4）

**服务端侧**（`server-tests.mjs`，同一个智能体 agentId=1、两张页 wcId=70011/70012，并发推进）：

| 断言 | 结果 |
|---|---|
| 4.1 两张页各自有独立分片记录 | ✅ `wcId: [70011, 70012]` |
| 4.2 `current_task` 不串位 | ✅ A=`甲任务：在 A 页上找报价` / B=`乙任务：在 B 页上找联系方式` |
| 4.3 `last_page_summary` 不串位 | ✅ A=`已读 …/page-a · 验收页 PAGE-A` / B=`已读 …/page-b · 验收页 PAGE-B` |
| 4.4 诊断接口可读 | ✅ `count=3`，`pages=[70001,70011,70012]` |
| 4.5 各自再推进一步仍各写各的 | ✅ A=`…/page-a?p=2` / B=`…/page-b?p=2` |
| 4.6 没在册的页 → 404（不泄漏） | ✅ 404 |
| 4.7 `/health` 暴露 `pageStates` | ✅ `pageStates: 3` |

**桌面侧**（真 Electron + 真 webview，两路循环各读自己那张页）：

```json
wcId 3 → current_task "并发任务甲：整理 A 页要点"  last_page_summary "已读 http://127.0.0.1:8899/page-a · 验收页 PAGE-A"
wcId 4 → current_task "并发任务乙：整理 B 页要点"  last_page_summary "已读 http://127.0.0.1:8898/page-b · 验收页 PAGE-B"
```

**任务轮不再覆写 `conversations` + 读侧兜底**（用一个**全新临时智能体**验，会话是空的，才看得清有没有被写）：

| 断言 | 结果 |
|---|---|
| 2.0 / 2.0b 新建临时智能体，会话任务态列确实为空 | ✅ `{current_task:null, latest_user_intent:null, last_page_summary:null, browser_confirmed:false}` |
| 2.1 任务轮（`/chat/stream` + taskMode + wcId）返回 200 且带 loopId | ✅ |
| 2.2 任务态写进了**按 wcId 分片**的存储 | ✅ 分片 `current_task = "任务轮分片断言：去 A 页把报价抄下来"`、`last_page_summary = "已打开 http://127.0.0.1:8899/page-a"` |
| **2.3 【直连数据库】`conversations` 的任务态列一行都没被覆写** | ✅ 前后逐列相同，且**仍是 null**（`pg` 直连读原始行，不走任何接口） |
| 2.4 `conversations` 上仍保留 agent 级聚合标志 | ✅ `browser_confirmed = true`（任务轮只更新这一个 agent 级字段） |
| **2.5 【读侧兜底】`GET /chat/state` 会话级为空时用页级补上** | ✅ 原始列 `current_task = null`，而接口回 `"任务轮分片断言：去 A 页把报价抄下来"`、`last_page_summary = "已打开 …"` —— 桌面那一行不断档 |
| 2.6 / 2.7 收尾不留垃圾 | ✅ 临时智能体已删、任务轮建的服务端循环已 stop |

> 为什么 2.3 必须**直连数据库**：`GET /chat/state` 现在会做读侧兜底合并，拿它当「conversations 有没有被覆写」的证据等于自证自话。

---

## 3. 改造点 3：`advance()` 重入保护

### 3.1 怎么做的

- `LoopSession` 新增 `advancing: boolean` —— **锁挂在会话对象上**，所以粒度天然是「一个 loopId 一把」，
  两条不同的循环（两张页）互不影响，各自可以同时推进。
- `advance()` 拆成「守卫 + `advanceInner()`」：已锁 → 当场抛 `LoopBusyError`；否则置锁 → 推进 → **写回分片状态** → `finally` 放锁。
- `routes/loop.ts` 把 `LoopBusyError` 映射成 **409**（不是 500）：这是调用方用错（重试/双发），不是服务端故障。
  错误话术：`循环 <id> 正在推进中（上一次 /agent/loop/next 还没返回），本次调用被拒绝：没有执行任何动作，也没有改动它的状态。等它返回后再调。`

### 3.2 真机证据（验收 7）

用固定延迟 1200ms 的假模型把第一次请求「撑在飞行中」，250ms 后发第二次（`server-tests.mjs`）：

| 断言 | 结果 |
|---|---|
| 7.1 并发两次 `next`：恰好一次成功 | ✅ `statuses = [200, 409]` |
| 7.2 被拒的是 409 + `code=loop_busy` + 明确话术 | ✅ `{"code":"loop_busy","error":"循环 loop_mu4qev68_1 正在推进中…"}` |
| 7.3 被拒后循环仍可正常推进（没被拒绝搞坏） | ✅ 再调一次 → 200，`decision.kind='tool'` |

---

## 4. 八条验收标准的真机结果

> 环境：自己的后端 `127.0.0.1:8799`（指向零依赖假模型 `8899`，固定 1200ms/次，**不烧 token、不依赖外网**）
> + 自己的 Electron 实例（独立 profile、`--remote-debugging-port 9333`）+ vite 5273。
> **用户自己的 5173 / 8787 全程未动。**

### 4.1 验收 1：同一智能体两路真并发（时间戳重叠）✅

智能体「小助」(id=1)，两张页 `wcId=3`(page-a) / `wcId=4`(page-b)，两路各 10 步。

```
假模型请求交错（相对首个请求的毫秒数；req=进入 res=离开）
     0 req read_page 并发任务甲：整理 A 页要点
    16 req read_page 并发任务乙：整理 B 页要点      ← 16ms 后 B 也进来了
  1202 res read_page 并发任务甲：整理 A 页要点 dur=1202
  1218 res read_page 并发任务乙：整理 B 页要点 dur=1202
  1231 req read_page 并发任务甲：整理 A 页要点     ← 甲第二步
  1238 req read_page 并发任务乙：整理 B 页要点     ← 乙第二步（几乎同时）
  …（此后每一步都是两条请求在同一个 1.2s 窗口里重叠）…
 12261 res read_page 并发任务甲：整理 A 页要点 dur=1215
```

| 指标 | 值 |
|---|---|
| 甲的执行区间 | 12.26 s |
| 乙的执行区间 | 12.24 s |
| **真实重叠时长** | **12.24 s**（≈ 100% 重叠，不是先后排队） |
| `liveLoops` 全程 | **2**（1.2s→11.6s 每秒采样 10 次，全部为 2） |
| `lanes` 全程 | `[3,4]` |
| 模型调用累计 | 26 次（两路各 13 次，交错发生） |

### 4.2 验收 2：暂停 1 号，2 号完全不受影响 ✅

两路发车 4.0s 后暂停 `wcId=3`（点名的暂停），再每秒采样：

| 采样时刻 | 1 号(wcId 3) | 2 号(wcId 4) | liveLoops |
|---|---|---|---|
| 暂停瞬间 | `paused`（`blocked:true`），分片 `step=3` | `running`，分片 `step=3` | 1 |
| +2.2s | `paused`，`step=3`（**冻住**） | `running`，`step=4` | 1 |
| +3.3s | `paused`，`step=3` | `running`，`step=5` | 1 |
| +4.4s | `paused`，`step=3` | `running`，`step=6` | 1 |
| +6.8s | `paused`，`step=3` | `running`，`step=7` | 1 |

| 指标 | 值 |
|---|---|
| 暂停后 1 号发出的模型请求数 | **0** |
| 暂停后 2 号发出的模型请求数 | **6**（继续跑到步数上限） |

### 4.3 验收 3：跨智能体 A/B 同时跑 ✅

小助(id=1) 的 `wcId=3`（partition `…agent-1`）+ 卡布(id=8) 的 `wcId=5`（partition `…agent-8`）：

| 指标 | 值 |
|---|---|
| `liveLoops` | 全程 **2**（1s→11.6s 每秒采样都是 2） |
| 两路终态 | 各自 `paused`（步数上限），详情各自带自己的目标名 |
| 分片状态 `current_task` | A=`跨智能体甲：小助的 A 页` / B=`跨智能体乙：卡布的 C 页` |
| partition | `{"3":"…agent-1","4":"…agent-1","5":"…agent-8"}` —— 按智能体隔离**未被改动** |
| 模型请求交错 | 0ms(甲) / 58ms(乙) → 1203/1264/2421/2482… 全程重叠 |

### 4.4 验收 4：状态隔离 ✅ —— 见 §2.5（7 条断言 + 桌面侧两组真实分片状态）

### 4.5 验收 5：fail-fast 路由回归（**在两路并发的窗口里**）✅

采样时 `lanes_during_test=[3,4]`、`liveLoops=2`（确实在并发中）：

| 调用 | 返回 |
|---|---|
| `window.workbench.readPage()`（忘传 id） | `{ok:false, error:"驾驶目标未指定：必须显式给出内嵌页的 webContentsId（多张页并存时不允许再自动挑一张）。"}` |
| `window.workbench.readPage(999999)`（id 已失效） | `{ok:false, error:"指定的内嵌页已经不在了（webContents 999999 已关闭或不是内嵌页），这一路停止。"}` |
| `window.workbench.drive({action:'read_page'})`（忘传 id） | 同上「驾驶目标未指定」 |

> 说明：fail-fast 以 **`ok:false` + 明确 error** 的形式返回（与第 22 步既定行为一致），不是抛异常。
> 关键是**绝不盲选第一张 webview**——三处都没落到任何一张页上。

### 4.6 验收 6：安全红线（并发窗口内重跑）✅

两路循环同时在跑（`lanes=[3,4]`、`liveLoops=3`）时，对 `/form` 页逐项打动作，再**直接进访客页读真实 value**：

| 目标 | 结果 | 访客页真实值 |
|---|---|---|
| `密码`（`type=password`） | `ok:false`「目标是敏感字段（密码），AI 不代填——用户直接在该输入框里打字即可」 | `#pw1 = ""` |
| `短信验证码` | `ok:false`「目标是敏感字段（验证码/动态口令），AI 不代填…」 | `#otp1 = ""` |
| `普通输入框` | `ok:true`「已向 INPUT「普通输入框」写入「hello-subA」（方式：cdp-insertText）」 | `#q1 = "hello-subA"` |
| `立即支付` | `ok:false`「支付/收银的最终确认必须由用户自己点（按钮「立即支付」），AI 不代点」 | — |

普通框照常填得进去 → 证明不是「把整个 type 关掉了」。服务端那道闸（`toolLoop.ts` 的 `sensitiveHit`）
与提示词第 9 条**一行未动**。

### 4.7 验收 7：`advance()` 重入保护 ✅ —— 见 §3.2

### 4.8 验收 8：5–8 个浏览器实例的资源记录（只记录，不限制）✅

8 张内嵌页（全在 `…agent-1` 分区，各 944×404），`maxBrowserInstances` 通过**配置项**临时抬到 8：

| 页数 | 本实例进程数 | 合计工作集 |
|---|---|---|
| 3（起点） | 8 | 653 MB |
| 4 | 10 | 732 MB |
| 5 | 9 | 735 MB |
| 6 | 9 | 702 MB |
| 7 | 9 | 670 MB |
| **8** | **9** | **671 MB** |

8 页时的逐进程明细（CPU 为 6 秒窗口内的增量）：

| pid | 类型 | 内存 | CPU |
|---|---|---|---|
| 64052 | browser | 91.9 MB | 0.3% |
| 42040 / 36792 / 39756 / 13624 / 71296 / 38920 | renderer ×6 | 59.8 / 57.5 / 102.1 / 72.4 / 65.7 / 104.9 MB | ≈0% |
| 49828 | GPU | 80.3 MB | 0.1% |
| 32364 | network service | 36.1 MB | 0% |
| — | **合计** | **670.7 MB** | **0.4%** |

> 给子阶段 B 的参考基线：**空闲态每张简单页 ≈ +15~20 MB、CPU 几乎为 0**；
> 主要开销在「进程数」而不是单页内存（4→8 页时进程数 10→9，因为简单页被合并进了同一个 renderer）。
> 真实站点（抖音/抖店那种）会显著高于这个基线，**这张表只能当「地板值」用**。

**第二次独立测量（复验时，页组合不同：多了 `/form` 表单页 + 一张卡布分区页）**：

| 项 | 值 |
|---|---|
| 页数 | 8 张（`agent-1` 7 张 + `agent-8` 1 张） |
| 进程 | 10（browser 166.2 / renderer ×7 93~131.9 / GPU 105.6 / network 47.2 MB） |
| 合计内存 | **1041.7 MB** |
| 空闲 CPU | 2.8% |

两次测量同一量级（0.7 GB / 1.0 GB），差异来自页组合与进程合并策略，**不改变结论**：
每张内嵌页约 50~130 MB，8 张页在 1 GB 上下。

### 4.9 复验：在**最终代码树**上重跑一遍

读侧兜底（§5.2）是报告初稿之后补的，所以把**全部用例**在最终代码树上重跑了一遍
（后端重启到干净状态，`liveLoops` 基线 0）：

| 用例 | 复验结果 |
|---|---|
| 1 真并发 | ✅ 重叠 **12.16 s**（A 12.17s / B 12.16s）；`liveLoops` 每秒采样 10 次**全程 2**、`lanes` 全程 2 |
| 2 暂停 1 号 | ✅ A 暂停后模型请求 **0** 次、分片 `step` 冻结在 3；B 继续 step 3→4→5→6→7、又发 **6** 次请求 |
| 3 跨智能体 | ✅ `liveLoops` 全程 **2**（1s→12s 每秒采样）；partition `{"3":"…agent-1","4":"…agent-1","5":"…agent-8"}` |
| 4 状态隔离 | ✅ 服务端 22 条断言全 PASS（含 2.3 直连数据库、2.5 读侧兜底）；桌面两页 `current_task` / `last_page_summary` 各是各的 |
| 5 fail-fast | ✅ 并发窗口内（`lanes=[3,4]`、`liveLoops=2`）三条调用全部按预期报错，没有落到任何一张页上 |
| 6 敏感闸 | ✅ 并发窗口内（`lanes=[3,4]`、`liveLoops=2`）密码/验证码/支付全拒；访客页真实值 `pw=""`、`otp=""`、`q1="hello-subA"` |
| 7 重入保护 | ✅ `[200, 409]` + `code=loop_busy` + 被拒后仍可推进 |
| 8 资源记录 | ✅ 见 §4.8 的第二次测量 |

复验还额外验到两条**新增**断言：`2.3` 直连数据库证明 `conversations` 未被覆写、`2.5` 证明读侧兜底生效。
原始输出已合并进 `docs/acceptance/substage-a-evidence.json`（`reverifiedAt` / `reverifiedNote` 标记了复验环境）。

---

## 5. 审计没预料到的问题与风险

### 5.1 【已修】暂停 / 读状态的 IPC 不接 target —— A1.5 的最后一公里

`driver.ts` 早就是 per-target（`pauseTask(wcId)` / `pausedOf(wcId)` / `snapshotOf(wcId)`），
但两个 IPC 口一直不接 target：

- `workbench:task:pause` → `pauseTask()` → `activeTaskWcId()`（「此刻在跑的那张」，多路时等于按 Map 顺序猜）；
- `workbench:task:state` → `getTaskState()` → **聚合视图**（按 `running > paused` 挑一条）。

后果：多路真并行时**做不到「暂停 1 号、2 号照跑」**，也**读不出**「1 号已暂停、2 号还在跑」（聚合视图只会回 2 号）。
验收 2 一开始就是被这个卡住的（第一次跑出来的「A 也是乙的详情」其实是读到了聚合视图）。

**改法**（主进程 + preload，**向后兼容**，渲染层调用点不用改）：
`workbench:task:pause` / `workbench:task:resume` / `workbench:task:state` 都接受可选 `targetWebContentsId`，
不传时行为与以前完全一致。类型同步更新在 `packages/shared` 的 `WorkbenchBridge`。

### 5.2 【已修】任务轮的显示断档 —— 差点变成功能退步

任务轮不再写 `conversations.current_task` 之后，桌面 `.taskState` 那一行（读 `GET /chat/state`）
就取不到值了。**如果不处理，用户下完一个网页任务，左栏「当前任务」会消失**（比改造前退步）。
修法在服务端、不在 UI：`GET /chat/state` 加 `mergeLatestPageState()` —— **只填空、不覆盖**，
会话级有值就以会话级为准。真机断言见 §2.5 的 2.5 条。
（左栏大字横幅本来就走状态机、显示「AI 驾驶中 · 任务：…」，不受影响。）

### 5.3 【未改，边界内】渲染层还有三处旧值，界面会自相矛盾

| 位置 | 现状 | 影响 |
|---|---|---|
| `App.tsx: SETTINGS_FALLBACK.maxConcurrentAgentTasks` | 仍是 `1` | 只在首帧生效；**并发闸的实际判定在主进程**，所以功能无影响 |
| 设置面板数字输入 `max="8"` | 仍是 8 | `type=number` 的 max 不参与表单校验，输入 20 仍会被主进程夹到 20（合法区间已是 1–20） |
| 提示文案「并发默认 1：一期只跑一路…」 | 仍是旧文案 | 截图里能看到：输入框写着 20、下面写着「默认 1」 |

按「不改动任何前端 UI 代码」的边界**没有动**，建议在 UI 阶段一并改。
（`App.tsx` 本次唯一的改动是**一条注释**，说明为什么故意保留旧兜底值 —— `git diff` 可见，无行为/样式变化。）

### 5.4 【新风险】已落盘的旧配置会盖住新默认值

`electron/settings.ts` 的 `load()` 先读 `userData/workbench-settings.json`，读到了就用文件里的值。
**老用户机器上如果已经存着 `maxConcurrentAgentTasks: 1`，把默认值改成 20 对他们不生效**（要手动去设置里改）。
本次验收用的是全新 profile，所以看到的是 20。
是否要「一次性把旧默认值 1 迁移到 20」是个产品决策（可能覆盖用户的刻意选择），本阶段**不做**，留给子阶段 B / 总控定夺。

### 5.5 【新风险·环境】验收过程中 Electron 实例 3 次无日志退出（code=1）

现象：实例分别运行 167s / 46s / 61s / 28s 后退出，`code=1`、`signal=无`、**stderr 无任何 JS 栈**，
退出前最后一行日志都停在「刚发了车 / 刚打开一张页」附近。

追查结果：**当时 C 盘可用空间是 0 字节**（`df` 显示 `200G 200G 0 100%`）。
Chromium 需要写缓存/临时文件，磁盘写不进去就会静默死掉 —— 与「无栈退出」的表现吻合。
**腾出空间后**：空闲 64s 连续探测存活、资源实验（开 8 张页 + 采样 100s+）全程正常。

判定：**环境（磁盘）问题，不是本次三处改动引起的** —— 同一份构建在 167s 里跑完了并发/暂停/跨智能体三组用例。
但子阶段 B 做资源限制/监控时应当把它当成一个**已知不稳定点**：磁盘与内存水位也应该在监控范围内。

### 5.6 【已记录】8 张页时 `Page.captureScreenshot` 第一次不回包

第一次截图请求超时（8 张 webview 都在渲染），第二次成功。与 `MEMORY.md` 第七节「CDP 命令会永不回包」
是同一个已知约束（`driver.ts` 已给每条 CDP 打了 8 秒闸；探针侧没有，所以表现为超时）。
**截图失败不代表功能坏**，已写进 `scripts/verify/README.md`。

### 5.7 【新踩到的环境坑】`ELECTRON_RUN_AS_NODE=1` 会让 Electron 当场崩

本机（WorkBuddy 会话环境）会给子进程设 `ELECTRON_RUN_AS_NODE=1`。一旦带上它，
`electron` 会**以普通 Node 的身份**跑 `dist-electron/main.js`，于是
`require('electron').app` 是 `undefined`，启动 0 秒就死：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
[launch] Electron 已退出：code=1 signal=无，运行 0s
```

这不是产品缺陷，但**很容易被误判成「刚改坏了」**。起验收实例必须显式清掉：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node scripts/start-electron.mjs ...
```

已写进 `scripts/verify/README.md`。

### 5.8 【新风险·记账】「建了循环但没人驱动」会一直以 `running` 挂在内存里

`liveLoops` 只数 `status === 'running'` 的循环。一个循环**只在 `advance()` 被调用时**才会从
`running` 变成 `waiting`/`done`/`stopped`。所以：

- `/chat/stream` 任务轮建好循环、但桌面没去驱动（例如桌面崩了 / 用户马上改口）；
- 或者某一路的循环刚拿到工具、桌面就放下这一路且**没来得及调 `/agent/loop/stop`**；

这两种情况下，这条循环会**以 `running` 挂在服务端内存里，最长 10 分钟**（`LOOP_TTL_MS`）。
复验时一度看到 `liveLoops = 7~8`，但假模型日志显示只有 2~4 条循环在真正请求模型 ——
差的那些全是这类「没人驱动」的记账残留。**不烧模型、不吃 CPU**（没人调 `/next` 它就不动），
只是会把 `liveLoops` 这个指标读歪。子阶段 B 若拿 `liveLoops` 当资源依据，需要先把它改成
「最近 N 秒内有推进的循环数」，或者在建循环时就把「桌面是否接管」纳入判据。

---

## 6. 边界遵守情况（本阶段明确没做的事）

| 边界 | 状态 |
|---|---|
| 不做资源监控 / 动态限流 | ✅ 只记录（§4.8），没有任何限流逻辑 |
| 不改前端 UI 代码 | ✅ `apps/desktop/src/**` 只有 `App.tsx` 一条注释；`preload.ts` 属主进程桥、非 UI，且改动向后兼容 |
| 不改「浏览器分区按智能体隔离」 | ✅ 仍是 `persist:workbench-browser-agent-{agentId}`（验收 3 实测 partition 未变） |
| 不引入第三方并发/消息队列依赖 | ✅ 假模型是零依赖 `node:http`；重入保护是会话上的一个布尔标记；分片表是内存 `Map` |
| 不弱化敏感闸 | ✅ 反而在并发场景下重验一次（§4.6），服务端闸与提示词第 9 条一行未动 |
| `conversations` 表结构与唯一约束 | ✅ 一行未动（只改了谁去写那几列） |

---

## 7. 提交与产物

| 类型 | 路径 |
|---|---|
| 本报告 | `docs/acceptance/substage-a-验收报告.md` |
| 原始取证 | `docs/acceptance/substage-a-evidence.json`（八组用例完整输出；已合并**复验**结果，见 `reverifiedAt`） |
| 截图 | `docs/acceptance/substage-a-8-pages-and-settings.png`（8 张活页 + 配置面板 20/8） |
| 验收工具 | `scripts/verify/`（假模型 + 服务端用例 + 桌面用例 + CDP 探针 + README 复跑步骤） |

`npm run typecheck` 三个包全绿（含读侧兜底那次改动之后）。

> 复验时对 `scripts/verify/server-tests.mjs` 做了补强并已回写仓库：新增
> 「直连数据库读 `conversations` 原始行」「临时智能体跑真实任务轮」「读侧兜底」「收尾停循环」
> 四组断言，并在数据库不可用时把依赖库的断言标成 **SKIP**（不冒充通过）。

### 7.1 收尾状态

- 自己的验收实例（vite 5273 / electron 9333）、验收后端（8799）、假模型（8892–8899）**已全部停止**，
  端口复查已释放；**用户自己的 8787 / 5173 全程未动**。
- 本次验收的临时工作目录 `%TEMP%\subA`（约 17MB：假模型日志、登录 token、独立 Electron profile）
  **按权限策略保留在原地未删**，需要清理时直接删这个目录即可（`C:\Users\bing\AppData\Local\Temp\subA`）。
  其中的**结论性证据已全部落到仓库**：`substage-a-evidence.json` + 本报告。
- 顺带说明：为腾出磁盘空间（见 §5.4），删掉的是工作区内的 `apps/desktop/node_modules/.vite`
  （vite 依赖预构建缓存，会自动重建）。**没有删任何用户数据**。
