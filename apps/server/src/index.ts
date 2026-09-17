/**
 * AI 工作台最小后端（第 21 步：账号 + 流式聊天 + **服务端工具循环**）。
 *
 * 接口面：GET /health（免，含第 16 步的 llmCalls 计数 + 第 21 步的 liveLoops/loopMaxSteps）
 *           + /auth/*（账号）
 *           + /chat/stream、/chat/history、/chat/state（聊天 + 第 16 步会话状态/保活）
 *           + /agent/loop/start|next|stop（**第 21 步工具循环：脑在这一侧**）
 *           + /agent/next-action、/agent/task/*（老的单步接口，已改成同一引擎的适配器）
 *           + /knowledge、/knowledge/upload（第 11 步资料原文密文知识库，要 JWT）
 *           + /agents*、/memory/*（第 15 步多智能体 + 两层记忆，要 JWT）。
 * 第 16 步：所有模型调用都收口到 llm.ts（计数 + [llm] 日志），空闲/保活路径一次都不调。
 * 第 21 步：任务轮的循环（消息历史 / 工具表 / 步数上限 / 提示词）**只在服务端 toolLoop.ts**，
 * 桌面只当「手」：拿工具 → 在**当前智能体**那张 webview 上执行 → 回执喂回模型。
 * 服务器**不直接碰浏览器**：也拿不到 CDP，执行与叫停都在本地。监听 127.0.0.1。
 * 明确没有：邮箱登录、真微信、无头浏览器、Playwright/Puppeteer。
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadEnv } from './env';
import { makePool, migrate } from './db';
import { makeCipher } from './crypto';
import { llmCallCount } from './llm';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAgentRoutes } from './routes/agent';
import { registerMemoryRoutes, startIdleScheduler } from './routes/memories';
import { registerKnowledgeRoutes, KNOWLEDGE_MAX_UPLOAD_BYTES } from './routes/knowledge';
import { registerMultiAgentRoutes } from './routes/agents';
import { registerProjectRoutes } from './routes/projects';
import { registerLoopRoutes } from './routes/loop';
import { liveLoopCount } from './toolLoop';
import { pageStateCount } from './pageState';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = makePool(env.databaseUrl);
  const cipher = makeCipher(env.dataKey);
  const app = Fastify({ logger: false });

  // 桌面 dev 是 http://localhost:5173、生产是 file://（Origin: null）——回显来源即可；
  // 服务只听 127.0.0.1，不暴露局域网。
  // 第 19 步：DELETE 是新增的方法（删知识库资料）。带 authorization 头的 DELETE 会先发
  // OPTIONS 预检，这里不列出来就会被浏览器拦在门外（前端只看到「连不上后端」，很像服务没起）。
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });
  // 第 11 步：只给知识库上传用。文件只在内存解析，不保存原始上传文件。
  await app.register(multipart, {
    limits: { files: 1, fields: 4, parts: 5, fileSize: KNOWLEDGE_MAX_UPLOAD_BYTES },
  });

  app.get('/health', async () => {
    let db: 'up' | 'down' = 'down';
    try {
      await pool.query('SELECT 1');
      db = 'up';
    } catch {
      /* 库没起也不让健康检查崩：桌面要能区分“后端没起”和“后端起了库没起” */
    }
    return {
      ok: true,
      service: 'ai-workbench-server',
      db,
      sms: env.smsMock ? 'mock' : 'http',
      llm: env.deepseekApiKey ? 'configured' : 'missing', // 只报有没有配，绝不回显 key
      // 第 16 步：模型调用**累计次数**。保活/空闲挂着时这个数不动，就是「不调 LLM」的证据。
      llmCalls: llmCallCount(),
      // 第 21 步：工具循环（脑在服务端）。liveLoops = 现在有几路活着；
      // loopMaxSteps = 每轮步数上限（配置项 AGENT_LOOP_MAX_STEPS，默认 10，8~12）。
      liveLoops: liveLoopCount(),
      loopMaxSteps: env.agentLoopMaxSteps,
      // 子阶段 A：按页（wcId）分片的实时状态现在在册几张页（证明分片真的按页建起来了）
      pageStates: pageStateCount(),
      time: new Date().toISOString(),
    };
  });

  registerAuthRoutes(app, { pool, env, cipher });
  registerChatRoutes(app, { pool, env, cipher });
  registerAgentRoutes(app, { pool, env, cipher });
  // 第 10 步：用户档案记忆（确认后才注入）；闲置 15 分钟的自动提取靠这个扫描
  registerMemoryRoutes(app, { pool, env, cipher });
  // 第 11 步：资料上传/列表；聊天检索块在 chat.ts 单独接入，不碰驾驶员 JSON。
  registerKnowledgeRoutes(app, { pool, env, cipher });
  // 第 15 步：智能体（添加/引导表人设/删）+ 两层记忆（user_memories 账号级、agent_memories 智能体级）。
  registerMultiAgentRoutes(app, { pool, env, cipher });
  // 子阶段 2-A：项目（智能体的上层容器）—— 建/列/改名/设为当前；建项目会连带建一只母鸡。
  registerProjectRoutes(app, { pool, env, cipher });
  // 第 21 步：网页工具循环（脑在服务端；工具 open_url/read_page/click/type/scroll/stop，
  // 执行在桌面主进程的现有 driver 上）。/chat/stream 的任务轮与它共用同一份 session_state。
  registerLoopRoutes(app, { pool, env, cipher });
  startIdleScheduler({ pool, env, cipher });

  try {
    await migrate(pool);
    console.log(
      '[server] 数据库表就绪（users/projects/agents/sms_codes/conversations/messages/tasks/memories/knowledge_documents/knowledge_chunks/user_memories/agent_memories）',
    );
  } catch (err) {
    console.warn('[server] 数据库暂未连通，服务照常起（/auth 会回 503 提示）：', (err as Error).message);
  }

  await app.listen({ port: env.port, host: '127.0.0.1' });
  console.log(
    `[server] http://127.0.0.1:${env.port} —— GET /health；短信模式：${env.smsMock ? 'mock（验证码只进本日志）' : 'http 网关'}` +
      `；模型：${env.deepseekApiKey ? `已配置（${env.deepseekModel} @ ${env.deepseekBaseUrl}）` : '未配置（/chat/stream 与 /agent/next-action 会明确拒绝并提示填 DEEPSEEK_API_KEY）'}`,
  );
}

main().catch((err) => {
  console.error('[server] 启动失败：', (err as Error).message);
  process.exit(1);
});
