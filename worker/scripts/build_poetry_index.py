# 构建「诗词库」紧凑索引 → poetry_index.json
# 数据源：jackeyGao/chinese-poetry（唐诗三百首/宋词三百首/诗经）
# 繁→简：OpenCC TSCharacters.txt（建索引时转换，Worker 端零转换表）
# 输出字段：t=标题(简) a=作者(简) r=词牌 c=合集 ch=诗经章节 p=段落(简) f=首行规范化 n=全文规范化(去标点)
import sys, json, re
sys.stdout.reconfigure(encoding='utf-8')

W = 'G:/WorkBuddySpace/'

# ---- 繁→简映射 ----
t2s = {}
with open(W + '_t2s_txt.txt', encoding='utf-8') as fh:
    for line in fh:
        line = line.rstrip('\n')
        if not line or '\t' not in line:
            continue
        trad, sim = line.split('\t', 1)
        t2s[trad] = sim[0]  # 取第一个简体候选

def conv(s):
    return ''.join(t2s.get(ch, ch) for ch in str(s or ''))

def norm(s):
    return ''.join(ch for ch in conv(s) if '\u4e00' <= ch <= '\u9fff')

entries = []

# ---- 唐诗三百首 ----
for it in json.load(open(W + '_tang.json', encoding='utf-8')):
    paras = [conv(p) for p in (it.get('paragraphs') or [])]
    full = ''.join(paras)
    entries.append({
        't': conv(it.get('title', '')),
        'a': conv(it.get('author', '')),
        'c': '唐诗三百首',
        'p': paras,
        'f': norm(full)[:20],
        'n': norm(full),
    })

# ---- 宋词三百首 ----
for it in json.load(open(W + '_songci.json', encoding='utf-8')):
    paras = [conv(p) for p in (it.get('paragraphs') or [])]
    full = ''.join(paras)
    e = {
        't': conv(it.get('rhythmic') or it.get('title', '')),  # 词牌作标题
        'a': conv(it.get('author', '')),
        'c': '宋词三百首',
        'p': paras,
        'f': norm(full)[:20],
        'n': norm(full),
    }
    entries.append(e)

# ---- 诗经 ----
for it in json.load(open(W + '_shijing.json', encoding='utf-8')):
    paras = [conv(p) for p in (it.get('content') or [])]
    full = ''.join(paras)
    ch = (str(it.get('chapter', '')) + '·' + str(it.get('section', ''))).strip('·')
    entries.append({
        't': conv(it.get('title', '')),
        'a': '',
        'c': '诗经',
        'ch': ch,
        'p': paras,
        'f': norm(full)[:20],
        'n': norm(full),
    })

# 过滤无效条目
entries = [e for e in entries if e['t'] and len(e['n']) >= 8]

out = json.dumps(entries, ensure_ascii=False, separators=(',', ':'))
open(W + 'poetry_index.json', 'w', encoding='utf-8').write(out)

by_c = {}
for e in entries:
    by_c[e['c']] = by_c.get(e['c'], 0) + 1
print('条目数:', len(entries), by_c)
print('索引大小:', len(out.encode('utf-8')) // 1024, 'KB')
# 抽查繁简转换
print('样例1:', entries[0]['t'], entries[0]['a'], '|', entries[0]['p'][0][:20])
for e in entries:
    if e['t'] == '浪淘沙' or '浪淘沙' in e['t']:
        print('浪淘沙样例:', e['t'], e['a'], '|', e['p'][0][:24], '| f=', e['f'])
        break
