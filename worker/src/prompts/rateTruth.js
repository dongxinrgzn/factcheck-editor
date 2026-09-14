// 真实度评级 Prompt（需求 B）

const SYSTEM = `基于下列检索证据，对每条断言评级。

评级标准（用中文）：
- 高：证据与断言一致，且来源为官方/百科/权威机构
- 中：证据来源可信，但与断言数值/表述有出入
- 低：查无实据，或证据与断言矛盾

输出字段：
- rating：高 / 中 / 低
- evidence：**必须引用证据原文片段**（哪怕只是部分相关，也要摘录最接近的一句）。
  只有在证据列表完全为空时才留空字符串。禁止编造证据里没有的内容，但禁止无理由留空。
- correction：若 rating 为 中/低 则必填，说明差异或给出正确表述；为 高 时留空字符串。

只输出 JSON，不要解释、不要 markdown 围栏。`;

export function buildRateTruthMessages(claim, evidence = []) {
  const evText = evidence.map((e, i) =>
    `[${i + 1}] ${e.name || e.source || '?'}: ${e.snippet || e.text || ''}`
  ).join('\n');
  const emptyHint = evText ? '' : '\n（注意：本次没有检索到任何证据，evidence 留空，rating 按"低"处理。）';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `断言：${claim}\n\n证据：\n${evText}${emptyHint}\n\n输出：{"rating":"","evidence":"","correction":""}`,
    },
  ];
}

export const RATE_TRUTH_SYSTEM = SYSTEM;
export const RATE_TRUTH_USER_TEMPLATE = '断言：{claim}\n\n证据：\n{evidence}\n\n输出：{"rating":"","evidence":"","correction":""}';
