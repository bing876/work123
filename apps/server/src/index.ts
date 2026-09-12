/**
 * AI 工作台最小后端（第 5 步·账号重做版）。
 *
 * 接口面：GET /health（无需登录）+ /auth/*（sms/send、login/sms、login/xyz、password/set、me、wechat 占位）。
 * 明确没有：邮箱登录、/chat/stream、大模型调用、真微信。监听 127.0.0.1，只服务本机桌面端。
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from './env';
import { makePool, migrate } from './db';
import { makeCipher } from './crypto';
import { registerAuthRoutes } from './routes/auth';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = makePool(env.databaseUrl);
  const cipher = makeCipher(env.dataKey);
  const app = Fastify({ logger: false });

  // 桌面 dev 是 http://localhost:5173、生产是 file://（Origin: null）——回显来源即可；
  // 服务只听 127.0.0.1，不暴露局域网。
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

  app.get('/health', async () => {
    let db: 'up' | 'down' = 'down';
    try {
      await pool.query('SELECT 1');
      db = 'up';
    } catch {
      /* 库没起也不让健康检查崩：桌面要能区分“后端没起”和“后端起了库没起” */
    }
    return { ok: true, service: 'ai-workbench-server', db, sms: env.smsMock ? 'mock' : 'http', time: new Date().toISOString() };
  });

  registerAuthRoutes(app, { pool, env, cipher });

  try {
    await migrate(pool);
    console.log('[server] 数据库表就绪（users/projects/agents/sms_codes/conversations/messages/tasks/memories）');
  } catch (err) {
    console.warn('[server] 数据库暂未连通，服务照常起（/auth 会回 503 提示）：', (err as Error).message);
  }

  await app.listen({ port: env.port, host: '127.0.0.1' });
  console.log(`[server] http://127.0.0.1:${env.port} —— GET /health；短信模式：${env.smsMock ? 'mock（验证码只进本日志）' : 'http 网关'}`);
}

main().catch((err) => {
  console.error('[server] 启动失败：', (err as Error).message);
  process.exit(1);
});
