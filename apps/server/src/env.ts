/**
 * 环境变量装载：只信真实环境变量 / apps/server/.env（dotenv 读，.env 不提交）。
 * - 缺 DATABASE_URL / JWT_SECRET / DATA_KEY → 直接拒绝启动（比带弱密钥上线安全）。
 * - 短信：SMS_MOCK=1 或 NODE_ENV≠production → 开发模式（验证码只进服务器日志）；
 *   production 且没配 SMS_HTTP_URL → 启动时打警告，发送接口运行时拒绝并说人话。
 */
export interface ServerEnv {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  dataKey: string;
  /** 手机号哈希 pepper；缺省退回 dataKey */
  phonePepper: string;
  smsMock: boolean;
  smsHttpUrl: string;
  isProduction: boolean;
  /** 第 6 步：DeepSeek 流式聊天。key 只允许存在这里（apps/server/.env），缺失不拒启——/chat/stream 自己拒答 */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
}

export function loadEnv(): ServerEnv {
  const port = Number(process.env.PORT || '8787');
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  const jwtSecret = (process.env.JWT_SECRET || '').trim();
  const dataKey = (process.env.DATA_KEY || '').trim();

  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!jwtSecret) missing.push('JWT_SECRET');
  if (!dataKey) missing.push('DATA_KEY');
  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量：${missing.join('、')}。` +
        '复制 apps/server/.env.example 为 apps/server/.env 并填写（.env 已被 .gitignore，不要提交）。',
    );
  }
  if (jwtSecret.length < 16) {
    throw new Error('JWT_SECRET 太短：至少 16 字符。');
  }
  if (dataKey.length < 16) {
    throw new Error('DATA_KEY 太短：建议用 64 位十六进制。');
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不合法：${process.env.PORT}`);
  }

  const isProduction = (process.env.NODE_ENV || 'development').trim() === 'production';
  const smsMock = process.env.SMS_MOCK === '1' || process.env.SMS_MOCK === 'true' || !isProduction;
  const smsHttpUrl = (process.env.SMS_HTTP_URL || '').trim();
  if (isProduction && !smsMock && !smsHttpUrl) {
    console.warn(
      '[server] 生产模式但没配短信通道（SMS_MOCK 未开、SMS_HTTP_URL 为空）：' +
        '/auth/sms/send 会拒绝发送并提示配置，服务其余部分照常。',
    );
  }

  return {
    port,
    databaseUrl,
    jwtSecret,
    dataKey,
    phonePepper: (process.env.PHONE_PEPPER || '').trim() || dataKey,
    smsMock,
    smsHttpUrl,
    isProduction,
    deepseekApiKey: (process.env.DEEPSEEK_API_KEY || '').trim(),
    deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || '').trim() || 'https://api.deepseek.com',
    deepseekModel: (process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat',
  };
}
