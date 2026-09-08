// 古文断句/多版本比对/算书通道

import { callLLMJson } from './llmProxy.js';

// 算书 URN 前缀（ctext 子集）
const MATH_URN_PREFIXES = [
  'ctp:nine-chapters',     // 九章算术
  'ctp:zhoubi',            // 周髀算经
  'ctp:haizdao',           // 海岛算经
  'ctp:sunzi-suanjing',    // 孙子算经
  'ctp:zhangqiujian',      // 张丘建算经
  'ctp:wucao',             // 五曹算经
  'ctp:wujing',            // 五经算术
  'ctp:jigu',              // 缉古算经
  'ctp:xiahou-yang',       // 夏侯阳算经
];

/**
 * LLM 断句并提取检索锚点
 * @param {string} text - 古文片段（可能无标点/有讹字）
 * @param {string} apiKey - LLM Key
 * @returns {Object} {segmented, anchors[], suspected_err[]}
 */
export async function segmentAndExtract(text, apiKey) {
  const messages = [
    {
      role: 'system',
      content: '你是古籍校勘助手。下面是稿件中的古文片段（可能无标点/有讹字）。请：1. 断句并补标点（保留异体字原貌）；2. 提取 3 个最罕见的 5-7 字检索锚点（优先含数字、专名者）；3. 若疑似有讹字，标注疑似位置与建议校正。输出 JSON：{"segmented":"","anchors":[],"suspected_err":[]}。只输出 JSON，不要解释。',
    },
    { role: 'user', content: text },
  ];
  return await callLLMJson({
    messages,
    apiKey,
    temperature: 0.1,
    maxTokens: 1024,
  });
}

/**
 * LLM 多版本相似度打分
 * @param {string} original - 原始片段
 * @param {Array} matches - ctext 命中列表
 * @returns {Array} 打分后的 matches
 */
export async function scoreMatches(original, matches, apiKey) {
  if (!matches || matches.length === 0) return [];
  const matchesText = matches.map((m, i) =>
    `[${i + 1}] 书名:${m.book || '?'} 章节:${m.chapter || '?'} 原文:${m.text || ''}`
  ).join('\n');
  const messages = [
    {
      role: 'system',
      content: '你是古籍比对助手。对每个命中版本与原始片段做逐字相似度打分（容错异体字/通假字/繁简差异，0-1）。输出 JSON 数组：[{"index":1,"confidence":0.95,"note":""}]。只输出 JSON。',
    },
    {
      role: 'user',
      content: `原始片段：${original}\n\n命中版本：\n${matchesText}`,
    },
  ];
  const scores = await callLLMJson({
    messages,
    apiKey,
    temperature: 0.1,
    maxTokens: 1024,
  });
  // 合并分数到 matches
  return matches.map((m, i) => {
    const s = scores?.find(x => x.index === i + 1) || {};
    return {
      ...m,
      confidence: s.confidence || 0,
      note: s.note || '',
    };
  });
}

/**
 * 判断是否为算书查询
 */
export function isMathCategory(category) {
  return category === 'math';
}

/**
 * 获取算书 URN 前缀列表（用于限定 ctext 检索范围）
 */
export function getMathUrnPrefixes() {
  return MATH_URN_PREFIXES;
}

/**
 * 判断全部相似度是否过低（疑似讹误/辑佚）
 */
export function isAllLowConfidence(matches, threshold = 0.8) {
  if (!matches || matches.length === 0) return true;
  return matches.every(m => (m.confidence || 0) < threshold);
}

/**
 * 按版本聚类排序（原典 Library 优先）
 */
export function clusterByEdition(matches) {
  if (!matches) return [];
  // 简单实现：按 edition 字段分组，Library 优先
  const groups = {};
  for (const m of matches) {
    const ed = m.edition || 'unknown';
    if (!groups[ed]) groups[ed] = [];
    groups[ed].push(m);
  }
  const ordered = ['library', 'wiki', 'unknown'];
  const result = [];
  for (const ed of ordered) {
    if (groups[ed]) result.push(...groups[ed]);
  }
  // 剩余未列出的版本
  for (const ed of Object.keys(groups)) {
    if (!ordered.includes(ed)) result.push(...groups[ed]);
  }
  return result;
}
