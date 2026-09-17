# 「项目层级」现状排查（只读，不含改造方案）

> 目的：为「插入一层『项目』作为智能体的上层容器」做准备，先摸清现状。
> **本文只记录事实**（代码位置 / 数据库真实结构 / 数据现状），**不含任何改造方案** —— 方案等总控确认后再出。
> 排查方式：读 `apps/server/src/db.ts` 的建表 DDL + **直连活库查 `information_schema` 与真实数据** +
> 全仓 grep 调用点。基线：`9bbf30f`。
> 时间：2026-09-17。

---

## 0. 一句话结论

**「项目」这一层在数据模型里已经存在，而且外键关系就是 `users → projects → agents`；
但它现在只被当成「用户归属的中转站」在用（每个用户一条 `默认项目`），既没有接口、也没有 UI，
更没有一处真正按项目做隔离。** 另外要特别注意：UI 上那个「**项目记忆**」跟 `projects` 表**毫无关系**，
它实际是**智能体级**的（`agent_memories`）。

---

## 1. （a）agents 相关数据表结构

### 1.1 活库里真实存在的表（`information_schema.tables`，12 张）

`users` / `projects` / `agents` / `conversations` / `messages` / `tasks` /
`memories` / `user_memories` / `agent_memories` /
`knowledge_documents` / `knowledge_chunks` / `sms_codes`

### 1.2 与 agents 直接相关的 5 张表（列 + 主键 + 外键，取自活库）

**`projects`**

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | bigint | PK, `nextval('projects_id_seq')` |
| `user_id` | bigint | **NOT NULL**, FK → `users.id` ON DELETE **CASCADE** |
| `name` | text | NOT NULL |
| `is_default` | boolean | NOT NULL, default `false` |
| `created_at` | timestamptz | NOT NULL, default `now()` |

索引：`idx_projects_user (user_id)`

**`agents`**

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | bigint | PK |
| `project_id` | bigint | **NOT NULL**, FK → `projects.id` ON DELETE **CASCADE** |
| `name` | text | NOT NULL |
| `kind` | text | NOT NULL, default `'assistant'`（`assistant` = 自带小助 / `custom` = 用户添加） |
| `created_at` | timestamptz | NOT NULL, default `now()` |
| `persona` | jsonb | NULL（第 15 步：引导表填的四格） |
| `persona_status` | text | NOT NULL, default `'ready'`（`pending` = 引导表没填完） |

索引：`idx_agents_project (project_id)`

**`conversations`**

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | bigint | PK |
| `project_id` | bigint | **NOT NULL**, FK → `projects.id` CASCADE |
| `agent_id` | bigint | NULL, FK → `agents.id` ON DELETE **SET NULL** |
| `title` / `created_at` | text / timestamptz | |
| `current_task` / `latest_user_intent` / `last_page_summary` | text | 第 16 步会话状态 |
| `browser_confirmed` / `login_required` / `sensitive_action` / `already_told_user_login_themselves` / `keepalive` | boolean | 同上（子阶段 A 起 `keepalive` 与 `browser_confirmed` 是 agent 级、其余任务态已改走按页分片） |
| `state_updated_at` | timestamptz | |

额外索引：`idx_conversations_project`；**部分唯一索引 `uniq_conversations_agent (agent_id) WHERE agent_id IS NOT NULL`**
（第 16 步 fixup：一个智能体只能有一条会话）

**`agent_memories`**（UI 上的「项目记忆」，见 §2）

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | bigint | PK |
| `owner_id` | bigint | **NOT NULL**, FK → `users.id` CASCADE |
| `agent_id` | bigint | **NOT NULL**, FK → `agents.id` CASCADE |
| `mem_key` / `content_enc` / `source` | text | 正文是 AES-256-GCM 密文 |
| `created_at` / `updated_at` | timestamptz | |

唯一约束：`UNIQUE (agent_id, mem_key)`；索引 `idx_agent_memories_agent (agent_id, updated_at DESC)`

**`user_memories`**（第一层：账号级）

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | bigint | PK |
| `owner_id` | bigint | NOT NULL, FK → `users.id` CASCADE |
| `mem_key` / `content_enc` / `source` / `created_at` / `updated_at` | | `UNIQUE (owner_id, mem_key)` |

### 1.3 外键关系图（活库实测）

```
users ──1:N──> projects ──1:N──> agents ──1:N──> conversations ──1:N──> messages
  │                │                 │
  │                │                 └──1:N──> agent_memories   (agent_id NOT NULL, CASCADE)
  │                ├──1:N──> tasks          (project_id NOT NULL, CASCADE)
  │                └──1:N──> memories       (project_id NOT NULL, CASCADE；agent_id 可空)
  └──1:N──> user_memories / knowledge_documents / knowledge_chunks   (都挂 owner_id)
```

要点：

- **`agents.project_id` 是 NOT NULL 外键** —— 也就是说「每个智能体必须属于某个项目」这条约束**早就有了**，
  今天之所以看不出层级，是因为每个用户只被建了**一条**项目。
- 归属校验**全部借 `projects.user_id` 这一跳**：例如
  `agents.ts:134 / 166 / 286 / 415 / 450`、`chat.ts:119 / 128 / 137 / 631`、`loop.ts:66`、`agent.ts:85 / 364`
  都是 `... JOIN projects p ON p.id = X.project_id WHERE p.user_id = $1`。
  即：`projects` 现在是**鉴权桥**，不是容器。

### 1.4 活库里的数据现状（只读查出来的）

| 表 | 行数 |
|---|---|
| users | 3 |
| **projects** | **3** |
| agents | 5 |
| conversations | 5 |
| messages | 517 |
| tasks | 212 |
| memories | 39 |
| agent_memories | 1 |
| user_memories | 3 |

`projects` 三行分别是：

```
{id:1, user_id:1, name:"默认项目", is_default:true}
{id:2, user_id:2, name:"默认项目", is_default:true}
{id:3, user_id:3, name:"默认项目", is_default:true}
```

→ **一个用户一条「默认项目」，一一对应。** 项目 1 名下：3 个智能体 / 3 条会话 / 212 个任务 / 38 条 `memories`。

---

## 2. （b）「项目记忆」的实现 + 是否已有 project 雏形

### 2.1 「项目记忆」跟 `projects` 表**没有任何关系**，它是**智能体级**的

| 项 | 事实 |
|---|---|
| 实际表 | `agent_memories`（`agent_id NOT NULL` + `UNIQUE(agent_id, mem_key)`） |
| 建表注释 | `db.ts:187` —— 「第 15 步 · 第二层：**项目记忆（智能体级）**。一个智能体一份，**绝不串**。」 |
| 读法 | `agents.ts:225` `SELECT content_enc FROM agent_memories WHERE agent_id = $1 AND owner_id = $2` |
| 提示词块 | `agents.ts:216 buildAgentProjectMemoryBlock()`，块头是「【参考·**本项目记忆**（只属于当前这个智能体，别的智能体看不到）】」 |
| 注入路径 | `buildAgentContext()`（`agents.ts:269`）→ `/chat/stream` 的 `systemParts` 与工具循环的 state brief |
| 落库分类 | `agents.ts:374` `table: 'user_memories' \| 'agent_memories'` —— 「偏口味/习惯 → 用户库；偏这个项目的业务/资料 → 该智能体项目记忆」 |
| 前端 | `App.tsx:1730` 按钮「项目记忆（N）」、`1748` `aria-label="当前智能体的项目记忆"`；`621` 注释「**某个智能体**的项目记忆（智能体级）」 |

**结论：UI 与提示词里那个「项目」是口语（「这件事 / 这个业务」），不是 `projects` 表的行。**
**目前不存在任何「项目级记忆」表或字段。**

### 2.2 已有的 project 雏形（比预想的多）

| # | 雏形 | 位置 | 状态 |
|---|---|---|---|
| 1 | `projects` 表本体（`user_id` / `name` / `is_default` / `created_at`） | `db.ts:44-51` | **已存在**（第 5 步就建了） |
| 2 | `agents.project_id` / `conversations.project_id` / `tasks.project_id` / `memories.project_id` | 同上 DDL | **已存在，全部 NOT NULL 外键** |
| 3 | 建号时自动建一条 `默认项目` | `auth.ts:233` `INSERT INTO projects (user_id, name, is_default) VALUES ($1,'默认项目',true)` | **已存在** |
| 4 | `ProjectSummary {id, name}` 类型 + 登录/`/auth/me` 返回 `project` | `shared:305`、`auth.ts:119 / 332` | **已存在，但前端一次都没读**（全仓 grep：只有服务端在写它） |
| 5 | 「取这个用户的那一条项目」的查询 | `agent.ts:171`、`agents.ts:475`、`chat.ts:142`、`memories.ts:266`（取 `id`）；`auth.ts:101 / 316`（取 `id,name`） | **6 处**，都是 `WHERE user_id=$1 ORDER BY is_default DESC, id ASC LIMIT 1`；另有 `chat.ts:137` 直接按 `p.is_default = true` 当条件 |
| 6 | `memories`（第 10 步老表，39 行）带 `project_id NOT NULL` | `db.ts:99` | **装饰性**：读写一律按 `owner_id` 过滤（`memories.ts:166/187/261/454/489/498/518`），写入时挂的是默认项目 |

### 2.3 明确**不存在**的东西

- **没有任何 `/projects` HTTP 接口**（全仓 grep `'/projects` 只命中一句启动日志）→ 不能建 / 列 / 改名 / 切换项目。
- `GET /agents`（`agents.ts:443`）**只按 `p.user_id` 过滤**，不按 project 过滤；排序是「小助优先，然后按 id」。
- 前端 `AgentView`（`shared:488`）**没有 `projectId` 字段**；`session.project` 从未被读取。
- 真正**按项目隔离**的东西目前**一个都没有**：
  - 记忆：`agent_memories` 按 agent、`user_memories` 按 owner —— 没有 project 维度；
  - 知识库：`knowledge_documents` / `knowledge_chunks` 都按 `owner_id`（账号级）；
  - 浏览器分区：按 agentId（见 §4）；
  - 任务：`tasks.project_id` 有值，但查询按 `projects.user_id` 走（`agent.ts:85 / 364`）。

---

## 3. （c）前端「智能体列表」的渲染方式

### 3.1 渲染位置与结构

`apps/desktop/src/App.tsx:1611-1647`：

```tsx
<aside className="sidebar">
  <div className="agentList" role="list" aria-label="我的智能体">
    {sidebarAgents.map((a) => (
      <button className={a.id === curAgentId ? 'contact contact--on' : 'contact'} onClick={() => selectAgent(a)}>
        <div className="avatar">…{a.kind === 'assistant' && hasUnread && <span className="red-dot" />}</div>
        <div className="contact__meta">
          <div className="contact__name">{a.name}</div>
          <div className="small">{a.kind === 'assistant' ? '在线' : a.personaStatus === 'pending' ? '等你填引导表' : '已就位'}</div>
        </div>
      </button>
    ))}
    <button className="btn agentList__add">＋ 添加</button>
    {curAgent && curAgent.deletable && <button className="btn agentList__del">删掉「{curAgent.name}」</button>}
  </div>
  …
</aside>
```

### 3.2 数据来源

| 项 | 位置 |
|---|---|
| 状态 | `App.tsx:527` `const [agents, setAgents] = useState<AgentView[]>([])` |
| 拉取 | `App.tsx:704 loadAgents()` → `GET /agents` → `setAgents(r.agents)`（`:710`） |
| 兜底 | `App.tsx:1583 sidebarAgents`：服务端还没回来时用 `session.agents` 造一份假 `AgentView` |
| 当前项 | `App.tsx:1595 curAgent`（`sidebarAgents.find(a => a.id === curAgentId)`） |
| 类型 | `shared:488 AgentView`（**没有 projectId**） |

### 3.3 「当前智能体」绑定着哪些按 id 分桶的前端状态

| 状态 | 位置 | 桶键 |
|---|---|---|
| `chats`（每个智能体一份聊天消息） | `App.tsx`（第 15 步） | agentId |
| `agentStates: Record<number, ConversationStateView>` | `App.tsx:541-542` | agentId |
| `pages: Record<number, BrowserTabView[]>`（浏览器 tab 桶） | `useBrowserWorkspace.ts:132-134` | agentId |
| `active: Record<number, tabId>`（每个智能体当前可见那张页） | `useBrowserWorkspace.ts:184` | agentId |
| 工作区接线 | `App.tsx:1110-1116` `useBrowserWorkspace({ currentAgentId, getCurrentAgent, getMaxInstances })` | 单层 |

### 3.4 「插一层项目」的结构便利性（只讲结构，不给方案）

- **方便的地方**：列表现在就是**扁平一维 `map`**，外面包一层分组渲染不困难；
  `useBrowserWorkspace` 已经习惯「按 id 分桶 + `Record<number, …>`」的写法，加一层维度是同构的。
- **要注意的地方**（三条，都只是事实）：
  1. `AgentView` 必须加 `projectId`；服务端 `GET /agents` 的 SQL 里 `JOIN projects p` **已经在**，
     补一个 `a.project_id` 列即可（`agents.ts:447-455`）。
  2. 上面 §3.3 那些桶现在都是**平铺的 agentId 键**，没有项目维度；加层后要决定
     「切项目时是只换可见桶（像现在切智能体那样、webview 不卸载），还是卸载重建」——
     这条会直接碰到第 20/22 步钉死的「**webview 一律不卸载**」不变量。
  3. `useBrowserWorkspace` 的入参是**单层**的（`currentAgentId` / `getCurrentAgent`），
     要变成「当前项目 + 当前智能体」两个维度。

---

## 4. （d）浏览器分区命名规则：现在在哪、改成 projectId 涉及哪些文件

### 4.1 生成处（渲染层，唯一权威）

| 位置 | 内容 |
|---|---|
| `apps/desktop/src/browser/url.ts:37` | `export function partitionFor(agentId: number) { return \`persist:workbench-browser-agent-${agentId}\` }` |
| `apps/desktop/src/browser/url.ts:42` | `agentIdFromPartition(partition)` —— 反解。**全仓只有「定义 + 从 index.ts 再导出」两处命中，没有任何调用者 → 死代码** |
| `apps/desktop/src/browser/index.ts:30` | 对外再导出 `partitionFor` / `agentIdFromPartition` |

文件里自带警告（`url.ts:33`）：
> ⚠️ 名字一旦定下就**不要再改**：改了等于把每个智能体已登录的站点全部登出。

### 4.2 消费处

| 位置 | 内容 |
|---|---|
| `apps/desktop/src/browser/BrowserPanel.tsx:175` | `partition={partitionFor(t.agentId)}` —— **唯一真正把分区名交给 `<webview>` 的地方** |
| `apps/desktop/src/browser/types.ts` | `BrowserTabView.agentId`（注释：「分区、cookie、登录态都跟它绑定，绝不跨智能体复用」） |
| `apps/desktop/src/browser/useBrowserWorkspace.ts` | `pages` / `active` 两个 `Record<number, …>` + `openUrl(agentId,…)` / `openHome(agentId)` / `closeTabsOfAgent(agentId)` / `bucketOf` / `setBucket` / `setActiveFor`（桶键 = agentId） |
| `apps/desktop/src/App.tsx` | `:820 browser.closeTabsOfAgent(agentId)`、`:1401 / :1408 / :1546 browser.openUrl(myAgent \| owner, …)`、`:1110-1116` hook 接线 |

### 4.3 主进程的同规则第二份（+ 顺带按 agentId 的下载目录）

| 位置 | 内容 |
|---|---|
| `apps/desktop/electron/main.ts:57` | `const AGENT_PARTITION_RE = /workbench-browser-agent-(\d+)/` |
| `apps/desktop/electron/main.ts:78-91` | `hookAgentDownloads()`：用上面那个正则反解分区名里的 agentId |
| `apps/desktop/electron/main.ts:63-71` | `agentDownloadDir(agentId)` → `<userData>/browser-agents/{agentId}/downloads`（**也是按 agentId 命名的一处**） |
| `main.ts:49 / 55 / 236` | 注释里写明「主进程 import 不到渲染层代码，所以这是同规则的第二份，**改一处要同时改两处**」 |

### 4.4 改成按 projectId 命名：涉及的文件清单（共 7 个）

| # | 文件 | 要动的地方 |
|---|---|---|
| 1 | `apps/desktop/src/browser/url.ts` | `partitionFor()` 的参数与字符串；`agentIdFromPartition()`（死代码，可一并处理） |
| 2 | `apps/desktop/src/browser/types.ts` | `BrowserTabView.agentId` 的语义（分区桶键） |
| 3 | `apps/desktop/src/browser/useBrowserWorkspace.ts` | `pages` / `active` 桶键、`openUrl` / `openHome` / `closeTabsOfAgent` / `bucketOf` / `setActiveFor` |
| 4 | `apps/desktop/src/browser/BrowserPanel.tsx` | `:175 partition={partitionFor(t.agentId)}` |
| 5 | `apps/desktop/src/browser/index.ts` | 对外导出（若函数改名/改签名） |
| 6 | `apps/desktop/electron/main.ts` | `AGENT_PARTITION_RE` + `agentDownloadDir()`（`browser-agents/{agentId}/downloads`） |
| 7 | `apps/desktop/src/App.tsx` | `openUrl` / `closeTabsOfAgent` 的实参、`useBrowserWorkspace` 接线、以及 §3.3 那些按 agentId 分桶的状态 |

### 4.5 三个必须先定的事实性影响（不是代码问题）

1. **改分区名 = 现有登录态全部作废**：`<userData>/Partitions/persist:workbench-browser-agent-<N>/`
   里的 cookie / localStorage 认的是目录名，改名后旧目录不会被读。
   （`url.ts:33` 自己写着「改了等于把每个智能体已登录的站点全部登出」。）
2. **语义会变**：现在是「一个智能体一套 cookie」（第 20 步 / 批复的 **B1**）；
   改成按 projectId 就是「**同一个项目下的多个智能体共享一套 cookie / 登录态**」。
   这是行为变化，不只是改名。
3. **旧目录要处理**：`Partitions/persist:workbench-browser-agent-*` 与
   `browser-agents/{agentId}/downloads` 都会变成孤儿。若要搬迁到新命名，还要面对
   「同一 project 下多个 agent 分区**合并**」的冲突（同一个站点在两套分区里可能是两份不同登录态）。

---

## 5. 排查边界说明

- 本次**只读**：没有改任何产品代码，只新增本文档；数据库只做了 `SELECT`。
- 本文**不含改造方案** —— 按总控要求，方案等确认现状后再出。
- 未覆盖（如需可补查）：`tasks` 表按项目的查询面、知识库是否需要项目维度、
  以及「一个用户多项目」时 `is_default` 的语义（现在建号只建一条，没有任何「非默认项目」的写入路径）。
