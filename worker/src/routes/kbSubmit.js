// POST /api/kb/submit - 知识库入库端点（D，需管理员/审核员权限）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey } from '../utils/llmProxy.js';
import { submitDraft, approveEntry, clearPending, listPending, listStale, autoAudit, listVerified, searchEntries, deleteEntry, getEntry, slugify } from '../utils/kbStore.js';
import { runCheck } from './check.js';

export async function handleKbSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  // 权限：必须是管理员或审核员
  const userKey = request.headers.get('X-Worker-Key') || '';
  const clientIp = getClientIp(request);
  const { role } = resolveApiKey(userKey, env);

  const isCurator = env.KB_CURATOR_PASSWORD && userKey === env.KB_CURATOR_PASSWORD;
  const isAdmin = role === 'admin';

  if (!isAdmin && !isCurator) {
    return errorJson('需要管理员或审核员权限', 403, 'FORBIDDEN', request);
  }

  const { action = 'submit' } = body;

  // 列出待审
  if (action === 'list_pending') {
    const items = await listPending(env.FACT_KB, 50);
    return jsonResponse({ ok: true, data: { items } }, 200, request);
  }

  // 列出待复核
  if (action === 'list_stale') {
    const items = await listStale(env.FACT_KB, 180, 100);
    return jsonResponse({ ok: true, data: { items } }, 200, request);
  }

  // 审核通过
  if (action === 'approve') {
    const { slug, card: approveCard, timestamp } = body;
    if (!slug) return errorJson('slug 字段必填', 400, 'BAD_REQUEST', request);
    const result = await approveEntry(env.FACT_KB, slug, approveCard || card, isAdmin ? 'admin' : 'curator');
    if (timestamp) await clearPending(env.FACT_KB, timestamp, slug);
    return jsonResponse({ ok: true, data: result }, 200, request);
  }

  // 驳回（不通过）待审词条
  if (action === 'reject') {
    const { slug, timestamp } = body;
    if (timestamp && slug) {
      await clearPending(env.FACT_KB, timestamp, slug);
    } else if (slug) {
      // 没有 timestamp 时，按前缀删除 pending 记录
      const pending = await env.FACT_KB.list({ prefix: 'kb:pending:', limit: 50 });
      for (const k of (pending.keys || pending || [])) {
        if (k.name.endsWith(`:${slug}`)) {
          await env.FACT_KB.delete(k.name);
        }
      }
    }
    return jsonResponse({ ok: true, data: { rejected: slug } }, 200, request);
  }

  // 列出已入库词条
  if (action === 'list_verified') {
    const { limit, cursor } = body;
    const data = await listVerified(env.FACT_KB, limit || 100, cursor || null);
    return jsonResponse({ ok: true, data }, 200, request);
  }

  // 搜索知识库
  if (action === 'search') {
    const { keyword } = body;
    if (!keyword) return errorJson('keyword 字段必填', 400, 'BAD_REQUEST', request);
    const items = await searchEntries(env.FACT_KB, keyword);
    return jsonResponse({ ok: true, data: { items } }, 200, request);
  }

  // 查看词条详情
  if (action === 'get') {
    const { slug } = body;
    if (!slug) return errorJson('slug 字段必填', 400, 'BAD_REQUEST', request);
    const card = await getEntry(env.FACT_KB, slug);
    if (!card) return errorJson('词条不存在', 404, 'NOT_FOUND', request);
    return jsonResponse({ ok: true, data: { card } }, 200, request);
  }

  // 删除词条
  if (action === 'delete') {
    const { slug } = body;
    if (!slug) return errorJson('slug 字段必填', 400, 'BAD_REQUEST', request);
    const result = await deleteEntry(env.FACT_KB, slug);
    return jsonResponse({ ok: true, data: result }, 200, request);
  }

  // 提议入库
  let card = body.card;
  const text = (body.text || '').trim();

  // 空壳卡片（前端只给了标题/句子）时，后端跑核查流程自动构建
  const isShell = !card || !Array.isArray(card.facts) || card.facts.length === 0;
  if (isShell) {
    const sourceText = text || (card?.title || '').trim();
    if (!sourceText) {
      return errorJson('text 或 card.title 字段必填', 400, 'BAD_REQUEST', request);
    }
    try {
      const { apiKey } = resolveApiKey(userKey, env);
      const checkData = await runCheck(sourceText, body.context || '', env, apiKey, { autoDraft: false });
      card = checkData.draftCard;
    } catch (e) {
      return errorJson(`自动提取事实失败：${e.message}`, 502, 'LLM_ERROR', request);
    }
    if (!card) {
      return errorJson('未能从该文本提取到可入库的事实，请补充检索后再提交', 422, 'NO_FACTS', request);
    }
  }

  if (!card.title) {
    return errorJson('card.title 字段必填', 400, 'BAD_REQUEST', request);
  }

  // 自动审核门槛：满足条件直接转正，不满足进 pending 等人审
  const audit = autoAudit(card);
  if (audit.pass) {
    // 自动转正
    const slug = card.id || slugify(card.title);
    const result = await approveEntry(env.FACT_KB, slug, { ...card, status: 'auto_verified' }, 'auto_audit');
    return jsonResponse({ ok: true, data: { ...result, card, auto_audited: true, audit_reasons: [] } }, 200, request);
  }
  // 不满足门槛 → 进待审队列
  const result = await submitDraft(env.FACT_KB, card);
  return jsonResponse({ ok: true, data: { ...result, card, auto_audited: false, audit_reasons: audit.reasons } }, 200, request);
}

// GET /api/kb/entry/:key - 词条详情
export async function handleKbEntry(request, env, key) {
  if (!key) {
    return errorJson('key 不能为空', 400, 'BAD_REQUEST', request);
  }
  const { getEntry } = await import('../utils/kbStore.js');
  const card = await getEntry(env.FACT_KB, key);
  if (!card) {
    return errorJson('词条不存在', 404, 'NOT_FOUND', request);
  }
  return jsonResponse({ ok: true, data: { card } }, 200, request);
}
