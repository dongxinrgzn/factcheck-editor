// ctext.org 古籍原文匹配（多学科通用）
// ctext 章节页含静态繁体原文（class="ctext"），免认证可直接抓取

let lastCallTime = 0;

async function rateLimit(minIntervalMs = 400) {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < minIntervalMs) {
    await new Promise(r => setTimeout(r, minIntervalMs - elapsed));
  }
  lastCallTime = Date.now();
}

// ---------- 古籍配置（ctext URL slug → 章节） ----------

export const CLASSIC_TEXTS = [
  // 数学
  {
    discipline: '数学',
    keywords: ['九章算术', '九章算術', '九章'],
    book: 'nine-chapters',
    label: '《九章算術》',
    chapters: ['fang-tian', 'shu-mi', 'cui-fen', 'shao-guang', 'shang-gong', 'jun-shu', 'ying-bu-zu', 'fang-cheng', 'gou-gu'],
    chapterNames: ['方田', '粟米', '衰分', '少廣', '商功', '均輸', '盈不足', '方程', '句股'],
    matchMode: 'fingerprint',
  },
  // 哲学·论语（20篇）
  {
    discipline: '哲学',
    keywords: ['论语', '論語'],
    book: 'analects',
    label: '《論語》',
    chapters: ['xue-er', 'wei-zheng', 'ba-yi', 'li-ren', 'gong-ye-chang', 'yong-ye', 'shu-er', 'tai-bo', 'zi-han', 'xiang-dang', 'xian-jin', 'yan-yuan', 'zi-lu', 'xian-wen', 'wei-ling-gong', 'ji-shi', 'yang-huo', 'wei-zi', 'zi-zhang', 'yao-yue'],
    chapterNames: ['學而', '為政', '八佾', '里仁', '公冶長', '雍也', '述而', '泰伯', '子罕', '鄉黨', '先進', '顏淵', '子路', '憲問', '衛靈公', '季氏', '陽貨', '微子', '子張', '堯曰'],
    matchMode: 'charOverlap',
  },
  // 哲学·道德经（单页）
  {
    discipline: '哲学',
    keywords: ['道德经', '道德經', '老子'],
    book: 'dao-de-jing',
    label: '《道德經》',
    chapters: [],
    chapterNames: [],
    matchMode: 'charOverlap',
  },
  // 哲学·孟子（单页）
  {
    discipline: '哲学',
    keywords: ['孟子'],
    book: 'mengzi',
    label: '《孟子》',
    chapters: [],
    chapterNames: [],
    matchMode: 'charOverlap',
  },
  // 哲学·庄子（单页）
  {
    discipline: '哲学',
    keywords: ['庄子', '莊子'],
    book: 'zhuangzi',
    label: '《莊子》',
    chapters: [],
    chapterNames: [],
    matchMode: 'charOverlap',
  },
  // 哲学·荀子（多章节）
  {
    discipline: '哲学',
    keywords: ['荀子'],
    book: 'xunzi',
    label: '《荀子》',
    chapters: ['quan-xue', 'xiu-shen', 'bu-gou', 'rong-ru', 'fei-xiang', 'fei-shi-er-zi', 'fei-shi-zi', 'zheng-lun', 'li-lun'],
    chapterNames: ['勸學', '修身', '不苟', '榮辱', '非相', '非十二子', '非十二子', '正論', '禮論'],
    matchMode: 'charOverlap',
  },
  // 哲学·管子（多章节）
  {
    discipline: '哲学',
    keywords: ['管子'],
    book: 'guanzi',
    label: '《管子》',
    chapters: ['mu-min', 'quan-xiu', 'li-zheng', 'ba-guan', 'wen-zhuan', 'zheng-yan', 'xiao-kuang'],
    chapterNames: ['牧民', '權修', '立政', '霸言', '問', '正言', '小匡'],
    matchMode: 'charOverlap',
  },
];

// ---------- 匹配算法 ----------

// 数字+量词指纹（适用于数学/天文/历法古籍，繁简通用）
const FINGERPRINT_RE = /[一二三四五六七八九十百千萬万零兩两0-9]+[步里人錢钱尺丈寸石斗升斤兩两天年月日個个枚頭头匹張张篇條条句字則则分]/g;

function fingerprints(s) {
  const m = String(s || '').match(FINGERPRINT_RE) || [];
  return new Set(m.map(x => x.replace('万', '萬').replace('两', '兩').replace('钱', '錢')));
}

// 简繁映射（常见差异字，将用户简体归一为繁体再与 ctext 原文比对）
const SIMP_TO_TRAD = {
  '学':'學','时':'時','习':'習','说':'說','语':'語','论':'論','经':'經','书':'書',
  '写':'寫','为':'為','国':'國','问':'問','间':'間','长':'長','东':'東','车':'車',
  '马':'馬','风':'風','广':'廣','关':'關','见':'見','观':'觀','发':'發','动':'動',
  '节':'節','记':'記','认':'認','让':'讓','讲':'講','读':'讀','万':'萬','两':'兩',
  '与':'與','过':'過','这':'這','还':'還','边':'邊','业':'業','专':'專','乐':'樂',
  '义':'義','农':'農','艺':'藝','计':'計','质':'質','网':'網','归':'歸','当':'當',
  '处':'處','声':'聲','岁':'歲','产':'產','从':'從','乡':'鄉','丰':'豐','临':'臨','几':'幾','广':'廣',
  '举':'舉','亲':'親','仪':'儀','华':'華','协':'協','单':'單','双':'雙','变':'變',
  '叠':'疊','号':'號','叶':'葉','听':'聽','员':'員','图':'圖','园':'園','圣':'聖',
  '坚':'堅','场':'場','墙':'牆','壮':'壯','复':'復','头':'頭','奋':'奮','奖':'獎',
  '妇':'婦','妈':'媽','孙':'孫','宁':'寧','宝':'寶','实':'實','审':'審','寻':'尋',
  '将':'將','尝':'嘗','层':'層','岛':'島','岁':'歲','岂':'豈','岭':'嶺','崭':'嶄',
  '带':'帶','帮':'幫','帜':'幟','庄':'莊','庆':'慶','庐':'廬','库':'庫','应':'應',
  '废':'廢','开':'開','异':'異','弃':'棄','弯':'彎','弹':'彈','强':'強','忧':'憂',
  '怀':'懷','总':'總','态':'態','惊':'驚','愿':'願','战':'戰','执':'執','扫':'掃',
  '扬':'揚','抚':'撫','抢':'搶','担':'擔','拥':'擁','拦':'攔','拨':'撥','择':'擇',
  '挂':'掛','损':'損','据':'據','摇':'搖','击':'擊','撑':'撐','搬':'搬','操':'操',
  '掌':'掌','挣':'掙','挤':'擠','挥':'揮','捐':'捐','捞':'撈','捡':'撿','换':'換',
  '揽':'攬','搜':'搜','报':'報','点':'點','热':'熱','烦':'煩','烧':'燒','焕':'煥',
  '爷':'爺','牺':'犧','猎':'獵','兽':'獸','现':'現','环':'環','画':'畫','畅':'暢',
  '畏':'畏','痴':'癡','疯':'瘋','矿':'礦','码':'碼','砖':'磚','硬':'硬','确':'確',
  '礼':'禮','祸':'禍','禅':'禪','禀':'稟','种':'種','称':'稱','积':'積','穷':'窮',
  '窃':'竊','窍':'竅','窑':'窯','窥':'窺','窜':'竄','窝':'窩','竖':'竪','竞':'競',
  '笔':'筆','笋':'筍','笼':'籠','简':'簡','管':'管','篮':'籃','篱':'籬','篷':'篷',
  '类':'類','粪':'糞','糖':'糖','系':'系','絮':'絮','红':'紅','纠':'糾','纤':'纖',
  '约':'約','纪':'紀','级':'級','纬':'緯','纯':'純','纱':'紗','纳':'納','纵':'縱',
  '纷':'紛','纸':'紙','纹':'紋','纺':'紡','细':'細','线':'線','练':'練','组':'組',
  '终':'終','绊':'絆','绍':'紹','结':'結','绘':'繪','给':'給','绝':'絕','统':'統',
  '络':'絡','继':'繼','绪':'緒','绫':'綾','续':'續','绮':'綺','缀':'綴','绿':'綠',
  '维':'維','绵':'綿','综':'綜','绽':'綻','绕':'繞','缮':'繕','罗':'羅','罢':'罷',
  '罚':'罰','罪':'罪','聚':'聚','聪':'聰','胆':'膽','肠':'腸','肿':'腫','胀':'脹',
  '胜':'勝','脑':'腦','脚':'腳','脱':'脫','脸':'臉','腾':'騰','舰':'艦','舱':'艙',
  '萧':'蕭','黄':'黃','获':'獲','营':'營','蓝':'藍','盖':'蓋','蒋':'蔣','蔼':'藹',
  '苍':'蒼','苏':'蘇','芦':'蘆','莲':'蓮','葱':'蔥','葵':'葵','蒙':'蒙','蔷':'薔',
  '藏':'藏','补':'補','表':'表','衷':'衷','蛮':'蠻',' 衮':'袞','袅':'裊',
  '蜡':'蠟','蝇':'蠅',' 街':'街','衙':'衙','衡':'衡',
};
function toTrad(c) { return SIMP_TO_TRAD[c] || c; }

// 字符重叠率（适用于所有学科，自动简→繁归一）
const COMMON_CHARS = new Set('之乎者也矣焉哉兮于以而其曰云謂一二三四五六七八九十百千萬的了是在有不為為此若則故且將');

function charOverlap(userText, sentence) {
  const userChars = new Set();
  for (const c of userText) {
    if (/[\u4e00-\u9fff]/.test(c) && !COMMON_CHARS.has(c)) {
      userChars.add(toTrad(c));
    }
  }
  if (userChars.size === 0) return 0;
  let hit = 0;
  for (const c of userChars) {
    if (sentence.includes(c)) hit++;
  }
  return hit / userChars.size;
}

// 从章节页 HTML 提取中文原文句子
function extractChineseSentences(html) {
  const out = [];
  const tdRe = /<td[^>]*class="ctext"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tdRe.exec(html)) !== null) {
    const cell = m[1];
    const zhRe = /[一-鿿][一-鿿，。？！、；：「」『』\s]*/g;
    let z;
    while ((z = zhRe.exec(cell)) !== null) {
      const seg = z[0].replace(/\s+/g, '').trim();
      seg.split(/(?<=[。？！])/).forEach(sent => {
        const s = sent.trim();
        if (s.length >= 4) out.push(s);
      });
    }
  }
  return [...new Set(out)];
}

/**
 * 古籍原文匹配（多学科通用）
 * @param {string} userText 用户输入的古文片段（简体）
 * @param {string} suspectedBook LLM 判断的疑似书名
 * @param {object} env Worker env
 * @returns {Promise<Array>} matches
 */
export async function searchClassic(userText, suspectedBook = '', env) {
  const minInterval = parseInt(env?.CTEXT_RATE_LIMIT_MS || '400', 10);

  // 根据疑似书名匹配配置；无法确定时遍历所有古籍
  const matchedBooks = CLASSIC_TEXTS.filter(b =>
    b.keywords.some(k => (suspectedBook || '').includes(k) || (userText || '').includes(k))
  );
  const books = matchedBooks.length > 0 ? matchedBooks : CLASSIC_TEXTS;

  const userFp = fingerprints(userText);
  const matches = [];

  for (const book of books) {
    const useFingerprint = book.matchMode === 'fingerprint' && userFp.size > 0;
    // 单页书（chapters 为空）直接抓 /book/zh；多章节书遍历各章
    const chapterList = book.chapters.length > 0
      ? book.chapters.map((ch, i) => ({ slug: ch, name: book.chapterNames[i] || ch }))
      : [{ slug: '', name: '' }];

    for (const ch of chapterList) {
      const url = ch.slug
        ? `https://ctext.org/${book.book}/${ch.slug}/zh`
        : `https://ctext.org/${book.book}/zh`;

      try {
        await rateLimit(minInterval);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'factcheck-editor/1.0 (research)' },
        });
        clearTimeout(t);
        if (!resp.ok) continue;
        const html = await resp.text();
        const sentences = extractChineseSentences(html);
        // 每章最多取 3 条匹配（指纹优先，charOverlap 按分排序）
        const chapterMatches = [];

        for (let si = 0; si < sentences.length; si++) {
          const sent = sentences[si];
          let isMatch = false;
          let confidence = 0;
          let matchType = '';

          if (useFingerprint) {
            // 指纹匹配（数学/天文古籍，精确）
            const fp = fingerprints(sent);
            if (fp.size === 0) continue;
            let hit = 0;
            for (const f of userFp) if (fp.has(f)) hit++;
            if (hit >= Math.ceil(userFp.size * 0.6)) {
              isMatch = true;
              confidence = hit === userFp.size ? 0.98 : 0.85;
              matchType = 'fingerprint';
            }
          }

          if (!isMatch) {
            // 字符重叠匹配（通用，容错繁简）
            const overlap = charOverlap(userText, sent);
            if (overlap >= 0.5) {
              isMatch = true;
              confidence = Math.min(overlap * 1.1, 0.9);
              matchType = 'charOverlap';
            }
          }

          if (isMatch) {
            // 拼接紧邻的问句/答句，给出完整上下文
            let full = sent;
            for (let k = si + 1; k < Math.min(si + 3, sentences.length); k++) {
              const nxt = sentences[k];
              if (/^[問问]/.test(nxt) || /^答曰/.test(nxt) || nxt.length <= 12) {
                full += nxt;
                if (/^答曰/.test(nxt)) break;
              } else break;
            }
            const bookLabel = ch.name ? `${book.label}·${ch.name}` : book.label;
            chapterMatches.push({
              book: bookLabel,
              chapter: ch.name || '',
              urn: `ctp:${book.book}/${ch.slug}`,
              url: ch.slug ? `https://ctext.org/${book.book}/${ch.slug}/zh` : `https://ctext.org/${book.book}/zh`,
              text: full,
              edition: 'ctext',
              confidence,
              matchType,
              note: `${book.discipline}·中国哲学书电子化计划（ctext）繁体原文`,
            });
          }
        }

        // 每章取前 3 条（指纹优先，同类型按分排序）
        chapterMatches.sort((a, b) => {
          if (a.matchType === 'fingerprint' && b.matchType !== 'fingerprint') return -1;
          if (a.matchType !== 'fingerprint' && b.matchType === 'fingerprint') return 1;
          return b.confidence - a.confidence;
        });
        matches.push(...chapterMatches.slice(0, 3));
      } catch { /* 该页失败跳过 */ }
      if (matches.length >= 5) break;
    }
    if (matches.length >= 5) break;
  }
  return matches;
}

// 保留旧函数名兼容
export const searchMathClassic = searchClassic;

// ---------- ctext 全文检索（search.pl，结果不稳定，仅兜底） ----------

export async function searchText(query, env, opts = {}) {
  if (!query) return [];
  const minInterval = parseInt(env?.CTEXT_RATE_LIMIT_MS || '400', 10);
  await rateLimit(minInterval);

  const url = `https://ctext.org/search.pl?if=zh&searchq=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'factcheck-editor/1.0 (research; contact: admin)',
    },
  });
  if (!resp.ok) {
    throw new Error(`CTEXT_SEARCH_${resp.status}`);
  }
  const html = await resp.text();
  return parseSearchHtml(html, opts);
}

function parseSearchHtml(html, opts = {}) {
  const results = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = liRegex.exec(html)) !== null && results.length < 10) {
    const block = match[1];
    const aMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!aMatch) continue;
    const href = aMatch[1];
    const title = aMatch[2].replace(/<[^>]+>/g, '').trim();
    const textMatch = block.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    const text = (textMatch ? textMatch[1] : block).replace(/<[^>]+>/g, '').trim();
    const parts = title.split(/[·•\-—]/);
    results.push({
      book: parts[0]?.trim() || '',
      chapter: parts[1]?.trim() || '',
      urn: `ctp:${href.replace(/^\//, '')}`,
      url: href.startsWith('http') ? href : `https://ctext.org${href}`,
      text,
      edition: 'library',
    });
  }
  return results;
}

// 保留 getText 供需要时使用
export async function getText(urn, env) {
  if (!urn) return null;
  const minInterval = parseInt(env?.CTEXT_RATE_LIMIT_MS || '400', 10);
  await rateLimit(minInterval);
  const url = `https://api.ctext.org/gettext?urn=${encodeURIComponent(urn)}&if=zh`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`CTEXT_HTTP_${resp.status}`);
  return await resp.json();
}
