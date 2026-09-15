// 真实度评级 Prompt（需求 B）

const SYSTEM = `基于下列检索证据，对每条断言评级。

第一步（必做）：先判断「证据是否在讲同一件事」。
- 证据必须指向断言的同一实体、同一主题。**同名不同实体不算证据**。
  例：断言谈刘禹锡的词《浪淘沙·其六》，而检索到的《浪淘沙》是台湾作家东方白的小说
  —— 同名不同实体，这不构成任何证据，更不能据此说"作者应为刘禹锡而非东方白"。
- 证据只顺带提到关键词、实际在讲别的东西（如用"金"字命名的地名、物种名），也不算证据。
- 若全部证据都与断言无关 → rating 记"低"，evidence 留空，correction 留空。
  **严禁**依据无关证据编造"应为…而非…"式的纠错，那是对用户的误导。

第二步（证据相关时才评级，用中文）：
- 高：证据与断言一致，且来源为官方/百科/权威机构
- 中：证据来源可信，但与断言数值/表述有出入
- 低：证据与断言矛盾，或只能部分支持

输出字段：
- rating：高 / 中 / 低
- evidence：**引用证据原文片段**（摘录最接近的一句）。证据与断言无关、或证据列表为空时，
  留空字符串。禁止编造证据里没有的内容，禁止用无关证据硬凑。
- correction：仅在"证据相关、且与断言确有出入或矛盾"时填写（rating 为"高"时留空）。
  证据不相关或没有证据时一律留空字符串 —— 报告会自行显示"未检索到可引用证据"。

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
