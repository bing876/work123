# MEMORY.md — work123 长期记忆

仓库 `bing876/work123`，工作区 `C:\Users\bing\workbuddy-ai\work123`。
本文件只留**本项目特有的契约与坑**；实现细节见 git log / docs / 当天日志。

> **开工前先读**：`TOOLING.md`（同目录：本机命令 / 环境坑 / CDP 硬约束 / 取证习惯）
> 与技能 `workbench-project-phase-verify`（**真机取证套路，唯一已落盘的验收技能**）。
>
> ⚠️ **历史笔记里的三个技能名从未落盘**：`electron-ui-verify`、`llm-prompt-capture-verify`、
> `db-race-verify`（`~/.workbuddy/skills/` 下核实过，**暂未实现**）。见到它们不用去 `skills/` 找，
> 相关知识目前只散在 `TOOLING.md` 与当天日志里（2026-09-17 已核实并标注）。

## 一、git（本机有坑，每次都会复发）
- 分支固定 `arena/01a09b16-work123`；`main` 只作基线，不合并/不推送/不 force。
  开工前核对 `git rev-parse HEAD` == 用户给的基线；**下一轮基线由用户给，别自己认**。
- **本机 git 写不了带 `/` 的 ref**：commit / push / fetch / checkout -b / update-ref / reset --hard
  之后 `refs/heads/arena/...` 被静默抹掉（fetch 还抹 remote ref）。绕法：
  `git add -A && tree=$(git write-tree) && sha=$(git commit-tree $tree -p <parent> -F <msgfile>)`，
  **最后一步**再 `printf '%s\n' $sha > .git/refs/heads/arena/<名>`（remote ref 按 `ls-remote` 补，先 `mkdir -p`）。
  **写 ref 的命令都排在补 ref 之前**，之后只跑只读命令。禁止 `git branch --set-upstream-to`（直接删本地 ref）。
  sha 丢了从 `.git/logs/HEAD` 捞。`git commit-tree -F` 不认 MSYS 路径（`/c/...`），要传 `C:/...`。
- **`git add` 手写清单会漏文件**（漏过 `driver.ts`）。暂存后必须 `git diff --cached --stat` 数一遍；
  提交后 `git diff HEAD --name-only` 应为空。
- 证明没 force：push 输出无 `+` + `ls-remote`/本地 ref/HEAD 三者一致 + `merge-base --is-ancestor <基线> HEAD`。
- 推 GitHub 走 Clash，**四个变量都要导出**（只导出小写会盖掉大写并 502）：
  `export http_proxy=http://127.0.0.1:7897 https_proxy=$http_proxy HTTP_PROXY=$http_proxy HTTPS_PROXY=$http_proxy`

## 二、稳定契约（已实现，改动易踩坏）
- **会话唯一性**：一个智能体只能有一条会话，建会话一律走 `ensureAgentConversation(pool, ownerId, agentId)`；
  全仓 `INSERT INTO conversations` 只应有三处；约束 `uniq_conversations_agent` 在 `db.ts migrate()`。
  Postgres 并发「找或建」：`FOR UPDATE` 等锁期间仍是旧快照 → 存在性检查塞进子查询必重复插入；
  正解是拿到锁后**另起一条语句**再查再 INSERT（历史笔记记在技能 `db-race-verify` 里，
  该技能**未落盘**，结论就是本行这句）。
- **提示词/聊天**：`chats: Record<agentId,...>` 按发起时捕获的 agentId 落桶；`promptPolicy.ts` 优先级
  「本轮最新消息 > 已确认事项 > current_task > 长期记忆」；`llm.ts` 是模型调用唯一出口。
  **系统提示词的否定约束打不过上下文旧话复读 —— 先清历史再改措辞。**
- **浏览器工作区**：浏览器相关只写 `apps/desktop/src/browser/`（入口 `index.ts`）。开页判定
  `detectOpenUrl()` 纯本地；**开页成功不写聊天**；关 tab 只留一句人话；**纯开页不发车**；「停」是唯一刹车。
  分区 `persist:workbench-browser-agent-{id}`（`browser/url.ts:partitionFor`；主进程用 `AGENT_PARTITION_RE`
  反解，**改一处要改两处**），下载落 `userData/browser-agents/{id}/downloads/`。
  tab 状态按智能体分桶（`pages: Record<agentId,...>`），切智能体只换可见桶、**webview 一律不卸载**；
  `BrowserPanel` 必须「只要**任意**智能体还有页就挂着」，否则切到空桶会卸掉别人的页。
  别的智能体的页用 **`--off` = `opacity:0` + `pointer-events:none`** 藏，**绝不能用 `display:none`
  或条件不渲染**：宽高变 0 会让后台那一轮点不中任何元素。
  **开页复用按 host（含端口）判** —— 想同时开多张页必须用不同端口/域名，否则会复用同一张 tab。
- **样式**：`.chat` 是高度确定的 `overflow:auto` column flex，内容超高时 `flex-shrink:1` 子项被压扁。
  **同优先级单类选择器，谁在文件后面谁赢**：「用样式藏掉」的规则一律放 `styles.css` 末尾。
- `driver.ts` 的 `PAGE_HELPERS` 是 TS 模板字符串里的 JS —— **注释里写反引号会截断字符串**；
  `__v` 改了必须同步改版本号。换页途中 `document.documentElement` 可能为 null，视口走 `viewport()`。

## 三、第 21 步契约：网页工具循环（脑在服务端，手在桌面）
- **一条分叉**：`/chat/stream` 带 `taskMode:true` = 任务轮 → **一次模型都不调**，只建循环
  （`toolLoop.ts`）并回 `loopId`，由桌面驱动；闲聊 / 知识库 / 问「你是谁」走原聊天路径且**不带 tools**。
- 工具只有 6 个：`open_url` / `read_page` / `click` / `type` / `scroll` / `stop`。
  `/agent/next-action` 只是同一引擎的单步适配器（同一提示词、工具表、校验）。
- 步数上限 `AGENT_LOOP_MAX_STEPS`（默认 10，`/health` 暴露 `loopMaxSteps`）；循环闲置 10 分钟回收、
  最多 32 路；**空闲保活一次都不调模型**。
- 循环按 `agentId + wcId` 校验，换智能体 / 换页 → **409**，绝不把动作打到别的 bot 的页上。
- 快照除 buttons/links/inputs 外还有 **`texts`（可见正文片段）** —— 没有它，「把这一页整理成列表」做不了。

## 四、第 22 步契约：多实例 / 按智能体隔离 / fail-fast
- 提交 `80cd92c`（step22）+ `d4d5875`（step22b 回退 Phase 3 UI）+ 后续 docs，父 `e222f20`，全部快进推送。
- **`driver.ts` 里没有任何驾驶状态是全局单例**：`phase/detail/step/paused/loopToken` 全在
  `Map<number, TargetTask>`（`taskOf(wcId)` 取或建、`phaseOf`/`pausedOf` **不建条目**）。
  新增驾驶状态**必须**进这个 Map，不许再起模块级 `let`。
- **`findWebviewGuest()` 已删除**。`resolveTarget(id?)`：没给 id → 抛「驾驶目标未指定」；
  id 失效 → 抛「指定的内嵌页已经不在了」。**绝不盲选第一张 webview。**
  `drive` 一律返回 `{ok:false, error}` 而不是抛（fail-fast 以 `ok:false` 呈现）。
  所有 `drive/readPage/startTask/...` 都要显式带 `webContentsId`；渲染层**完全不直接调** `workbench.drive`。
- **聚合视图**（不传 id 时给左栏横幅用）：优先级 running > paused > 最近终止态 > idle，**按 `seq` 取最新**。
  ⚠️ **它读不出「1 号暂停、2 号还在跑」**（running 赢），验并发必须点名 target。
- **终态有三种**：`idle` / `done` / `paused`。判据只能写「**绝不停在 running**」。
  `finishLane` 的 `aborted` 分支收敛成 idle 时**必须**加 `lanes.get(wcId) === lane` 判断。
- **配置**：`electron/settings.ts` 是权威（`userData/workbench-settings.json`），范围来自 shared 的
  `SETTINGS_RANGE`。**已落盘的文件会盖住代码里的新默认值**（改默认值对老 profile 不生效）。
  渲染层 `App.tsx` 有**第二份兜底常量**（主进程 import 不到渲染层）。**配置全局唯一一份，不做 per-target**。
- **并发闸**在 `main.ts:startAgentLoop`，**只在 `!prev` 时判**（被新指令顶掉不算新路）。
- **D 上限闸**在 `useBrowserWorkspace.openUrl`（同站复用判断之后、新开之前），**跨智能体全局计数**；
  到顶**只拒开、绝不关页**。
- **卡片视图必须叠一层透明承接层** `.browserCard__catcher`（`position:absolute; inset:0`）：
  指针落在 `<webview>` 上时鼠标事件被 guest 吞掉，宿主 `:hover` 永不成立（细节见融合报告 §13.4）。
  webview 父容器 `.browserCard__body` **任何模式都要渲染**（换父节点 = 页重载）。
- **验收前先验产物新鲜度**：`grep` `dist-electron/*.js` 有没有本步标记字符串 + 比对 mtime。

## 五、子阶段 A 契约：并发闸 / 状态按页分片 / advance 重入（易踩坏）
- 报告 `docs/acceptance/substage-a-验收报告.md`（+ 原始取证 `substage-a-evidence.json`、
  复跑工具 `scripts/verify/`）是本步唯一出处。提交链（**最新 `c85b5d2`**）：
  `3be2251`（三个改造点）+ `3384e88`（报告收尾）+ `647ac1b`（记忆拆分）+ `865c82a`（读侧兜底 + 脚本补强 +
  报告/证据复验）+ `69ac2fa`（记忆补记）+ `c85b5d2`（融合报告 §14 同步）；基线 `76441a7`，
  全部快进推送无 force。融合报告 §14 也是子阶段 A 的官方摘要，改这块要同步它。
- **并发闸默认 20**（`shared` 的 `DEFAULT_SETTINGS.maxConcurrentAgentTasks`）。
  **改默认值必须同时改 `SETTINGS_RANGE`**，否则 `settings.ts:normalizeSettings` 会把默认值夹回区间上限。
- **状态两个粒度，别混**：
  - **页级/任务级** → `apps/server/src/pageState.ts`（内存注册表，key = `wcId`，条目带 `userId`/`loopId`，
    TTL 10min、上限 64）。写入口只有两处：`toolLoop.ts:syncPageState`（每步推进后）与
    `sessionState.ts:applyUserMessage({page})`（任务轮入口）。
  - **会话级/智能体级** → `conversations`（表结构一行未动）：`keepalive` 只在这里
    （**它没有 wcId 维度**，读写点是 `POST /chat/state` 与 `keepaliveOfAgent`，别搬进分片表）；
    `browser_confirmed` 作为聚合标志也留在这里。
  - 任务轮**不再覆写** `conversations` 的 `current_task/latest_user_intent/last_page_summary/login_required/sensitive_action`。
  - 分片表**只当缓存**：首次用到某张页时才拿会话态当种子，之后**页级优先**，绝不被会话级覆盖回去。
  - 读口：`GET /agent/loop/state?wcId=`（要 JWT，别人的页 404）；不传 wcId 回自己名下全部。
  - **`GET /chat/state` 有读侧兜底**（补遗 `865c82a`）：会话级**优先**，会话级为空时才用
    `pageState.latestPageStateOfAgent(agentId)`（该智能体最近被碰过的那张页）补 `current_task` /
    `last_page_summary` / `browser_confirmed` / `login_required`。**只填空不覆盖** ——
    因为桌面 `.taskState` 那一行读的就是它，不补会出现「下完网页任务、左栏当前任务反而空了」。
    也正因为有这层合并，**它不再是「conversations 有没有被覆写」的原始证据**（要直连库读）。
- **`advance()` 有重入锁**：锁是 `LoopSession.advancing`（**粒度 = 一个 loopId 一把**）。
  已锁 → 抛 `LoopBusyError` → 路由 **409 `code=loop_busy`**（不是 500）。
  外部**只能调 `advance`**；真实现是 `advanceInner`，别从外面直接调它（会绕过锁）。
- **IPC 三兄弟都支持点名 target**（子阶段 A 补的最后一公里）：`workbench:task:pause` / `resume` / `state`。
  不传 target 时保持旧行为（`pause`→「此刻在跑/最近碰过的那张」；`state`→**聚合视图**）。
- **渲染层三处旧值按边界没动**（UI 阶段要一起改）：`App.tsx:SETTINGS_FALLBACK=1`、设置面板 `max="8"`、
  提示文案「并发默认 1」。功能无影响（闸在主进程），但界面自相矛盾。

## 六、多实例融合：已拍板决策 + 流程教训
- 报告 `docs/browser-multiinstance-fusion-report.md` 是**批复与勘误的唯一出处**（§10 批复 / §11 勘误 /
  §12 前置项 / §14 子阶段 A），**动手前先读它，别读 §1 的旧审计**。
- 已拍板：**A1.5**（TaskState 按 target 独立、禁全局单例；用并发数配置项解锁真并行、不改数据结构）、
  **B1**（partition 按智能体隔离）、**C1**（resting card 用 live webview 缩小，不用截图）、
  **D 默认 4** 且设置里可调、不许写死。
- **红线**：**密码/验证码不代填的敏感闸**每个 Phase / 子阶段验收都要重新验一遍，任何改动不得弱化。
- Phase 编号：0 数据模型 / 1 partition / 2 路由整改 / 3 UI / 4 统一接入（已被 A1.5 覆盖）/ 5 回归。
  **Phase 3 已实现后回退**（等新 UI 设计稿）：回退只动 `browser/BrowserPanel.tsx` + `browser/styles.css`
  （还原到 `e222f20`），**完整实现保留在 `80cd92c`**。改 UI 时保持这两个文件与其余改动无耦合。
- **流程教训**：批复里「暂缓/不做」的项，**动手前先确认它是不是已经做完了**；遇到「指示与实际状态
  冲突」→ 如实报告 + 让总控定夺，绝不自己悄悄删或悄悄留。
- `apps/desktop/NVIDIA Corporation/`（驱动 umdlogs）已加 `.gitignore`；从未被跟踪，是运行时残留。

## 七、子阶段 2-A 契约：项目层 / 母鸡 / 知识库归属（易踩坏）

- 报告 `docs/acceptance/substage-2a/验收报告.md` 是**本步唯一出处**（含四条硬指标真机取证 + 迁移对照；
  **§12 = 总控批复后当天的修正轮**，覆盖 §4②/§4④ 与 §9 第 1、2 条）；
  现状排查在 `docs/project-layer-audit.md`。**前端一行未改**，浏览器分区仍是按智能体。
- **口径**：当前项目 = `users.current_project_id`，为空/失效回落 `is_default` 那条；
  服务端唯一出口是 `projectScope.ts`（`currentProjectId` / `listProjects` / `createProjectWithHen` /
  `resolveAgentCreator` / `loadOwnedProject`）。**别再各写一句 SQL 取项目**。
- **母鸡** = `agents.kind='hen'`，随项目在**同一事务**里创建（`can_create_agents=true`、
  `persona_status='ready'`、含一条空会话），并**把新项目设为当前项目**。母鸡不可删（`DELETE` 400）；
  自带小助同样不可删、同样有建智能体权限 —— 所以**老账号（默认项目里没有母鸡）不需要补数据**。
- **前端两条删除入口**：`App.tsx:1641` 按 `curAgent.deletable` 判（后端给内置角色 false 即可）；
  `App.tsx:1900` 的 `AgentGuide onDelete` **没有 deletable 守卫**，只在 `personaStatus==='pending'` 时渲染 →
  所以 `toAgentView()` 对内置角色**一律返回 `'ready'`**，那条入口结构性不可达。**改这两处前先读验收报告 §8。**
- **权限闸**：`POST /agents` 的调用者 = `body.asAgentId`，**必填**（2026-09-17 总控拍板修正：
  不传 / `0` / `'abc'` / `null` 一律 **400**，**绝不回落到任何身份** —— 回落到内置角色 = 提权口子）。
  闸门只认 `can_create_agents` 字段，**不按 kind 隐式放行** —— 因此**任何新建内置角色的
  插入点都必须显式写 true**（`auth.ts` 建号那句漏过，见报告 §8 bug #1）。
  **新智能体落在调用者自己所在的项目**（`caller.projectId`，不是「当前查看中的项目」）。
  ⚠️ 桌面端「＋ 添加」发的是 `body:'{}'` → 在 2-B 接上调用者之前会 400，**这是故意的不兼容改动**。
- **知识库按项目隔离**：`knowledge_documents` / `knowledge_chunks` 都有 `project_id`（**NOT NULL**，
  由 `migrateProjectScope()` 幂等回填：按 owner 各自挂到自己的默认项目）；列表/上传/检索一律按项目过滤，
  检索用的是**会话所属项目**（`chat.ts` 把 `convProjectId` 传给 `buildKnowledgeBlock`）。
  → 直接后果：挂在项目 B 的资料，在项目 A 的会话里检索不到（这是隔离语义，不是 bug）。
- **`agent_memories` 本阶段明确不动**（仍是智能体级；UI 上那个「项目记忆」= 智能体级，命名待后续调整）。
- 边界：**项目不可删**（`is_default` 永远兜底）；列表 `LIMIT 50`、项目名 ≤24 字；
  没做项目级配额、没做项目级记忆、没做母鸡的「调度其他智能体」。
