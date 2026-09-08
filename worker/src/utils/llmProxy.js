// SiliconFlow LLM 调用代理（Qwen2.5-72B）

import { cleanLLMJson, cleanLLMText } from './cleanLLM.js';
import { withRetry } from './rateLimiter.js';

const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/chat/completions';

/**
 * 调用 SiliconFlow LLM
 * @param {Object} opts - {messages, model, temperature, max_tokens, json_mode, apiKey}
 * @returns {string} LLM 返回的文本
 */
export async function callLLM(opts) {
  const {
    messages,
    model = 'Qwen/Qwen2.5-72B-Instruct',
    temperature = 0.3,
    maxTokens = 2048,
    jsonMode = false,
    apiKey,
  } = opts;

  if (!apiKey) throw new Error('LLM_API_KEY_MISSING');

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const fn = async () => {
    const resp = await fetch(SILICONFLOW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`LLM_HTTP_${resp.status}: ${txt.slice(0, 200)}`);
    }
    const j = await resp.json();
    const content = j?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('LLM_EMPTY_RESPONSE');
    return content;
  };

  return withRetry(fn, { retries: 2, baseDelay: 1200 });
}

/**
 * 调用 LLM 并解析为 JSON
 */
export async function callLLMJson(opts) {
  const content = await callLLM({ ...opts, jsonMode: false });
  return cleanLLMJson(content);
}

/**
 * 调用 LLM 返回清洗后的纯文本
 */
export async function callLLMText(opts) {
  const content = await callLLM(opts);
  return cleanLLMText(content);
}

/**
 * 选择有效 API Key（三档权限逻辑）
 * - 用户自带 sk- 开头 → 用用户的
 * - 管理员密码匹配 → 用环境变量
 * - 都没有 → 返回 null（陌生人模式，走兜底限流）
 */
export function resolveApiKey(userKey, env) {
  if (userKey && userKey.startsWith('sk-')) {
    return { apiKey: userKey, role: 'user', unlimited: true };
  }
  if (env.WORKER_KEY && userKey === env.WORKER_KEY) {
    return { apiKey: env.SILICONFLOW_KEY, role: 'admin', unlimited: true };
  }
  return { apiKey: env.SILICONFLOW_KEY, role: 'guest', unlimited: false };
}
