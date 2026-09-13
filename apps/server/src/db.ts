/**
 * pg 连接 + 幂等建表（第 5 步重做版）。除 auth 外的表本步只建结构：
 * users / projects / agents / conversations / messages(content 密文) / tasks / memories / sms_codes。
 *
 * users 要点：
 * - xyz_id：对外账号（XYZ+数字），UNIQUE，系统生成，用户不能自选；
 * - phone_hash：HMAC(pepper, 手机号) 的 UNIQUE —— 「一手机一用户」由它保证；明文不落库；
 * - phone_enc：AES-256-GCM 密文列（仅备展示）；
 * - password_hash：可空；没设密码时 XYZ+密码登录要**明确失败**；
 * - wechat_openid / wechat_unionid：本步只预留（可空），不做真微信。
 */
import { Pool, type PoolClient } from 'pg';

export function makePool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 4000 });
}

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  xyz_id         TEXT NOT NULL UNIQUE,
  phone_hash     TEXT UNIQUE,
  phone_enc      TEXT,
  password_hash  TEXT,
  wechat_openid  TEXT UNIQUE,
  wechat_unionid TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 短信验证码：只存哈希 + 每行随机 salt；60 秒限频 / 5 分钟过期都查这张表
CREATE TABLE IF NOT EXISTS sms_codes (
  id         BIGSERIAL PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes (phone_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id);

CREATE TABLE IF NOT EXISTS agents (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'assistant',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);

CREATE TABLE IF NOT EXISTS conversations (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id   BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id);

-- 消息正文只存 AES-256-GCM 密文（写入路径留给后续步骤，本步建表）
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content_enc     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS tasks (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending',
  title      TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  unread     BOOLEAN NOT NULL DEFAULT false,
  result_enc TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id, status);

-- 第 8 步：对老库幂等补列（新库上面已带）——unread 红点跟服务端走；结果文档加密放 result_enc
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS unread BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_enc TEXT;

-- 第 10 步：用户档案记忆挂 owner_id（全员共用）；老列 project_id/mem_key/value_enc 保留兼容
CREATE TABLE IF NOT EXISTS memories (
  id                BIGSERIAL PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id          BIGINT REFERENCES agents(id) ON DELETE SET NULL,
  mem_key           TEXT NOT NULL,
  value_enc         TEXT NOT NULL,
  owner_id          BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL DEFAULT 'preference',
  content_encrypted TEXT,
  source            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  needs_confirm     BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project_id);

-- 对第 5 步建过表的老库幂等补列（注入/列表一律按 owner_id 过滤，不按项目隔离）
ALTER TABLE memories ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'preference';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_encrypted TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS needs_confirm BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories (owner_id, status);
`;

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(DDL);
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 数据库连不上：给人话，不抛栈 */
export function isDbUnreachable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET',
    '08000', '08001', '08006', '57P01', '57P02', '57P03'].includes(code);
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
