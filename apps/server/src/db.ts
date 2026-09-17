/**
 * pg 连接 + 幂等建表（第 5 步重做版）。除 auth 外的表本步只建结构：
 * users / projects / agents / conversations / messages(content 密文) / tasks / memories / sms_codes，
 * 以及第 11 步独立的 knowledge_documents / knowledge_chunks（资料原文片段密文）。
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

-- 第 11 步：知识库和第 10 步 memories 完全分表。上传的原文件不落盘；
-- 文件名 filename_enc 与每个资料正文片段 content_enc 均为 AES-256-GCM 密文。
-- chunks 冗余 owner_id 以便按账号高效检索；查询仍同时校验 document.owner_id，防串号。
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename_enc TEXT NOT NULL,
  file_kind    TEXT NOT NULL CHECK (file_kind IN ('txt', 'md', 'pdf')),
  byte_size    INTEGER NOT NULL CHECK (byte_size >= 0),
  chunk_count  INTEGER NOT NULL CHECK (chunk_count > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_owner ON knowledge_documents (owner_id, id DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
  content_enc  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_owner ON knowledge_chunks (owner_id, document_id, chunk_index);

-- 第 15 步：智能体人设（用户在聊天里的「引导表」填的那四格）。
-- 刻意**不**塞进 memories：人设是智能体配置，不是记忆条目，混表会让两层记忆的读写互相污染。
-- persona_status：'pending' = 引导表还没填完（模型先引导，不空人设硬聊）；'ready' = 已按描述干活。
-- 老库里的 agents（含「小助」）走 DEFAULT 'ready'，不会被强制再走一遍引导表。
ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona_status TEXT NOT NULL DEFAULT 'ready';

-- 第 15 步 · 第一层：用户记忆库（账号级）。所有智能体都能读，属于「这个人」的习惯/口味/展示偏好。
-- 和第 10 步的 memories 完全分表（那张表是老确认流，本步不再往里写）。
CREATE TABLE IF NOT EXISTS user_memories (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mem_key      TEXT NOT NULL,
  content_enc  TEXT NOT NULL,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, mem_key)
);
CREATE INDEX IF NOT EXISTS idx_user_memories_owner ON user_memories (owner_id, updated_at DESC);

-- 第 16 步：轻量会话状态（每个智能体那条会话一份）——直接补在**现有会话表**上，
-- 不新建 SQLite、不建第二套库。这些字段每轮进模型上下文，否则改提示词也无效。
--   current_task     当前任务（最新一句用户消息覆盖它，改口立刻切换）
--   browser_confirmed 本会话是否已确认过用浏览器（已确认 → 普通点击/搜索/滚动/读页不再问）
--   keepalive         「启动并保活」监听态；空闲**不调模型**，来消息才走 /chat/stream
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS current_task TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS latest_user_intent TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS browser_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS login_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sensitive_action BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_page_summary TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS already_told_user_login_themselves BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS keepalive BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS state_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 第 15 步 · 第二层：项目记忆（智能体级）。一个智能体一份，**绝不串**。
-- agent_id 是 NOT NULL 外键：查询一律 owner_id + agent_id 双条件，别的智能体的项目记忆读不到；
-- 删智能体时级联删掉它自己的项目记忆（不会误伤别人）。
CREATE TABLE IF NOT EXISTS agent_memories (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mem_key      TEXT NOT NULL,
  content_enc  TEXT NOT NULL,
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, mem_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories (agent_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 子阶段 2-A：把「项目」从「一个用户一条默认项目」升级成真正的容器。
-- 注意：projects 表与 agents/conversations/tasks/memories 的 project_id 外键**本来就存在**
-- （第 5 步建的），这里补的是「当前项目」「母鸡权限」「知识库归属」三件缺的东西。
--
--   users.current_project_id       当前使用中的项目；为空时回落到 is_default 那条（老行为）
--   agents.can_create_agents       权限开关：能不能建智能体。母鸡 true；普通智能体默认 false
--   agents.kind = 'hen'            母鸡：随项目一起创建，**不可删除**（见 toAgentView / DELETE 路由）
--   knowledge_documents.project_id 知识库的项目归属（老数据在 migrateProjectScope 里回填到默认项目）
--   knowledge_chunks.project_id    同上；冗余一份是为了按项目高效检索，查询仍同时校验 document
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_create_agents BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_project ON knowledge_documents (project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_project ON knowledge_chunks (project_id, document_id, chunk_index);
`;


/**
 * 第 16 步 fixup：**一个智能体只能有一条会话**。
 *
 * 起因（本机实测到的真故障）：`ensureAgentConversation` 原来是「先查后插」，
 * 而桌面 dev 模式开着 React StrictMode，挂载 effect 会跑两遍 → 两个并发请求
 * 同时读到「还没有会话」→ 各插一条。结果「消息进了会话 A、状态读的是会话 B」，
 * 第 16 步的会话状态行 / 保活开关就写在了另一条会话上，核心功能在那条路径上失效。
 *
 * 这里做两件事，都幂等：
 *   1) 把历史遗留的重复会话并成一条 —— 保留「消息最多的那条」（并列取 id 最小），
 *      其余会话的消息先搬过去、再删掉空壳（删会话会级联删消息，所以必须先搬）；
 *   2) 加**部分唯一索引**当兜底（agent_id 非空时唯一），以后并发也插不进第二条。
 *
 * 索引创建失败只告警、不拦启动 —— 老库里若还有脏数据，服务也不该起不来。
 */
async function dedupeAgentConversations(pool: Pool): Promise<void> {
  // 「保留哪条」的判定：消息多者优先，并列取 id 最小。两条语句用同一段窗口函数，
  // 保证判定口径完全一致。DELETE 那一步是在消息搬完之后重新算的，
  // 此时保留的那条已经是消息最多的，所以判定稳定、可反复执行。
  const ranked = `
    SELECT c.id, c.agent_id,
           row_number() OVER (
             PARTITION BY c.agent_id
             ORDER BY (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.id ASC
           ) AS rn
      FROM conversations c
     WHERE c.agent_id IS NOT NULL`;
  try {
    const moved = await pool.query(
      `WITH ranked AS (${ranked}),
            keep AS (SELECT id, agent_id FROM ranked WHERE rn = 1),
            extra AS (SELECT r.id AS drop_id, k.id AS keep_id
                        FROM ranked r JOIN keep k ON k.agent_id = r.agent_id
                       WHERE r.rn > 1)
       UPDATE messages m SET conversation_id = e.keep_id FROM extra e WHERE m.conversation_id = e.drop_id`,
    );
    const dropped = await pool.query(`DELETE FROM conversations c USING (${ranked}) r WHERE c.id = r.id AND r.rn > 1`);
    if ((dropped.rowCount ?? 0) > 0) {
      console.warn(
        `[db] 并掉重复会话 ${dropped.rowCount} 条（搬走消息 ${moved.rowCount ?? 0} 条）——` +
          '这是「一个智能体一条会话」的幂等修复',
      );
    }
  } catch (err) {
    console.warn('[db] 重复会话归并失败（忽略，继续启动）：', (err as Error).message);
  }
}

/** 部分唯一索引兜底：agent_id 非空时必须唯一 */
async function ensureAgentConversationIndex(pool: Pool): Promise<void> {
  try {
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_agent ON conversations (agent_id) WHERE agent_id IS NOT NULL',
    );
  } catch (err) {
    console.warn(
      '[db] 唯一索引 uniq_conversations_agent 没建上（降级为只靠事务锁保证不重复）：',
      (err as Error).message,
    );
  }
}

/**
 * 子阶段 2-A 的**幂等数据迁移**（每次启动都跑，跑第二遍是空操作）。
 *
 * 三件事，都只补空值、绝不覆盖用户已经选过的值：
 *   1) `users.current_project_id` 为空 → 回落到该用户的默认项目（= 老行为，一行不变）；
 *   2) 权限开关不变量：自带「小助」与母鸡（kind='assistant' / 'hen'）必须有「建智能体」权限
 *      —— 这样**改造前就存在的账号**（没有母鸡，只有小助）也能继续点「＋ 添加」，
 *      不需要动前端；普通智能体默认 false，不受影响；
 *   3) 知识库归属：还没有 `project_id` 的老资料/片段 → 挂到**对应 owner 的默认项目**。
 *      按 owner 分别回填（不是一刀切挂到某一个项目），所以多用户库里不会串号。
 *
 * 最后把 `project_id` 收紧成 NOT NULL —— **只有确认一行 NULL 都不剩才收**，
 * 否则（比如某个用户没有项目）只告警、不拦启动。
 */
async function migrateProjectScope(pool: Pool): Promise<void> {
  try {
    const cur = await pool.query(
      `UPDATE users u
          SET current_project_id = (
                SELECT p.id FROM projects p WHERE p.user_id = u.id ORDER BY p.is_default DESC, p.id ASC LIMIT 1
              )
        WHERE u.current_project_id IS NULL`,
    );
    const perm = await pool.query(
      "UPDATE agents SET can_create_agents = true WHERE kind IN ('assistant', 'hen') AND can_create_agents = false",
    );
    const docs = await pool.query(
      `UPDATE knowledge_documents kd
          SET project_id = (
                SELECT p.id FROM projects p WHERE p.user_id = kd.owner_id ORDER BY p.is_default DESC, p.id ASC LIMIT 1
              )
        WHERE kd.project_id IS NULL`,
    );
    const chunks = await pool.query(
      `UPDATE knowledge_chunks kc
          SET project_id = (
                SELECT p.id FROM projects p WHERE p.user_id = kc.owner_id ORDER BY p.is_default DESC, p.id ASC LIMIT 1
              )
        WHERE kc.project_id IS NULL`,
    );

    const leftDocs = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_documents WHERE project_id IS NULL');
    const leftChunks = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_chunks WHERE project_id IS NULL');
    const docsLeft = Number(leftDocs.rows[0]?.n ?? 0);
    const chunksLeft = Number(leftChunks.rows[0]?.n ?? 0);
    if (docsLeft === 0 && chunksLeft === 0) {
      await pool.query('ALTER TABLE knowledge_documents ALTER COLUMN project_id SET NOT NULL');
      await pool.query('ALTER TABLE knowledge_chunks ALTER COLUMN project_id SET NOT NULL');
    } else {
      console.warn(
        `[db] 知识库 project_id 仍有空值（资料 ${docsLeft} 条 / 片段 ${chunksLeft} 条），` +
          '暂不收 NOT NULL —— 通常是这些 owner 名下没有项目，请先修数据',
      );
    }

    console.log(
      `[db] 项目层迁移完成：当前项目补 ${cur.rowCount ?? 0} 行、权限开关补 ${perm.rowCount ?? 0} 行、` +
        `知识库归属回填 资料 ${docs.rowCount ?? 0} 条 / 片段 ${chunks.rowCount ?? 0} 条`,
    );
  } catch (err) {
    console.warn('[db] 项目层迁移失败（忽略，继续启动）：', (err as Error).message);
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(DDL);
  await migrateProjectScope(pool);
  await dedupeAgentConversations(pool);
  await ensureAgentConversationIndex(pool);
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
