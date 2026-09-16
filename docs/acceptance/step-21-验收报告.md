# 第 21 步验收报告 · 网页工具循环（可见 webview，不无头）

日期：2026-09-16
分支：`arena/01a09b16-work123`　基线：`39cde801ed20cca3dfc5fbc57827fd24315ae060`

范围：在现有 `apps/server` 里加一层**模型 function call 循环**——模型选工具 → 桌面在**当前智能体**的
webview 上执行（复用第 17 步的 driver，不另起第二套点页引擎）→ 结果喂回模型 → 再选下一步，
直到做完或用叫停。浏览器**看得见**：不无头、不 Playwright/Puppeteer/browser-use、不套 Edge/Chrome。

工具表（只有这 6 个）：`open_url` / `read_page` / `click` / `type` / `scroll` / `stop`。

---

## 一、结论速览（对照验收清单）

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `npm run dev` 一窗 | ✅ | 流水线全绿（shared build → build:electron → vite 5173 → electron）；顶层窗口按属主进程归类后，**应用窗口恰好 1 个**（`AI 工作台` 1180x760）；日志里没有「检测到已有实例在运行」（见下「三·补」） |
| 2 | 闲聊「长颈鹿有多高」不开新 tab、不调开页 | ✅ | webview 0、tab 0、无面板；`llmCalls` 只 +1（纯聊天），`liveLoops` 仍 0；请求体 `tools=[]` |
| 3 | 「打开百度并搜 AI」：卡片打开百度，搜索框/URL **真的**变成搜 AI | ✅ | 1 张活页，URL `baidu.com/s?…&wd=AI`，标题「AI_百度搜索」 |
| 4 | 同一任务里连续至少两步，中间不用每步说「继续」 | ✅ | 聊天里「读当前页 → 定位搜索框 → 输入并提交 → 读结果 → 完成」；5 关键词长任务一次跑完（9 步） |
| 5 | 过程中发一句闲聊：循环不因此整段掐死 | ✅ | T+4.9s 插闲聊（`liveLoops=1`）→ 之后 `llmCalls` 45→50 继续涨、任务照旧跑完（见下「时间线 A」） |
| 6 | 发「停」才停 | ✅ | T+7.1s 发「停」→ `liveLoops` 立刻 0；此后 24 个采样（约 36s）`llmCalls` 冻在 55、页面 URL 冻结；聊天回「好，停了」（见下「时间线 B」） |
| 7 | 切到另一个智能体：看不到 A 的 tab；驾驶不会点到 B 的页上 | ✅ | 人在「卡布」时：`who=卡布 的浏览器`、`tabs=1`、A 的页 `--off`；A 的页 URL 从 广州天气→北京天气 一直变（llmCalls 57→66），B 的页**一动不动**（见下「时间线 C」） |
| 8 | 点不了时：原因 + 一个下一步，不回到「是否确认打开某某网站」 | ✅ | 「整页没有『申请退款』按钮（只有搜索、语音/图像搜索、喜欢/不喜欢等）。请告诉我退款对应的网站或订单页地址，我打开后再点。」 |
| 9 | 聊天发 123456 仍闸住 | ✅ | 消息数 277 → 277（**根本没入库**、没调模型） |
| 10 | 知识库带来源仍在（抽查） | ✅ | 「BR-9912，标称容量 4200 毫安时……（来源：《二十一步验收资料.md》第 1 段）」 |
| 11 | 无第二窗口、无 Playwright、无无头 Chrome | ✅ | 调试目标里 `page` 只有 1 个应用窗口（+1 个 devtools）；`new BrowserWindow` 全仓 1 处；依赖/代码里 0 处 Playwright/Puppeteer/browser-use；无 `headless` 字样 |

**产物**：

- `docs/acceptance/step-21-reason-next-step.png` —— 点不了 → 原因 + 一个下一步（还看得见 2 张活页与真实结果页）
- `docs/acceptance/step-21-agent-isolation.png` —— 人在「卡布」，只看得见卡布自己的页；小助的页在后台继续被驾驶
- `docs/acceptance/step-21-kb-source.png` —— 知识库回答带来源
- `docs/acceptance/step-21-dev-one-window.png` —— 真跑 `npm run dev` 后的主窗口（一窗）

---

## 二、时间线证据（`/health` 的 `liveLoops` / `llmCalls`）

`/health` 暴露 `liveLoops`（现在还在跑的循环数，只算 `running`）与 `llmCalls`（累计模型调用数）。
下面三段时间线是脚本每 1~1.5 秒采样一次的真实输出。

### 时间线 A —— 循环跑着时插一句闲聊（验收 4）

```
T+0.0s 任务已发出：打开必应，依次搜三个关键词：广州天气、北京天气、上海天气……
T+0.8s liveLoops=1 llmCalls=42   ← 循环已在跑
T+2.9s liveLoops=1 llmCalls=43
T+4.9s ★ 插入闲聊：对了，你叫什么名字
T+4.9s liveLoops=1 llmCalls=45
T+9.0s liveLoops=1 llmCalls=46   ← 闲聊之后循环继续调模型
T+12.1s liveLoops=1 llmCalls=49
T+16.2s liveLoops=1 llmCalls=50
T+19.3s liveLoops=0 llmCalls=51  ← 任务收尾
```

聊天里的交错顺序（同一个窗口里按到达顺序追加）：

```
ℹ️ 我先读一下当前必应页面的结构，确认搜索框。
ℹ️ 页面似乎还没加载出内容，我重新打开必应首页。
ℹ️ 搜索框已就位，先搜「广州天气」。
对了，你叫什么名字                     ← 闲聊插进来
我叫小助，是你工作台里的 AI 同事。        ← 闲聊被正常回答
ℹ️ 结果页正文还没读到，我读一次页面拿结果标题。
ℹ️ 广州天气结果已拿到。接着搜「北京天气」。
ℹ️ 北京天气结果已拿到。最后搜「上海天气」。
✅ 任务完成：已在必应依次搜索三个关键词，各取前三条结果标题：
```

### 时间线 B —— 跑到一半发「停」（验收 5）

```
T+7.1s ★ 发出「停」  (停前 liveLoops=1 llmCalls=54)
        停前页面: [baidu…wd=上海天气, bing.com/]
T+7.1s 停后 liveLoops=0 llmCalls=55 urls=[…不变…]
T+9.7s 停后 liveLoops=0 llmCalls=55
…（连续 24 个采样，约 36 秒）…
T+44.3s 停后 liveLoops=0 llmCalls=55 urls=[…不变…]
```

聊天尾部：`停` → `好，停了，必应那边的搜索先不做。需要的话再喊我。`

### 时间线 C —— 人在 B，循环在 A 上跑（验收 6）

```
T+1.8s liveLoops=1 llmCalls=57
    who=卡布 的浏览器 tabs=1 on=1 off=2
      [--off] https://www.baidu.com/s?…wd=上海天气   (944x404)   ← 小助的页，看不见但活着
      [--off] https://www.bing.com/                   (944x404)   ← 小助的页（正在被驾驶）
      [--on ] https://www.bing.com/                   (944x404)   ← 卡布的页
T+18.1s llmCalls=61
      [--off] https://www.bing.com/search?q=广州天气  (944x404)   ← 被驾驶中，URL 在变
      [--on ] https://www.bing.com/                   (944x404)   ← 一直没变
T+26.3s llmCalls=65
      [--off] https://www.bing.com/search?q=北京天气  (944x404)
      [--on ] https://www.bing.com/                   (944x404)
```

三张页都是 `944x404`（**不是 `display:none`、不卸载**），所以后台那一路照样点得中。

---

## 三、这一步做了什么

### 服务端：循环本体（`apps/server/src/toolLoop.ts`）

- 6 个工具的 function call 定义（`open_url` / `read_page` / `click` / `type` / `scroll` / `stop`）；
- 循环提示词只放服务端（和驾驶员提示词合成**同一份**，不再维护两套互斥话术）；
- 会话状态机：`running` / `ask` / `done` / `stopped`；步数上限来自 env（`AGENT_LOOP_MAX_STEPS`，默认 10，`/health` 里能看到 `loopMaxSteps`）；
- **按 `agentId + wcId` 校验**：换智能体或换页 → 409，绝不把动作打到别的 bot 的页上；
- 循环闲置 10 分钟回收；同时最多 32 路（防内存被刷爆）。

### 服务端：路由（`apps/server/src/routes/loop.ts`）

`POST /agent/loop/start`（兜底建循环）/ `next`（带上一格回执要下一步）/ `stop`。

### `/chat/stream` 与 `/agent/next-action` 收成同一套（验收清单里的硬要求）

- **任务轮**：桌面带 `taskMode:true` → `/chat/stream` **一次模型都不调**，只建循环、把开头一句话写进历史、把 `loopId` 交给桌面去驱动；
- **闲聊 / 问知识库 / 问「你是谁」**：走原聊天路径，而且**不带任何工具表**——闲聊在能力上就不可能开页；
- `/agent/next-action` 改成同一引擎的单步适配器（同一份提示词、同一张工具表、同一套校验）。

### 桌面：循环的「手」（`apps/desktop/electron/agent.ts` + `main.ts`）

- `agent.ts` 改成 pump：向服务端要下一步工具 → 用**现有 driver** 执行 → 结果喂回；
- 动作一律打到**这一路自己的那张页**上（按 guest webContents id 分路，第 17 步的机制照旧）；
- 停 / 放下 / 登出时通知服务端停循环。

### 渲染层（`App.tsx` / `preload.ts` / `browser/*`）

- 页面任务 → `/chat/stream` 带 `taskMode` / `pageUrl` / `wcId` → 拿 `loopId` 再发车；
- **第 21 步新修**：舞台里**别的智能体的页不露脸**（`--off` = `opacity:0` + 不接收指针事件），
  但**尺寸与挂载状态完全不变**。原来切到「卡布」时顶栏写着「0 张活页」，屏幕上却还看得见小助那张百度页，
  看起来像「串了」——现在看不见了，而它上面正在跑的那一路照旧点得中、也不会断。

---

## 三·补：`npm run dev` 一窗（清单第 1 条）

本步验收先跑的是**独立实例**（另起 vite 5273 + electron 9333），那是为了不打扰用户自己那份 dev 实例。
最后**真跑了一次 `npm run dev`**：

```
> ai-workbench@0.1.0 dev
> npm run build -w @ai-workbench/shared && npm run dev -w @ai-workbench/desktop
  @ai-workbench/shared build / @ai-workbench/desktop build:electron   ← 都通过
[vite] VITE v6.4.3 ready in 877 ms   ➜  Local: http://localhost:5173/
[electron] [main] 内嵌页 UA 已去掉 Electron token
[electron] GPU process exited unexpectedly … [launch] 自动回退 --no-sandbox 重试
```

- GPU 崩溃 → 包装器自动回退 `--no-sandbox`：**本机已知现象**（虚拟机 / 容器环境），不是本步引入的；
- 日志里**没有**「检测到已有实例在运行」（出现这句就说明撞上了单实例锁）；
- 顶层窗口按属主进程归类（`EnumWindows` + `GetWindowThreadProcessId`）：**应用窗口恰好 1 个**
  —— `AI 工作台` 1180x760。另一个可见窗口是 `Developer Tools - http://localhost:5173/`，
  那是 dev 模式**故意**开的（`main.ts`：`if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })`，
  第 2/3 步就有的行为），不是第二个应用窗口。

**顺手清了一个孤儿**：跑之前 5173 被一个**没有任何窗口挂着的 vite**（PID 61168）占着
（当时 electron 进程数 0、9222 也没开 —— 是之前那次「单实例锁」事故留下的半截进程）。
`vite.config.ts` 是 `strictPort: true`，所以它会**硬报「Port 5173 is already in use」**，
正是那种「看起来像代码坏了」的假故障。已按 PID 停掉整棵树，再跑的 `npm run dev`。

---

## 四、本机验收过程中发现并修掉的两个真问题

这两条都是**本机真机跑出来的**，不是推测。

### 问题 1：CDP 滚轮命令永不回包 → 整条循环死锁

**症状**：聊天停在「我往下滚一屏看看」，`liveLoops` 一直 1、`llmCalls` 不再增长，
页面也不动了；用户点什么都没用，只能重启窗口。

**定位**：直接对内嵌页发 `Input.dispatchMouseEvent(type=mouseWheel)`，
`window.scrollY` 读得出来（=0），但**那条命令一直不返回**（25 秒后被 timeout 杀掉）。

**根因**：Electron 的 `debugger.sendCommand()` **没有自带超时**——回包不来就永远挂着。
Chromium 在部分状态下（合成器不出帧等）对 `Input.dispatchMouseEvent` / `Page.captureScreenshot`
这类命令就是不回包。

**修法**（`apps/desktop/electron/driver.ts`）：

1. `ensureAttached()` 里给这个 debugger **打一次补丁**，让每个 CDP 命令都有 8 秒上限，
   超时按「这一步失败了」抛出去（打补丁而不是改 15 处调用点，以后新加的动作也自动受保护）；
2. `scroll` 只给滚轮 **2 秒**（不白等 8 秒），超时就当没发出去，直接走 JS 兜底；
3. `agent.ts` 里再兜一层：单个工具执行 20 秒没完成就当失败，把原因喂回模型；
4. `main.ts` 的 `agentPost` 加 90 秒上限（后端正常时最长一次模型调用是 60 秒）。

**结果**：同样的场景现在以 `ask_user` 正常收尾（`[agent] 第 3 路循环结束：ask_user`），
给出「原因 + 一个下一步」，而不是把整条循环挂死。

### 问题 2：快照读不到正文 → 「把这一页整理成列表」做不了

**症状**：百度/必应结果页反复读页只拿到顶部导航和热搜链接，
模型以为「页面是空的」，只能跟用户说「读不到结果标题」。

**根因**：快照只有 `buttons` / `links` / `inputs`，**没有任何正文**。

**修法**：快照加一段**可见正文片段**（`texts`，标题/段落/列表项上的文字，去重 + 限长 + 最多 60 条，
扫描节点上限 1500 个），服务端 `snapshotBrief` 把它作为「页面可见正文（片段）」喂给模型。
仍然只是片段，**不是整页 HTML**。

**结果**：同一个「在这张页面上搜 X 并整理前三条」的任务，现在能真的读出结果标题：

```
✅ 任务完成：已在百度搜索「上海天气」，结果页前三条标题如下：
1. 上海市天气的微博_微博
2. 【上海天气预报15天_上海天气预报15天查询】-中国天气网
3. 上海天气 - 百家号
```

顺带把 `scroll` 的兜底改成「window + 视口中心那个可滚动容器」都滚，
判断「有没有动」也看容器的 `scrollTop`（很多站点正文在自己的 `overflow` 容器里，
只看 `window.scrollY` 会误判成「滚不动」）。

---

## 五、确定性回归（假 LLM，不花模型调用）

用本地假 LLM（OpenAI 兼容 mock）把服务端每次发给模型的**完整请求体**抓下来，
确定性验证循环机制与提示词策略：

```
[test] 通过 22，失败 0     ← 工具循环服务端（工具表、敏感字段闸、坏工具闸、
                             「点不了给原因+下一步」、agent/page 不匹配 409、无 JWT 401…）
[test] 通过 14，失败 0     ← 聊天侧（闲聊不带工具、不建循环、只调 1 次模型；
                             任务轮建循环回 loopId、一次模型都不调、状态更新、停掉回 0）
```

---

## 六、没做的事（按提示词要求）

整页换皮、嵌设计稿、插件、学习、视频翻译、无头搜索、知识库按智能体拆库、
重启后恢复 tab（第 20 步遗留，本步不做）、把活页硬顶加回来 —— 都没做。

也**没有**另起项目、没有 Playwright/Puppeteer/browser-use、没有独立 BrowserWindow、
没有 MCP、没有向量库、没有 API Key 进前端/git、没有 force。
