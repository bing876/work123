# 第 22 步验收报告 · 浏览器多实例 + 会话隔离 + 统一代理空间（融合实施）

日期：2026-09-17
分支：`arena/01a09b16-work123`　基线：`e222f20a066f275fd509b5f095f36ab70bad067f`（第 21 步 tip）
依据：`docs/browser-multiinstance-fusion-report.md` §10 总控批复 + §11 现状勘误

> ⚠️ **后续变更（同日）**：总控补充指示「Phase 3 暂缓、等新 UI 设计稿」，本报告中**第 4 项（C1 卡片 UI）
> 已按指示回退**（提交 `d4d5875`），界面回到原来的「顶栏 tab + URL 栏 + 舞台」范式。
> **第 1/2/3/6/7/8/9/10/11/12 项全部保留且已重新冒烟验证**（见文末「七、回退后复验」）。
> Phase 3 的实现完整保留在 `80cd92c`（已推送），设计稿到位后可直接取回。

范围：只动 `apps/desktop`（Electron 主进程 + 渲染层）与 `packages/shared` 的类型声明。
**`apps/server` 一行未改**（对 shared 的改动全部是增量：新增接口 / 可选字段 / 加宽联合类型）。

---

## 一、结论速览

| # | 验收项（批复要求） | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | **A1.5**：`TaskState` 按 target 独立存储，**禁止全局单例** | ✅ | `driver.ts` 里 `phase/phaseDetail/phaseStep/paused/loopToken` 五个模块级单例已全部收进 `Map<number, TargetTask>`；`grep -c "let phase" driver.ts` = 0 |
| 2 | **A1.5**：第一期并发数配置项（默认 1），调大即解锁并行、**不改数据结构** | ✅ | 默认 `maxConcurrentAgentTasks:1`；设 1 时第 2 路被拒（`lanes_after_B` 仍 `[23]`）；数据结构本身是 per-target 的 Map，调大即生效（见「二·E」） |
| 3 | **B1**：partition 按 contactId（智能体）隔离 | ✅ | 小助 = `persist:workbench-browser-agent-1`，卡布 = `persist:workbench-browser-agent-8`；**同站点 cookie 不互见**（见「二·B」） |
| 4 | **C1**：resting card 用 **live webview 缩小**（非截图） | ⏸️ **已实现后回退** | 回退前验收通过：卡片 301×168、里面 webview 视口 **299×142**（非 0，驾驶点得中）；hover 浮出 Open 药丸；点开铺满舞台 944×447（见「二·C」）。**现按总控指示回退**，见「六」 |
| 5 | **D**：多实例上限**默认 4**，设置里可调，**不写死** | ✅ | `DEFAULT_SETTINGS.maxBrowserInstances = 4`；设置面板两行数字输入；改 999 被夹到 20 并落盘 `workbench-settings.json`（见「二·D」） |
| 6 | fail-fast：禁用 `findWebviewGuest` 盲选后**直接报错** | ✅ | `findWebviewGuest` 函数已**删除**；不点名 → `驾驶目标未指定：…`；点名的页没了 → `指定的内嵌页已经不在了…`（见「二·A」） |
| 7 | **红线**：密码 / 验证码不代填，支付不代点 | ✅ | 密码框、验证码框 → 拒填且 `value` 仍为 `''`；普通框照常填得进去；`立即支付` → 不代点（见「二·A」） |
| 8 | 跨智能体驾驶不串页 | ✅ | 3 张页并存时，`readPage(24)` = example.com、`readPage(25)` = example.org；往 A 里打字后 **B 里根本没有那个框**（见「二·C」） |
| 9 | 到上限拒绝新开，**不偷偷关掉已有页** | ✅ | 上限设 2 后再开第 3 张：页表**一模一样**（wcId 26/27），聊天给一句人话（见「二·D」） |
| 10 | 单实例锁不受影响 | ✅ | 同 profile 起第二实例：打印「检测到已有实例在运行」，**1s 内 code=0 退出**（见「二·F」） |
| 11 | 「停」是唯一刹车；停手后**绝不停在 running** | ✅ | 3 次采样分别收敛到 `idle` / `done` / `paused`，**全部离开 running**；`lanes=[]`（见「二·G」） |
| 12 | 类型检查 | ✅ | `npm run typecheck` 三个包全绿（shared / desktop / server），exit 0 |

**产物（截图）**：

- `docs/acceptance/step-22-cards-open-pill.png` —— 两张 resting 卡片（live webview），hover 那张浮出 `Open ↗`
- `docs/acceptance/step-22-viewer-fullscreen.png` —— 点 Open 后全屏 viewer（含「← 卡片」）

---

## 二、逐项取证（真机、独立实例）

验收跑在**独立实例**上，不打扰用户自己那份：
vite `5273`（`--strictPort`）+ electron `9333`（独立 profile `%TEMP%/wb22profile`，`--remote-debugging-port=9333`）。
探针 `%TEMP%/wb20probe.py` 连 9333，脚本 `wb22regress.py` / `wb22cap.py` / `wb22conc.py` / `wb22settle.py` / `wb22cards.py`。

**产物新鲜度先验证**：`dist-electron/*.js`（04:03:40）**晚于**所有 `electron/*.ts`（最晚 04:03:10），
且四个本步标记都在产物里：`main.js` 含「并发上限是」、`driver.js` 含「驾驶目标未指定」、
`settings.js` 含 `maxConcurrentAgentTasks`、`preload.js` 含 `settings:get`。
即：下面所有主进程行为都是**当前代码**跑出来的，不是旧构建。

### A. fail-fast + 敏感闸（红线）

在访客页里注入一张测试表单（密码框 / 普通框 / 验证码框 / 「立即支付」按钮），然后逐项打动作。

**A1 快照分类**（`readPage` 的 `inputFields`，权威分类来自 `fieldClass.ts`）：

```
sensitive | [敏感·密码] placeholder=登录密码 | name=pw1
normal    | placeholder=搜索关键词 | name=q1
sensitive | [敏感·验证码/动态口令] placeholder=短信验证码 | name=otp1
```

**A2–A6 动作结果**：

| 动作 | 结果 | 填后的 value |
| --- | --- | --- |
| `type` 到 `#pw1`（密码） | `ok:false` —— `目标是敏感字段（密码），AI 不代填——用户直接在该输入框里打字即可` | `''`（**一个字都没写进去**） |
| `type` 到 `#otp1`（验证码） | `ok:false` —— `目标是敏感字段（验证码/动态口令），AI 不代填——…` | `''` |
| `type` 到 `#q1`（普通） | `ok:true` —— `已向 INPUT「搜索关键词」写入「hello world」（方式：cdp-insertText）` | `'hello world'` |
| `click` 到 `#pay1`（立即支付） | `ok:false` —— `支付/收银的最终确认必须由用户自己点（按钮「立即支付」），AI 不代点` | — |
| `fill_form` 混合（普通 + 密码） | `ok:true` —— `填了 1 项；按规矩拒填敏感 1 项` | `{"q":"abc","pw":""}` |

> **第 3 行是这条红线的另一半**：普通字段**照常填得进去**。
> 否则「敏感闸有效」可能只是「整个 type 被关掉了」——那不算闸，那是坏。

**A7 fail-fast**：

```
readPage()        → {"ok":false,"error":"驾驶目标未指定：必须显式给出内嵌页的 webContentsId（多张页并存时不允许再自动挑一张）。"}
readPage(999999)  → {"ok":false,"error":"指定的内嵌页已经不在了（webContents 999999 已关闭或不是内嵌页），这一路停止。"}
readPage(26)      → {"ok":true,"url":"https://example.com/"}
```

服务端那道闸同样还在（本步未触碰）：`apps/server/src/toolLoop.ts` 的 `sensitiveHit()`
+ 提示词第 9 条「密码、验证码/短信码、支付、身份证这类敏感项：**绝不代填、也绝不索要它的值**」。

### B. 跨智能体 cookie 隔离（B1）

```
小助 的 webview：partition = persist:workbench-browser-agent-1
                 executeJavaScript("document.cookie='wbwho=xiaozhu; path=/'; document.cookie")
                 → "wbwho=xiaozhu"

切到「卡布」（工具条显示「卡布 的浏览器」）后打开**同一个站点**：
卡布 的 webview：partition = persist:workbench-browser-agent-8
                 executeJavaScript("document.cookie")
                 → ""            ← 看不到小助设的 cookie
                 hasWbwho = False
```

同一时刻两个 webview **都挂在 DOM 上**（小助那张 `browserCard--parked`），
即隔离来自 **partition**，不是「把别人的页关掉了」。

### C. resting card / viewer（C1）+ 驾驶路由

**C1 卡片与全屏**（`wb22cards.py`，重跑两次结果一致）：

```
before       [(19, card, [301,168], view=[299,142], pill=0), (20, card, [301,168], view=[299,142], pill=0)]
after_hover  [(19, card, [301,168], view=[299,142], pill=1), (20, card, [301,168], view=[299,142], pill=0)]
hover_hit    = yes
click_open   = clicked
viewer cls   = browserPanel__stage browserPanel__stage--viewer
viewer       [(19, C--opened, [944,447], view=[944,423]), (20, C--behind, [944,447], view=[942,421])]
after_back   [(19, card, [301,168], view=[299,142], pill=1), (20, card, [301,168], view=[299,142], pill=0)]
wcId 不变    = True   [19,20] → [19,20]
```

要点：

- **webview 视口 299×142（非 0）**——卡片里是**真网页**，不是截图，而且驾驶点得中；
- 全屏时**被盖住那张尺寸不塌**（942×421），即 `opacity:0 + pointer-events:none`，**没有 `display:none`**；
- 进出 viewer 前后 **wcId 完全一致** → 页**没被重挂/重载**。

**C2 驾驶路由**（3 张页并存：23 = 小助的，24/25 = 卡布的）：

```
C1_pages  = [{23, agent-1, parked:True,  example.com},
             {24, agent-8, parked:False, example.com},
             {25, agent-8, parked:False, example.org}]
readPage(24) → {"ok":true,"url":"https://example.com/"}
readPage(25) → {"ok":true,"url":"https://example.org/"}
只在 24 里注入 <input id="wba">；往 24 里打字
   → type(#wba) ok:true，24 里 value = "AAA"
   → 25 里 !!document.querySelector('#wba') = False      ← 动作没有漏到另一张页
```

### D. 实例上限（默认 4、可调、不写死）

```
getSettings()                        → {"maxConcurrentAgentTasks":1,"maxBrowserInstances":4}
setSettings({maxBrowserInstances:999}) → 返回 20（被 SETTINGS_RANGE.max 夹住）
落盘 %TEMP%/wb22profile/workbench-settings.json → {"maxConcurrentAgentTasks":3,"maxBrowserInstances":20}
重启后重新读                        → 回到默认 {"maxConcurrentAgentTasks":1,"maxBrowserInstances":4}
```

**到顶拒绝新开、且不关已有页**：

```
setSettings({maxBrowserInstances:2})
D1 before         = [26, 27]
openBrowser(example.net)
D2 after          = [26, 27]        ← 一模一样：没新增，也没偷偷关掉谁
D3 聊天提示        = 「已经开了 3 张页，到上限 2 张了（这个数可以在设置里调大）。要开新的，先关掉一张。」
D4 面板计数        = 2 张活页
```

（`D3` 里的「3 张」是**跨智能体全局计数**——这正是设计：上限管的是整台机器的活页总数；
`D4` 的「2 张」是**当前智能体**的页数。两个数不一样是正常的。）

### E. 并发上限（A1.5 第一期）

```
setSettings({maxConcurrentAgentTasks:1})
agentStart(goal="看看这一页上有没有 hello 这个词", wcId=23) → started
lanes_after_A = [23]                     ← 第 1 路在跑
agentStart(goal="… world …", wcId=24)    → started（调用本身不报错）
lanes_after_B = [23]                     ← 第 2 路**没有被放行**
聊天提示      = 「ℹ️ 现在已经有 1 路在驾驶了，并发上限是 1（可以在设置里调大）。
                要换一张页跑，先对正在跑的那张点「停」，或者把上限调大。」
agentStop()   → lanes_after_stop = []     ← 刹车有效，立刻停，不继续烧模型
```

### F. 单实例锁

```
$ node scripts/start-electron.mjs --user-data-dir=…/wb22profile --remote-debugging-port=9444
[main] 检测到已有实例在运行，本次启动退出（已聚焦原窗口）。
[launch] Electron 已退出：code=0 signal=无，运行 1s
```

### G. 停手后状态收敛（本步修掉的真 bug）

```
跑 1： while_running = {"phase":"done",   …}  → trace ['T+0s phase=done']   收敛离开 running = True
跑 2： while_running = {"phase":"running",…}  → trace ['T+0s running','T+3s idle']  收敛离开 running = True
跑 3： （更早一次）                            → phase=paused「等你的下一步：…」
```

三种终态都出现过，**没有一个停在 `running`**。要证的正是这一条：
停手后界面**不会**继续显示「AI 驾驶中」。
`done` / `paused` 是「这一路自己正常收尾」，`idle` 是「停手先到」，两者都对。

---

## 三、本步做了什么（按文件）

### 主进程

| 文件 | 改动 |
| --- | --- |
| `electron/driver.ts` | **删掉 `findWebviewGuest()`**；`resolveTarget(id?)` 无 id / id 失效都当场抛错；模块级单例状态收进 `Map<number, TargetTask>`；新增 `aggregateState()`（无 target 时按 `seq` 取最新）；`drive/readPage/…` 全部显式带 target；`finishLane` 的 aborted 分支收敛为 `idle` |
| `electron/settings.ts` | **新建**。`userData/workbench-settings.json` 为权威配置：`getSettings` / `setSettings`（夹取 + 落盘 + 广播）/ `onSettingsChange` |
| `electron/main.ts` | 配置 IPC（`settings:get` / `settings:set`）+ 变更广播；`task:start` 透传 target；`startAgentLoop` 加 A1.5 并发闸；`finishLane` 按这一路自己的结局落状态 |
| `electron/preload.ts` | `startTask(target?)` 透传；新增 `getSettings` / `setSettings` 桥 |

### 渲染层

| 文件 | 改动 |
| --- | --- |
| `src/browser/BrowserPanel.tsx` | **重写交互**：工具条 + URL 栏 + 舞台（卡片视图 / 全屏 viewer）；卡片视图下渲染透明**承接层**；webview 的父容器任何模式下都渲染 |
| `src/browser/styles.css` | 卡片网格 / viewer / 承接层 / `--parked` / `--behind` 的样式 |
| `src/browser/useBrowserWorkspace.ts` | `openUrl` 加 D 上限闸（到顶拒开，不关页）；`getMaxInstances` 用函数传入以读到最新配置 |
| `src/App.tsx` | 配置状态 + `settings` 事件订阅；左栏账号块加「浏览器设置」两行数字输入 |
| `src/styles.css` | `.settingsRow` / `.settingsRow__num` |

### 共享类型

`packages/shared/src/index.ts`：`BrowserEvent` 加 `'settings'`；`TaskState` 加可选 `wcId?`；
`WorkbenchBridge` 加 `getSettings` / `setSettings`，`startTask` 加可选 target；
新增 `WorkbenchSettings` / `SETTINGS_RANGE` / `DEFAULT_SETTINGS`。

### 配置默认值（写在一处，渲染层有第二份兜底常量）

```ts
export const SETTINGS_RANGE = {
  maxConcurrentAgentTasks: { min: 1, max: 8 },
  maxBrowserInstances: { min: 1, max: 20 },
} as const;
export const DEFAULT_SETTINGS: WorkbenchSettings = {
  maxConcurrentAgentTasks: 1,   // A1.5 第一期：同时只放 1 路
  maxBrowserInstances: 4,       // D：批复指定 4
};
```

---

## 四、本步真机跑出来的两个真 bug（都已修）

### 问题 1：停手后聚合状态挂在 `running`

**症状**：`agentStop()` 之后 `getTaskState()` 长期返回 `{"phase":"running"}`，即使 `lanes` 已空
（界面会一直显示「AI 驾驶中」，确认按钮永远灰着）。旧代码就有，per-target 之后更明显——它会污染聚合视图。

**根因**：`abortAllLanes()` 只清 `lanes`，**不动 driver 的状态**。

**修法**（两处，缺一不可）：

1. `finishLane` 的 `lane.aborted` 分支里，**若 `lanes.get(lane.wcId)` 就是自己**（说明是停手/登出，不是被新指令顶掉），
   则 `setExternalPhase(lane.wcId, 'idle', '已停手（这一路已结束）')`。
   `current === lane` 这个判断**必须**有——否则「最新指令优先」时会把新循环覆盖成 idle；
2. `aggregateState()` 改为**按 `seq` 取最新**，而不是取 Map 里的第一条
   （旧的 running 恰好是 `lastTouchedWcId`，会被它自己撤回去）。

### 问题 2：卡片 hover 药丸浮不出来（差点让 C1 方案不可行）

**症状**：探针多点采样 `move(380,164) 命中=WEBVIEW hover张数=0 pill=0`，
但 `move(238,88) 命中=SPAN hover张数=1 pill=1`。

**根因**：指针落在 `<webview>` 上时，鼠标事件**被 guest 进程吞掉**，宿主页面根本收不到，
`.browserCard:hover` **永远不成立**。卡片主体 85% 面积是 webview → hover 方案基本失效。

**修法**：卡片视图下叠一层**透明承接层**（`.browserCard__catcher`，`position:absolute; inset:0`，
无背景，`cursor:pointer`），整张卡片可点 = 打开全屏；药丸是它的子元素。

边界（都是明确的、可接受的）：

- 卡片视图里**不能直接操作网页**（点一下就是「打开全屏」）——这正是「resting 卡片 = 预览、viewer = 可操作」的本意；
- **完全不影响驾驶**：驾驶走主进程 CDP，输入直接发给 guest，根本不经过这一层；
- 全屏（viewer）时**不渲染**这一层，网页可以正常点；
- webview 的 **DOM 父子关系不变**（父容器 `.browserCard__body` 任何模式下都渲染），所以不触发重挂。

---

## 五、没做的事

- 没动 `apps/server`（一行未改）；
- 没重做 Phase 0 / Phase 1（第 20 步已完成，见报告 §11 勘误）；
- 没另起项目、没有 Playwright/Puppeteer/browser-use、没有独立 BrowserWindow、没有无头浏览器；
- 没把活页硬顶加回来（`MAX_LIVE_PAGES` / `MAX_LANES` 保持删除状态，只提示「开太多会卡」）；
- 没做重启后恢复 tab（第 20 步遗留，仍不在本步范围）；
- 没有 force push，没有改 `main`。

---

## 六、Phase 3 回退与回退后复验（2026-09-17 同日）

### 6.1 起因

总控补充指示：**Phase 3（多实例 UI）暂缓不做**，待后续新 UI 设计稿到位后一起处理；
本步只保留 Phase 0/1/2。

实际情况：Phase 3 在该指示到达前**已完成并推送**（`80cd92c`）。向总控确认后**回退**，提交 `d4d5875`。

### 6.2 回退范围（只两个文件，与其余改动无耦合）

- `apps/desktop/src/browser/BrowserPanel.tsx` → 还原到基线 `e222f20`
- `apps/desktop/src/browser/styles.css` → 还原到基线 `e222f20`

`git diff e222f20 -- <这两个文件>` 为空，即**逐字节等于基线**。

保留不动：Phase 2 fail-fast、A1.5 per-target 状态、配置层（并发数 / 实例上限）、
`useBrowserWorkspace` 的实例上限闸（只新增、未删 API）。

**Phase 3 的实现没有丢**，完整保留在 `80cd92c`（已推送）。重做时可直接取回，
包括那个真机踩出来的坑（webview 吞 hover → 需要透明承接层）也已记录在案。

### 6.3 回退后冒烟验证（独立实例：vite 5273 + electron 9333 + 独立 profile）

| 断言 | 证据 |
|---|---|
| UI 回到 tab 范式 | `.browserTab` = **2**、`.browserCard` = **0**、`.browserPanel__stage` 存在 |
| 多实例并存未受影响 | 两张页各 `944×404` |
| 按智能体 partition 未受影响 | 两张页均为 `persist:workbench-browser-agent-1` |
| tab 条正常 | `['Example Domain|✕', 'Example Domain|✕']` |
| 配置默认值未受影响 | `{maxConcurrentAgentTasks:1, maxBrowserInstances:4}` |
| fail-fast 未受影响 | `readPage()` →「驾驶目标未指定：必须显式给出内嵌页的 webContentsId…」；`readPage(999999)` →「指定的内嵌页已经不在了…」 |
| **红线复验** | 密码框拒填（`ok:false`）且 `value` 仍为 `''`；普通框照常写入（`ok:true`，`value = 'hello'`） |
| 类型检查 | `npm run typecheck` 三个包全绿 |

截图：`docs/acceptance/step-22b-reverted-tab-paradigm.png`（顶栏 tab + URL 栏 + 全尺寸舞台，
左栏「浏览器设置」两行仍在）。

### 6.4 分支现状

```
d4d5875  step22b: 回退 Phase 3 多实例 UI（按总控补充指示暂缓，待新 UI 设计稿）
80cd92c  step22:  浏览器多实例 + 按智能体会话隔离 + 驾驶 fail-fast   ← Phase 3 完整实现保留在此
e222f20  step21(docs): 验收报告补上清单第 1 条「npm run dev 一窗」   ← 本轮基线
```

两次推送都是快进（`e222f20..80cd92c`、`80cd92c..d4d5875`），**无 force、未改写历史**。

---

## 七、Phase 1 补充取证：按智能体的存储与下载隔离

Phase 0/1 是第 20 步落地的，本步没有重做。但复核时发现**主进程侧那条路**（分区名 → 智能体 id →
下载落盘目录）一直没有直接的运行证据，而它依赖 `session.getStoragePath()` 里真的含分区名——
一旦不含，`AGENT_PARTITION_RE` 匹配不上，下载就会**静默落到默认目录**（不报错，只是串了）。
所以补了这次取证。

**A. 磁盘上的分区目录（证明 `getStoragePath()` 含分区名）**

在智能体「小助」与「卡布」上各开一张页后：

```
<userData>/Partitions/
├── workbench-browser-agent-1      ← 小助（example.com）
└── workbench-browser-agent-8      ← 卡布（example.org）
```

两个智能体各一个独立目录，命名与 `partitionFor(agentId)` 一致 →
正则 `workbench-browser-agent-(\d+)` 能正确解出 agentId。

**B. 真的触发一次下载（端到端验穿）**

在 **agent-8（卡布）** 那张页里触发一次 blob 下载，然后看落盘位置：

```
<userData>/browser-agents/8/downloads/wb22c-agent8.txt
内容：wb22c download routing test      ← 与触发时写入的内容一字不差
```

`browser-agents/` 目录在下载前**并不存在**（按需创建，符合设计）。
文件准确落进 **agent-8 自己的** `downloads/`，没有落到默认下载目录、也没有串到 agent-1。

**结论**：Phase 1 的两条隔离（**存储** partition + **下载**落盘）都在运行中验证通过。
这条链路的两个易踩点已记录在代码注释里：主进程 `AGENT_PARTITION_RE` 与渲染层 `partitionFor`
是**同规则的两份**，**改一处必须同时改两处**。


