# 浏览器多实例 + 会话隔离 + 统一代理空间：融合分析与开发报告

> 状态：**已获总控批复（2026-09-17，见 §10）**；开发已完成并通过真机验收（见 §13 与
> `docs/acceptance/step-22-验收报告.md`）
> ⚠️ §1 现状审计已过期，勘误见 §11（相对 HEAD `e222f20`）
> 范围：仅 `apps/desktop`（Electron 渲染层 + 主进程）+ `packages/shared` 类型声明。`apps/server` 一行未改。
> 依据：已读 `browserCard.tsx` / `App.tsx` / `electron/main.ts` / `electron/preload.ts` / `electron/driver.ts` / `packages/shared/src/index.ts`。

---

## 0. 结论速览

**能融合，但有 4 个决策点必须先拍板**（见 §4）。核心判断：

- 你给的 `AgentScreen` 组件是**交互范式参考**（resting card → hover 显 Open pill → 全屏 portal viewer → Teach a task/REC），不是可直接粘贴的代码——它依赖 tailwind、`Button` 组件、`bg-inset` 等当前项目没有的类。融合 = 移植它的交互模型到现有 `BrowserCard`，保持"真网页"卖点。
- 现状（第 13 步）是**单 webview + 全局共享 partition + 全局单例 agent 循环**。需求里的"多实例""会话隔离""统一代理空间"三件事，现状**一件都不满足**，但每一件在 Electron 能力内都可做。
- "会话隔离"和"统一代理空间"**不矛盾**：隔离的是存储（cookie/cache partition），统一的是驾驶服务（driver 已支持按 `webContentsId` 精确路由）。矛盾点在**多实例 + 全局单例 agent 循环**的路由上。

---

## 1. 现状代码审计（事实，非推断）

| 维度 | 现状实现 | 代码位置 |
|------|----------|----------|
| webview 数量 | 全窗口**同时只有 1 个** `<webview>`；旧卡片退化成文字"已移到最新那张" | `App.tsx:557` `browserCardId` 单值；`App.tsx:976` `isLiveCard` |
| 存储隔离 | 全局唯一 partition `persist:workbench-browser`（所有联系人/会话共用一套 cookie/登录态） | `browserCard.tsx:173` |
| 主进程定位 webview | `resolveTarget(id?)`：传 id 精确；**不传则 `findWebviewGuest()` 扫全部 webContents 取第一个** | `driver.ts:278-303` |
| agent 循环 | 全局单例：`agentGoal` / `agentEpoch` 一个；`TaskState` 全窗口唯一 | `main.ts:222,260`；`driver.ts` 状态机 |
| 驾驶调用 | `drive(action)` 多数场景**不传 id** → 落到 `findWebviewGuest` 第一个 guest | `main.ts:route`、`App.tsx:getWebviewId` |
| 联系人模型 | sidebar 只有固定一个"小助"，**没有多联系人 → 多浏览器**的数据结构 | `App.tsx:863-962` |
| 卡片 UI | 极简：url + 展开/收起按钮，无"模拟浏览器"质感 | `browserCard.tsx:154-180` |

**关键隐患（多实例会爆的点）：** `driver.ts:280` 的 `findWebviewGuest()` 是"盲选第一个 webview"。一旦并存多个 webview，不传 id 的驾驶调用会**选错 guest**，且无法预期选到哪个。

---

## 2. 需求拆解（你原话 → 工程语义）

| # | 你的描述 | 工程语义 |
|---|----------|----------|
| A | 点开就是一个"模拟浏览器"的设计 | 融合 `AgentScreen` 的交互：resting 卡（framed 抓屏）→ hover 显 Open pill → 点击全屏 viewer；可 Teach a task / REC |
| B | 同时可以开很多个 | 多 webview 实例并存（非单卡退化模型） |
| C | 每个会话的浏览器单独隔离 | partition 按 `contactId` 维度隔离，跨联系人 cookie/session 不串 |
| D | 所有浏览器/后续应用统一接入一个代理空间 | 所有 webview 的驾驶都走同一个 Agent OS（driver + agent 循环），即"统一驾驶服务 + 路由层" |

---

## 3. 可行性判定（逐项）

| 需求 | 可行性 | 说明 |
|------|--------|------|
| A 模拟浏览器 UI | ✅ 纯前端可做 | `AgentScreen` 的 resting/hover/fullscreen 用 `createPortal`——Electron 渲染进程支持。但需把 tailwind 类翻译成当前自写 CSS；resting 卡**建议用 live webview 缩小**而非 placeholder 截图（保持"真网页"卖点，省去 `capturePage` 开销） |
| B 多实例 | ✅ 可做，整改大 | cards 模型从"单 `browserCardId`"改为 `Map<contactId, Card[]>`；每张独立 `ref` + 独立 `webContentsId`；主进程禁用"盲选第一个"fallback |
| C 会话隔离 | ✅ 可做 | partition 改为 `persist:wb-<contactId>`（或 `<contactId>-<cardId>` 二级）。Electron session partition 天然支持，零额外依赖 |
| D 统一代理空间 | ⚠️ 部分可做，需决策 | driver 已支持按 id 路由。**但** agent 循环 + `TaskState` 是全局单例。多实例并行驾驶需把状态维度从"全局"改为"按 target 路由"——见 §4 决策点 A |

---

## 4. 待总控拍板的 4 个决策点（不拍板不要动代码）

**A. 驾驶模型：串行焦点制 vs 多实例并行**
- 方案 A1（推荐，改动最小）：保留**单一 Agent OS 循环**，引入"Active Target"——当前被驾驶的 webview id 由 UI 设定，`drive` 始终带 id；一次只开一个 agent 任务，多浏览器靠"焦点切换"串行驾驶。符合你"A 统一代理空间"的原话。
- 方案 A2（大改）：每个浏览器实例独立 agent 任务，真并行。需把 `TaskState` 从全局改为 per-target，风险高。

**B. partition 隔离粒度**
- B1（推荐）：按 `contactId` 隔离——同联系人多网页共享登录态，跨联系人严格隔离（最像真实多账号浏览器）。
- B2：按 `cardId` 隔离——每张网页完全独立（更像隐身标签，但同联系人的登录态不延续）。

**C. resting card 渲染内容**
- C1（推荐）：live webview 缩小（保持真网页、零截图开销，现状收起态本就是 live）。
- C2：placeholder 截图（仿 `AgentScreen` 用静态图，省资源但非 live，且需 `capturePage` 定期刷新）。

**D. 多实例数量上限**
- 每个 `<webview>` = 一个独立渲染进程 + 一块 session 存储。需定上限（建议默认 ≤6，超出回收最久未聚焦的）防内存失控。

---

## 5. 推荐方案（基于 A1/B1/C1/D）

```
统一代理空间（单个 Agent OS：driver + agent 循环，全局唯一）
        │  drive(action, targetWebContentsId)  ← 始终带 active target id
        ▼
   路由层：activeTarget = UI 选定的当前 webview
        │
   ┌────┴─────────┬──────────────┬──────────────┐
  联系人A 浏览器    联系人B 浏览器    联系人C 浏览器   …（多实例，各独立 partition）
  partition=       partition=       partition=
  wb-A             wb-B             wb-C
  （cookie 隔离）   （cookie 隔离）   （cookie 隔离）
```

- **隔离面**：storage 按 contactId 隔离（C 满足）。
- **统一面**：驾驶能力全部走一个 Agent OS，靠 activeTarget 路由（D 满足）。
- **多实例面**：cards 为 `Map<contactId, Card[]>`，每张独立 webview（B 满足）。
- **视觉面**：移植 `AgentScreen` 的 resting→hover Open→全屏 viewer，resting 用 live webview 缩小（A 满足）。

---

## 6. 开发计划（分 Phase，含验收门禁）

> 每个 Phase 结束需真实运行验证（Electron + 真实网页 + 真实 LLM 路径）再进下一个。

- **Phase 0 — 数据模型**：`browserCardId` 单值 → `cards: Map<contactId, {id, url, ref, webContentsId}[]>`；`App.tsx` 渲染层按 contact 分组。
- **Phase 1 — partition 隔离**：`browserCard.tsx` partition 改为 `persist:wb-<contactId>`；主进程维护 `webContentsId → contactId` 注册表。
- **Phase 2 — 路由整改（关键）**：`driver.ts:resolveTarget` 禁用 `findWebviewGuest` 盲选 fallback；无 id 时**报错**而非瞎选；agent 循环 `drive` 调用强制带 `activeTarget` id。
- **Phase 3 — 多实例 UI**：resting/hover Open/fullscreen viewer（移植 `AgentScreen` 交互模型，live webview）；Teach a task/REC 录制态（可选，作为后续增强）。
- **Phase 4 — 统一接入**：agent 循环携带 target id 串行驾驶；`TaskState` 镜像按 active target 展示。
- **Phase 5 — 回归**：单卡/多卡并存、跨联系人 cookie 不串、驾驶路由正确、敏感闸（密码/验证码不代填）保留、单实例锁不受影响。

**禁用 fallback 排查清单（Phase 2 必须全量改）：** `main.ts` 各 `drive(...)` 调用、`App.tsx:getWebviewId`、`sensitiveHold` 聚焦路径，全部改为显式传 id。

---

## 7. 关键风险与不变量（必须守住）

- **敏感闸不变量**：`App.tsx:697` 密码/验证码正则拦截、driver 敏感字段不代填——多实例下仍然有效，不得弱化。
- **不重放暂停前步骤**：恢复驾驶先 `read_page` 再决策（现状），多实例下仍适用。
- **单实例锁**：`main.ts:430` `requestSingleInstanceLock` 与多 webview 无关，保留。
- **资源风险**：webview 数线性吃掉内存/CPU，务必落实 §4-D 上限。
- **`findWebviewGuest` 删除后**：任何历史调用点若漏传 id 会直接抛错——这是预期fail-fast，不是回归。

---

## 8. Forbidden actions（本迭代不做）

- 不新增 BrowserWindow（现状已禁用，保持纯内嵌 webview）。
- 不改 `apps/server` 的 `/agent/*` `/chat/*` 协议语义（只动前端 + 主进程驾驶路由）。
- 不把 partition 改回全局共享（那是 C 需求的反面）。
- 不做"真并行多 agent 循环"（除非总控在 §4-A 选 A2）。
- 不引入云端同步/上传（你明确要求不上云端）。

---

## 9. 给总控的验收门禁（checklist）

- [ ] §4 的 A/B/C/D 四个决策点已拍板
- [ ] Phase 0-5 计划认可（或要求调整范围）
- [ ] 确认"禁用 fallback 后 fail-fast 抛错"是可接受行为
- [ ] 确认多实例上限值（建议 6）
- [ ] 确认本报告 §7 不变量全部保留

---

## 10. 总控批复记录（2026-09-17）

§4 四个决策点全部拍板：

| 决策点 | 批复 | 落地含义 |
|--------|------|----------|
| A 驾驶模型 | **折中方案 A1.5** | `TaskState` 从**设计上**就按 target（`webContentsId`）独立存储，**禁止全局单例**；但第一期用一个**并发数配置项**限制「同时只有 1 个 active agent task 在跑」。后续调大这个配置项即可解锁真并行，**不需要重新设计数据结构** |
| B partition 粒度 | **B1** | 按 `contactId`（联系人 / 智能体）隔离 |
| C resting card | **C1** | live webview 缩小展示，**不用截图方案** |
| D 多实例上限 | **默认 4**（不是 6） | 做成**设置里可调**的配置项，**不要写死在代码里** |

其余确认：

- 同意「禁用 `findWebviewGuest` 盲选 fallback 后**直接报错**」的 fail-fast 行为。
- §7 所有不变量必须保留，**尤其「密码 / 验证码不代填」的敏感闸**——任何后续改动都不得弱化，
  且**每个 Phase 验收时都要重新验证一次这条红线**。
- Phase 0-5 的开发计划本身认可，按此推进。
- 开工前置项：`apps/desktop/NVIDIA Corporation/` 加入 `.gitignore` 并从 git 跟踪中移除（已办，见 §12）。

---

## 11. 现状勘误（相对 HEAD `e222f20`）

> §1 的审计描述的是**第 18 步之前**的形态。第 18/20/21 步已把其中相当一部分做掉了，
> 照 §6 原样开工会**重做已完成的工作并可能踩坏第 20 步的既定契约**。以下为逐项核实结果。

| 计划阶段 | §1 的描述 | `e222f20` 实际实现 | 结论 |
|---|---|---|---|
| Phase 0 数据模型 | `browserCardId` 单值 | 全仓 `browserCardId` **0 处命中**；状态在 `browser/useBrowserWorkspace.ts` 的 `pages: Record<agentId, BrowserTabView[]>`（按智能体分桶）+ `allTabs` 全量挂载 | **已完成** |
| Phase 1 partition 隔离 | 全局 `persist:workbench-browser` | `browser/url.ts:37` `partitionFor(agentId)` = `persist:workbench-browser-agent-{id}`；主进程 `main.ts` 用 `AGENT_PARTITION_RE` 反解同一套命名 | **已完成（即 B1）** |
| 多实例并存 | 全窗口只有 1 个 webview | `BrowserPanel.tsx:149` 渲染 `ws.allTabs`（所有智能体所有页都挂着）；别家的页用 `--off`（opacity 0）隐藏而非卸载；`MAX_LIVE_PAGES` 已删 | **已完成** |
| Phase 2 fail-fast | `resolveTarget` 盲选第一个 guest | `driver.ts:294-300`：**传了 id 但页已失效 → 抛错**（已 fail-fast）；**调用方没给 id → 仍走 `findWebviewGuest()` 盲选**（`driver.ts:279/302`） | **部分完成**，剩「无 id 也报错」 |
| Phase 3 多实例 UI | — | `BrowserPanel.tsx` 是「钉住工作区」范式（顶栏 tab + URL 栏 + 舞台），**没有** resting card / hover Open pill / 全屏 viewer | **未做** |
| A1.5 TaskState per-target | 全局单例 TaskState | 驾驶**车道**已 per-target：`main.ts:374` `lanes = new Map<number, Lane>()`（key = `wcId`），第 20 步已删 `MAX_LANES`；但 `driver.ts` 的 `phase / phaseDetail / phaseStep / paused / loopToken` **仍是模块级全局单例** | **未做** |
| A1.5 并发数配置项 | — | 当前并发**无上限**（硬顶已删），且没有任何并发配置项 | **未做** |
| D 上限 4 可配置 | 建议 ≤6 | `SOFT_TAB_HINT = 10` 只是 UI 提示、**不拦**；没有设置页、没有配置存储（渲染层 localStorage 只有 `workbench.apiBase` 一个业务键） | **未做** |

**结论**：原 Phase 0 / Phase 1 无需再做；剩余工作量集中在
**Phase 2 收尾 + 配置层（A1.5 并发数 / D 上限）+ `driver.ts` 状态 per-target 化 + Phase 3 UI**。

---

## 12. 前置项完成记录（2026-09-17）

`apps/desktop/NVIDIA Corporation/` —— 已加入 `.gitignore`（规则 `NVIDIA Corporation/`，
匹配任意层级同名目录，不写死单一路径）。

**核实事实（与批复假设不符，据实记录）：**

- `git ls-files | grep -i nvidia` → **0 个被跟踪文件**；
- `git log --all --pretty=format: --name-only | grep -i nvidia` → **历史上从未出现过该路径**；
- 目录实际内容只有 `umdlogs/` 一个**空子目录**，`du -sh` 为 **0**。

即：该目录**从来没有进过版本库**，所以「从 git 跟踪中移除」这一步**是空操作**，无需 `git rm --cached`。
新增的 ignore 规则价值在于**防止将来**（驱动按 cwd 落盘）把 `umdlogs` 里的东西带进版本库。
目录本身未删除（空目录，且未被要求清理）——如需一并清掉请明确指示。

---

## 13. 开发与验收结果（2026-09-17）

> 完整取证见 **`docs/acceptance/step-22-验收报告.md`**。这里只留结论与决策点落地情况。

### 13.1 四个决策点的落地

| 决策点 | 批复 | 落地位置 | 验收证据 |
|---|---|---|---|
| **A1.5** 驾驶模型 | `TaskState` 按 target 独立存储，**禁止全局单例**；第一期用并发数配置项限 1 路 | `driver.ts`：`interface TargetTask` + `const tasks = new Map<number, TargetTask>()`；`electron/settings.ts` + `main.ts` 并发闸 | 模块级单例（`let phase/phaseDetail/phaseStep/paused/loopToken`）**残留 0 处**；并发设 1 时第 2 路被拒（`lanes` 仍 `[23]`） |
| **B1** partition 粒度 | 按 contactId 隔离 | `browser/url.ts` `partitionFor(agentId)`（第 20 步已就位，本步未改） | 小助 `…agent-1` 设的 cookie，卡布 `…agent-8` **看不到**（`hasWbwho=false`） |
| **C1** resting card | live webview 缩小，不用截图 | `browser/BrowserPanel.tsx` 重写（工具条 + URL 栏 + 卡片舞台 + 全屏 viewer） | 卡片 301×168 内 webview 视口 **299×142（非 0）**；hover → `Open ↗`；点开 944×447 |
| **D** 多实例上限 | **默认 4**，设置里可调，**不写死** | `shared` 的 `DEFAULT_SETTINGS.maxBrowserInstances = 4`；左栏「浏览器设置」两行数字输入 | `setSettings({maxBrowserInstances:999})` → 夹到 **20** 并落盘；到顶拒开且**页表逐项不变** |

### 13.2 红线复验（批复要求「每个 Phase 验收时都要重新验证一次」）

**已复验，未弱化。** 在访客页注入测试表单后逐项打动作：

| 目标 | 结果 |
|---|---|
| `#pw1`（`type=password`） | `ok:false`「目标是敏感字段（密码），AI 不代填」；`value` 仍为 `''` |
| `#otp1`（短信验证码） | `ok:false`「目标是敏感字段（验证码/动态口令），AI 不代填」；`value` 仍为 `''` |
| `#q1`（普通框） | `ok:true`，`value = 'hello world'` ← **普通框照常填得进去**（证明不是把整个 `type` 关掉了） |
| `#pay1`（立即支付） | `ok:false`「支付/收银的最终确认必须由用户自己点，AI 不代点」 |
| `fill_form` 混合 | `填了 1 项；按规矩拒填敏感 1 项`，`pw` 仍为 `''` |

服务端那道闸同样在位且未被触碰：`apps/server/src/toolLoop.ts` 的 `sensitiveHit()` + 提示词第 9 条。

### 13.3 fail-fast（批复同意）

`findWebviewGuest()` **已删除**（全仓仅剩注释里说明「已删」）；`resolveTarget()` 在
「没给 id」和「id 已失效」两种情况下都当场抛错，绝不盲选第一张 webview：

```
readPage()       → 驾驶目标未指定：必须显式给出内嵌页的 webContentsId（多张页并存时不允许再自动挑一张）。
readPage(999999) → 指定的内嵌页已经不在了（webContents 999999 已关闭或不是内嵌页），这一路停止。
```

### 13.4 本步真机跑出来的两个真 bug（都已修）

1. **停手后聚合状态挂在 `running`** —— `abortAllLanes()` 只清 `lanes` 不动 driver 状态。
   修法两处缺一不可：`finishLane` 的 `aborted` 分支收敛为 `idle`（**必须**加 `lanes.get(wcId) === lane` 判断，
   否则会把新循环覆盖掉）；`aggregateState()` 改为按 `seq` 取最新而不是取 Map 第一条。
   修后 3 次采样分别收敛到 `idle` / `done` / `paused`，**全部离开 running**。
2. **卡片 hover 药丸浮不出来** —— 指针落在 `<webview>` 上时鼠标事件被 guest 进程吞掉，
   宿主的 `.browserCard:hover` **永远不成立**（卡片 85% 面积是 webview）。
   修法：卡片视图叠一层透明**承接层**（`.browserCard__catcher`），整卡可点 = 打开全屏。
   驾驶走 CDP 不经过这层，**不受影响**；viewer 模式下不渲染这层，网页可正常点；
   webview 的 DOM 父子关系不变，所以不触发重挂（进出 viewer 前后 wcId 一致）。

### 13.5 范围与不变量

- **`apps/server` 一行未改**；对 `packages/shared` 的改动全部是**增量**（新增接口 / 可选字段 / 加宽联合类型），
  三个包 `npm run typecheck` 全绿。
- 第 20/21 步钉死的不变量全部保持：webview **一律不卸载**、藏页只用 `opacity:0 + pointer-events:none`
  （**绝不 `display:none`**）、一个智能体一套浏览器、tab 状态按智能体分桶、
  「停」是唯一刹车、纯开页不发车、开页成功不写聊天。
- 活页硬顶**保持删除状态**（只提示「开太多会卡」）；D 上限是**新增的显式配置闸**，到顶只拒开、**绝不关页**。

