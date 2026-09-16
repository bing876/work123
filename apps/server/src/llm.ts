/**
 * 第 16 步：模型调用的**唯一出口**（计数 + 日志）。
 *
 * 为什么要有这个文件：
 *   - 验收要求「空闲/保活时不调 LLM」必须**看得出来**。把 5 处 fetch 收成一个出口后，
 *     每次调用都会打一行 `[llm] #N ...`，`GET /health` 也回一个 `llmCalls` 计数——
 *     保活挂着没消息时，这两个数都不动，就是证据。
 *   - 顺手统一超时、JSON 模式、密钥只从这里出去（绝不进前端、绝不进日志）。
 *
 * 明确不做：不在这里做重试风暴、不做计费看板、不做 7×24 集群调度。
 */
import type { ServerEnv } from './env';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 第 21 步：assistant 要求调用工具时带上它（tool 角色的消息用 tool_call_id 回执） */
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmCallOptions {
  /** 调用方标签，只用于日志（例如 chat/stream、agent/next-action） */
  tag: string;
  stream?: boolean;
  /** 让模型只回一个 JSON 对象（DeepSeek 的 response_format） */
  json?: boolean;
  temperature?: number;
  /** 单次请求超时；默认 60s（流式聊天由调用方自己给 AbortController） */
  timeoutMs?: number;
  /** 调用方自己的 AbortSignal（流式聊天用：客户端断开就掐上游） */
  signal?: AbortSignal;
  /**
   * 第 21 步：工具表（OpenAI 兼容的 function 定义）。
   * 给了它才开 function call——闲聊路径**一个工具都不给**，所以闲聊不可能开页。
   */
  tools?: unknown[];
  /** 'auto'（默认，给工具时）/ 'none' / 'required' */
  toolChoice?: 'auto' | 'none' | 'required';
}

let calls = 0;
let lastAt = 0;
let lastTag = '';

/** 累计模型调用次数（/health 暴露它，用来证明空闲/保活不调模型） */
export function llmCallCount(): number {
  return calls;
}

export function llmLastCall(): { count: number; at: number; tag: string } {
  return { count: calls, at: lastAt, tag: lastTag };
}

/**
 * 调一次 chat/completions。返回原始 Response，交给调用方决定怎么读（流式 / JSON）。
 * 抛错就是连不上；HTTP 非 2xx 不在这里抛（调用方各自要不同的错误话术）。
 */
export async function llmFetch(env: ServerEnv, messages: LlmMessage[], opts: LlmCallOptions): Promise<Response> {
  calls += 1;
  lastAt = Date.now();
  lastTag = opts.tag;
  console.log(`[llm] #${calls} tag=${opts.tag} stream=${opts.stream ? 'yes' : 'no'} model=${env.deepseekModel}`);

  const body: Record<string, unknown> = {
    model: env.deepseekModel,
    stream: Boolean(opts.stream),
    messages,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  // 第 21 步：只有显式给了工具表才带 tools —— 闲聊/知识库轮不带，模型也就没有开页的能力。
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  return fetch(`${env.deepseekBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.deepseekApiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}
