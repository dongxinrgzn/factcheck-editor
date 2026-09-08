// LLM 输出清洗（防 Qwen 乱码，沿用 STORM 经验）

/**
 * 清洗 LLM 返回的 JSON 文本，解析为对象/数组
 * 处理：```json 围栏、尾随逗号、控制字符、Qwen 常见乱码
 */
export function cleanLLMJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('LLM_OUTPUT_EMPTY');
  }
  let s = raw;
  // 1. 去除 Qwen 常见的 ```json 围栏
  s = s.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // 2. 截取首个 [ 或 { 到最后一个 ] 或 }
  const starts = ['[', '{'].map(c => s.indexOf(c)).filter(i => i >= 0);
  if (starts.length === 0) {
    throw new Error('LLM_OUTPUT_INVALID');
  }
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end < 0) {
    throw new Error('LLM_OUTPUT_INVALID');
  }
  s = s.slice(start, end + 1);
  // 3. 尾随逗号清理
  s = s.replace(/,(\s*[}\]])/g, '$1');
  // 4. 控制字符清除（Qwen 偶发 U+200B/U+200C/U+200D/U+FEFF）
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  // 5. 中文标点间的 "D" 乱码（Qwen2.5 偶发）
  s = s.replace(/([\u4e00-\u9fa5）])\s*D{1,3}\s*([\u4e00-\u9fa5（])/g, '$1，$2');
  return JSON.parse(s);
}

/**
 * 清洗 LLM 返回的纯文本（综述/古文等）
 * 处理：D 乱码、重复字符、重复双字词、连续逗号
 */
export function cleanLLMText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let out = text;
  // 1. 中文字符间孤立 D/DD → 中文逗号
  out = out.replace(/([\u4e00-\u9fa5）])\s*D{1,3}\s*([\u4e00-\u9fa5（])/g, '$1，$2');
  // 2. "###D标题" → "### 标题"
  out = out.replace(/(#{1,6})D/g, '$1 ');
  // 3. 行首 "D 数字" 前缀移除
  out = out.replace(/^D\s+(\d)/gm, '$1');
  // 4. 折叠重复字符 "等等等等等"→"等等"
  out = out.replace(/([\u4e00-\u9fa5])\1{3,}/g, '$1$1');
  // 5. 折叠重复双字词 "认知认知认知"→"认知"
  out = out.replace(/([\u4e00-\u9fa5]{2})\1{2,}/g, '$1');
  // 6. 连续逗号折叠
  out = out.replace(/，{2,}/g, '，');
  return out;
}
