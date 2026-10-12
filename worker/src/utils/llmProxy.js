// LLM 调用代理（支持 SiliconFlow / 豆包等 OpenAI 兼容格式）
// Provider 由 env 控制：LLM_BASE_URL + LLM_MODEL + LLM_API_KEY（见 initLLMProxy）

import { cleanLLMJson, cleanLLMText } from './cleanLLM.js';
import { withRetry } from './rateLimiter.js';

const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/chat/completions';

// 模块级配置（由 initLLMProxy 在每次请求入口初始化，Isolate 内生效）
let _baseUrl = SILICONFLOW_URL;
let _defaultModel = 'Qwen/Qwen2.5-72B-Instruct';
let _defaultApiKeyEnv = 'SILICONFLOW_KEY';

/**
 * 初始化 LLM Provider（在 index.js 的 fetch handler 开头调用）
 * env.LLM_BASE_URL 有值时切换 provider（如豆包 ark.cn-beijing.volces.com），
 * 未设置时保持 SiliconFlow 默认值——不影响现有部署。
 */
export function initLLMProxy(env) {
  _baseUrl = env.LLM_BASE_URL || SILICONFLOW_URL;
  _defaultModel = env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct';
  _defaultApiKeyEnv = env.LLM_BASE_URL ? 'LLM_API_KEY' : 'SILICONFLOW_KEY';
}

/**
 * 调用 LLM
 * @param {Object} opts - {messages, model, temperature, max_tokens, json_mode, apiKey}
 * @returns {string} LLM 返回的文本
 */
export async function callLLM(opts) {
  const {
    messages,
    model = _defaultModel,
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
  // 豆包系列默认启用深度思考（reasoning），一次调用多耗 400+ 推理 token、
  // 10 秒以上。事实核查场景不需要长链推理（prompt 已给出明确判断规则），
  // 禁用后实测 12s → 2.2s。非豆包 provider 忽略此参数。
  if (_baseUrl.includes('volces.com')) {
    body.thinking = { type: 'disabled' };
  }

  const fn = async () => {
    const resp = await fetch(_baseUrl, {
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
 * - 用户自带 sk- 开头 → 用用户的（SiliconFlow 格式）
 * - 管理员密码匹配 → 用环境变量（LLM_API_KEY 或 SILICONFLOW_KEY）
 * - 都没有 → 返回环境 Key（陌生人模式，走兜底限流）
 *
 * provider 切换时（LLM_BASE_URL 设置了豆包等），admin/guest 走 LLM_API_KEY；
 * 未设置时保持 SILICONFLOW_KEY 不变——不影响现有部署。
 */
export function resolveApiKey(userKey, env) {
  if (userKey && userKey.startsWith('sk-')) {
    return { apiKey: userKey, role: 'user', unlimited: true };
  }
  const envKey = _defaultApiKeyEnv === 'LLM_API_KEY'
    ? (env.LLM_API_KEY || env.SILICONFLOW_KEY)
    : env.SILICONFLOW_KEY;
  if (env.WORKER_KEY && userKey === env.WORKER_KEY) {
    return { apiKey: envKey, role: 'admin', unlimited: true };
  }
  return { apiKey: envKey, role: 'guest', unlimited: false };
}
