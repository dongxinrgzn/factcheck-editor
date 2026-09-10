// 真实度评级 Prompt（需求 B）

export function buildRateTruthMessages(claim, evidence = []) {
  const evText = evidence.map((e, i) =>
    `[${i + 1}] ${e.name || e.source || '?'}: ${e.snippet || e.text || ''}`
  ).join('\n');
  return [
    {
      role: 'system',
      content: '基于下列检索证据，对每条断言评级。评级用中文：高（官方源且数值一致；若断言数值落在证据给出的正常范围/区间内，也算一致，评高）/ 中（源可信但证据与断言无法直接对应、或仅有间接出入）/ 低（查无实据、数值明确超出证据范围或多源矛盾）。给出：依据（引用证据原文）、纠错建议（若 中/低 必填）。输出 JSON，禁止编造未给出的证据。',
    },
    {
      role: 'user',
      content: `断言：${claim}\n\n证据：\n${evText}\n\n输出：{"rating":"","evidence":"","correction":""}`,
    },
  ];
}

export const RATE_TRUTH_SYSTEM = '基于下列检索证据，对每条断言评级。评级用中文：高（官方源且数值一致；若断言数值落在证据给出的正常范围/区间内，也算一致，评高）/ 中（源可信但证据与断言无法直接对应、或仅有间接出入）/ 低（查无实据、数值明确超出证据范围或多源矛盾）。给出：依据（引用证据原文）、纠错建议（若 中/低 必填）。输出 JSON，禁止编造未给出的证据。';

export const RATE_TRUTH_USER_TEMPLATE = '断言：{claim}\n\n证据：\n{evidence}\n\n输出：{"rating":"","evidence":"","correction":""}';
