/**
 * AI 工作台最小后端（第 7 步：账号 + 流式聊天 + 云端驾驶员“一步一问”接口）。
 *
 * 接口面：GET /health（免）+ /auth/*（账号）+ /chat/stream、/chat/history（聊天）
 *           + /agent/next-action、/agent/task/*（第 7 步驾驶员循环的“大脑”半边，要 JWT）
 *           + /knowledge、/knowledge/upload（第 11 步资料原文密文知识库，要 JWT）
 *           + /agents*、/memory/*（第 15 步多智能体 + 两层记忆，要 JWT）。
 * 服务器**不直接碰浏览器**：动作都返回给桌面主进程，由本地 driver.ts 执行。
 * 明确没有：邮箱登录、真微信；云端也拿不到 CDP（只出动作建议，执行与叫停在本地）。监听 127.0.0.1。
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadEnv } from './env';
import { makePool, migrate } from './db';
import { makeCipher } from './crypto';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAgentRoutes } from './routes/agent';
import { registerMemoryRoutes, startIdleScheduler } from './routes/memories';
import { registerKnowledgeRoutes, KNOWLEDGE_MAX_UPLOAD_BYTES } from './routes/knowledge';
import { registerMultiAgentRoutes } from './routes/agents';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = makePool(env.databaseUrl);
  const cipher = makeCipher(env.dataKey);
  const app = Fastify({ logger: false });

  // 桌面 dev 是 http://localhost:5173、生产是 file://（Origin: null）——回显来源即可；
  // 服务只听 127.0.0.1，不暴露局域网。
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });
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
