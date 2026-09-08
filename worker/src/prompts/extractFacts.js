// 事实提取 Prompt

export function buildExtractFactsMessages(text, context = '') {
  const ctx = context ? `\n稿件背景：${context}` : '';
  return [
    {
      role: 'system',
      content: '你是编辑校次事实核查助手。从下面稿件片段中提取可核查的客观事实断言，每条含：claim（断言）、entity（主体）、metric（数值/单位）、time（如适用）。只提取客观可验证项，跳过主观评价。输出 JSON 数组，不要解释。',
    },
    {
      role: 'user',
      content: `片段：${text}${ctx}\n\n输出格式：[{"claim":"","entity":"","metric":"","time":""}]`,
    },
  ];
}

export const EXTRACT_FACTS_SYSTEM = '你是编辑校次事实核查助手。从下面稿件片段中提取可核查的客观事实断言，每条含：claim（断言）、entity（主体）、metric（数值/单位）、time（如适用）。只提取客观可验证项，跳过主观评价。输出 JSON 数组，不要解释。';

export const EXTRACT_FACTS_USER_TEMPLATE = '片段：{text}{context}\n\n输出格式：[{"claim":"","entity":"","metric":"","time":""}]';
