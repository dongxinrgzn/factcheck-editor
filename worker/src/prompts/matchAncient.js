// 古文断句与出处匹配 Prompt（需求 C）

export function buildSegmentMessages(text) {
  return [
    {
      role: 'system',
      content: '下面是稿件中的古文片段（可能无标点/有讹字）。请：1. 断句并补标点（保留异体字原貌）；2. 提取 3 个最罕见的 5-7 字检索锚点（优先含数字、专名者）；3. 若疑似有讹字，标注疑似位置与建议校正。输出 JSON：{"segmented":"","anchors":[],"suspected_err":[]}',
    },
    { role: 'user', content: text },
  ];
}

export function buildScoreMatchesMessages(original, matches) {
  const mText = matches.map((m, i) =>
    `[${i + 1}] 书名:${m.book || '?'} 章节:${m.chapter || '?'} 原文:${m.text || ''}`
  ).join('\n');
  return [
    {
      role: 'system',
      content: '你是古籍比对助手。对每个命中版本与原始片段做逐字相似度打分（容错异体字/通假字/繁简差异，0-1）。输出 JSON 数组：[{"index":1,"confidence":0.95,"note":""}]',
    },
    {
      role: 'user',
      content: `原始片段：${original}\n\n命中版本：\n${mText}`,
    },
  ];
}

export function buildMathExtractMessages(text) {
  return [
    {
      role: 'system',
      content: '你是古籍校勘助手。从下面的古文片段中判断其所属的古籍书名（如《论语》《道德经》《孟子》《庄子》《九章算术》《荀子》《管子》等，无法判断则留空）。同时提取关键特征词。输出 JSON：{"suspected_book":"","numbers":[],"target":"","keywords":[]}',
    },
    { role: 'user', content: text },
  ];
}

export const SEGMENT_SYSTEM = '下面是稿件中的古文片段（可能无标点/有讹字）。请：1. 断句并补标点（保留异体字原貌）；2. 提取 3 个最罕见的 5-7 字检索锚点（优先含数字、专名者）；3. 若疑似有讹字，标注疑似位置与建议校正。输出 JSON：{"segmented":"","anchors":[],"suspected_err":[]}';
