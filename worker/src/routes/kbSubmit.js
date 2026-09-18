// POST /api/kb/submit - 知识库入库端点（D，需管理员/审核员权限）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey } from '../utils/llmProxy.js';
import { submitDraft, approveEntry, mergeEntry, clearPending, listPending, listStale, autoAudit, listVerified, searchEntries, deleteEntry, getEntry, slugify, backupKB, normalizeCardFacts } from '../utils/kbStore.js';
import { clearAllCache, clearKBCache, acquireClearLock, markCacheCleared } from '../utils/cache.js';
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

  // 数据迁移：把 curator='auto_audit' 但 status 仍为 'verified' 的历史词条改为 'auto_verified'
  if (action === 'migrate_status') {
    const list = await env.FACT_KB.list({ prefix: 'kb:', limit: 1000 });
    let migrated = 0;
    for (const item of (list.keys || list || [])) {
      if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
          item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:')) continue;
      try {
        const raw = await env.FACT_KB.get(item.name);
        if (!raw) continue;
        const c = JSON.parse(raw);
        if (c.curator === 'auto_audit' && c.status === 'verified') {
          c.status = 'auto_verified';
          await env.FACT_KB.put(item.name, JSON.stringify(c));
          migrated++;
        }
      } catch {}
    }
    return jsonResponse({ ok: true, data: { migrated } }, 200, request);
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
    // 传 auditKv：删除留痕到 FACT_CACHE（kbaudit:del:*），便于事后追溯
    const result = await deleteEntry(env.FACT_KB, slug, env.FACT_CACHE, isAdmin ? 'admin' : 'curator');
    return jsonResponse({ ok: true, data: result }, 200, request);
  }

  // 手动触发知识库全量备份（正常由每日定时任务自动执行）
  if (action === 'backup') {
    const result = await backupKB(env.FACT_KB, env.FACT_CACHE);
    return jsonResponse({ ok: true, data: result }, 200, request);
  }

  // 归一化词条事实（维护用）：拆多属性长句、重贴属性标签、去重。
  // 修复历史脏数据（label 一律贴查询词 → 属性错配 + 长句埋数据 + 重复入库）。
  // 只重新归类/去重，不改写任何数值内容；approveEntry 会留存历史版本可回滚。
  // 批量改动整个知识库，仅限管理员。
  if (action === 'normalize_kb') {
    if (!isAdmin) return errorJson('仅管理员可执行', 403, 'FORBIDDEN', request);
    const onlySlug = body.slug || '';
    const list = await env.FACT_KB.list({ prefix: 'kb:', limit: 1000 });
    const keys = (list.keys || list || []).map(k => k.name).filter(n =>
      !n.startsWith('kb:alias:') && !n.startsWith('kb:idx:') &&
      !n.startsWith('kb:hist:') && !n.startsWith('kb:pending') && !n.startsWith('kbcache:'));
    const report = [];
    for (const n of keys) {
      const slug = n.slice(3);
      if (onlySlug && slug !== onlySlug) continue;
      const card = await getEntry(env.FACT_KB, slug);
      if (!card) continue;
      const r = normalizeCardFacts(card);
      const changed = r.after !== r.before || r.relabel > 0;
      if (changed) {
        await approveEntry(env.FACT_KB, slug, { ...card, facts: r.facts }, 'normalize');
      }
      report.push({ slug, title: card.title || '', changed,
                    before: r.before, after: r.after, split: r.split, dedup: r.dedup,
                    relabel: r.relabel, dropped: r.dropped });
    }
    await clearKBCache(env.FACT_KB);
    return jsonResponse({ ok: true, data: { scanned: report.length, report } }, 200, request);
  }

  // 清除所有缓存
  // 冷却在 action 层统一持有：KV 删除有 ~1 分钟传播窗口，期间 list 仍会返回
  // 已删的幽灵 key，连点会对同一批重复删除、每次都显示"清了 N 条"。
  // 90 秒冷却窗口内的重复请求直接返回 0 + cooldown 标记（前端提示"无缓存可清"）。
  if (action === 'clear_cache') {
    const { type = 'all' } = body;
    const locked = await acquireClearLock(env.FACT_CACHE);
    if (!locked) {
      return jsonResponse({ ok: true, data: {
        searchCache: { cleared: 0, cooldown: true },
        kbCache: { cleared: 0, cooldown: true },
      } }, 200, request);
    }
    let result = {};
    let clearedTotal = 0;
    if (type === 'all' || type === 'search') {
      const searchResult = await clearAllCache(env.FACT_CACHE, { skipLock: true });
      result.searchCache = searchResult;
      clearedTotal += searchResult.cleared || 0;
    }
    if (type === 'all' || type === 'kb') {
      const kbResult = await clearKBCache(env.FACT_KB, { skipLock: true });
      result.kbCache = kbResult;
      clearedTotal += kbResult.cleared || 0;
    }
    if (clearedTotal > 0) await markCacheCleared(env.FACT_CACHE);
    return jsonResponse({ ok: true, data: result }, 200, request);
  }

  // 手动入库：用户点击"入库"按钮，直接审核通过入库（不经过待审队列）
  if (action === 'manual_store') {
    const { card } = body;
    if (!card || !card.title) return errorJson('card 字段必填且需要 title', 400, 'BAD_REQUEST', request);
    const slug = card.id || slugify(card.title);
    // 同名词条 → 合并追加新事实（去重），绝不整卡覆盖——
    // 否则第二次入库会把第一次的事实全部丢掉（事故：大熊猫身高入库覆盖了体重）
    const existing = await getEntry(env.FACT_KB, slug);
    let result;
    if (existing) {
      const mr = await mergeEntry(env.FACT_KB, slug, { ...card, status: 'verified' }, isAdmin ? 'admin' : 'curator');
      result = { ...mr, slug, merged: true, stored: mr.added > 0 };
    } else {
      result = await approveEntry(env.FACT_KB, slug, { ...card, status: 'verified', category: '人工' }, isAdmin ? 'admin' : 'curator');
    }
    await clearKBCache(env.FACT_KB);
    return jsonResponse({ ok: true, data: { ...result, card, stored: true } }, 200, request);
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
