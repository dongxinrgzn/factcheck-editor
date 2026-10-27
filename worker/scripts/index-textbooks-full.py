#!/usr/bin/env python3
"""
教材 PDF 全库索引 v3 — 按学科拆分存储（支持 572 本全量）

KV 结构:
  tb:subj:{学科} → {prefix: {bi:book_id, p:page}, ...}   （每科一个索引）
  tb:books        → {book_id: {t:title, s:stage, sub:subject, v:version, g:grade}}  （书本元数据）
  tb:dir          → {化学: count, 物理: count, ...}       （学科目录）

Worker: 先查 tb:dir → 按优先级逐科加载 tb:subj:{学科} → 匹配 → tb:books 查元数据
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

import pymupdf

EBOOK_BASE = "http://192.168.0.99:3000"
EBOOK_USER = "17865150109"
EBOOK_PASS = "123456"

CF_ACCOUNT_ID = "671a2f0bf367dfe29abb0db9036e872b"
CF_KV_NAMESPACE = "11b227db38e742db944bf4a7fcea5ffa"
CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".pdf_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# 学科标准化（路径中的各种写法统一）
def normalize_subject(raw):
    s = raw.strip()
    m = {
        "化学": "化学", "数学": "数学", "物理": "物理", "语文": "语文",
        "英语": "英语", "生物": "生物", "历史": "历史", "地理": "地理",
        "道德与法治": "道法", "政治": "道法", "思想品德": "道法",
        "科学": "科学", "信息技术": "信息技术", "音乐": "音乐",
        "美术": "美术", "体育": "体育", "俄语": "俄语", "日语": "日语",
    }
    return m.get(s, s if s else "其他")


def login():
    data = json.dumps({"username": EBOOK_USER, "password": EBOOK_PASS}).encode()
    req = urllib.request.Request(f"{EBOOK_BASE}/api/auth/login", data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read())["data"]["token"]


def get_book_list(token):
    req = urllib.request.Request(f"{EBOOK_BASE}/api/ebook-library/books", headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req, timeout=30)
    return [it for it in json.loads(resp.read())["data"]["items"] if it.get("name", "").lower().endswith(".pdf")]


def download_pdf(token, relpath, cache_key):
    cache_file = os.path.join(CACHE_DIR, cache_key)
    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 1000:
        return cache_file
    encoded = urllib.parse.quote(relpath)
    req = urllib.request.Request(f"{EBOOK_BASE}/api/ebook-library/file/{encoded}", headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req, timeout=300)
    with open(cache_file, "wb") as f:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
    return cache_file


HEADER_RE = re.compile(r"^(第[一二三四五六七八九十百千\d]+[单元章节课]|实验[\d\-—]|课题\s*\d|本单元小结|归纳与整理|单元小结|拓展性课题|资料卡片|化学·技术·社会|调查与研究|家庭小实验|想一想|做一做|练一练|活动与探究|实验探究|讨论|思考与交流|课后练习|习题|复习题|自我检测)")

def extract_sentences(pdf_path):
    doc = pymupdf.open(pdf_path)
    sentences = []
    for pg in range(len(doc)):
        text = doc[pg].get_text()
        lines = text.split('\n')
        content_lines = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if HEADER_RE.match(stripped):
                continue
            if re.match(r"^[\d\s\-—]+$", stripped):
                continue
            content_lines.append(stripped)
        content = re.sub(r"\s+", "", ''.join(content_lines))
        raw = re.split(r"[。；！？!?]+", content)
        for s in raw:
            s = s.strip()
            if len(s) < 12 or len(s) > 300:
                continue
            if re.match(r"^[\d.\-\u2013\u2014~\uFF5E%\u2103()\[\]]+$", s):
                continue
            sentences.append({"page": pg + 1, "text": s})
    doc.close()
    return sentences


def norm_sentence(s):
    return re.sub(r"[，。；、：\u201c\u201d\u2018\u2019（）\[\]【】\s.\-,;:!?\uff01\uff1f\"'']", "", s)


def kv_put(key, value):
    encoded_key = urllib.parse.quote(key)  # 中文学科名必须 URL 编码
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NAMESPACE}/values/{encoded_key}"
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    size_kb = len(data) / 1024
    if size_kb > 24000:
        print(f"  [WARN] {key} too large: {size_kb:.0f}KB")
        return False
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        ok = resp.status == 200
        print(f"  [KV] {key} → {size_kb:.0f}KB → {'OK' if ok else 'FAIL'}")
        return ok
    except Exception as e:
        print(f"  [KV] {key} → FAIL: {e}")
        return False


def parse_book_info(relpath):
    parts = relpath.split("/")
    labels = ["stage", "subject", "version", "grade"]
    info = {k: "" for k in labels}
    for i, p in enumerate(parts[:-1]):
        if i < len(labels):
            info[labels[i]] = p
    info["title"] = os.path.splitext(parts[-1])[0] if parts else ""
    info["subject"] = normalize_subject(info.get("subject", ""))
    return info


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Max books (0=all)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.dry_run and not CF_API_TOKEN:
        print("[FAIL] Need CLOUDFLARE_API_TOKEN")
        sys.exit(1)

    token = login()
    pdfs = get_book_list(token)
    print(f"[OK] Total: {len(pdfs)} PDFs")
    if args.limit > 0:
        pdfs = pdfs[:args.limit]
        print(f"  Limited to {args.limit}")

    # 按学科分组的索引
    subject_indexes = {}  # {subject: {prefix: {bi, p}}}
    book_meta = {}        # {book_id: {t, s, sub, v, g}}
    total_sents = 0
    errors = 0
    t0 = time.time()

    for i, pdf_info in enumerate(pdfs):
        relpath = pdf_info["relpath"]
        name = pdf_info["name"]
        info = parse_book_info(relpath)
        subject = info["subject"]
        book_id = hashlib.md5(norm_sentence(name).encode()).hexdigest()[:12]

        if (i + 1) % 10 == 0 or i == 0:
            elapsed = time.time() - t0
            print(f"\n[{i+1}/{len(pdfs)}] ({elapsed:.0f}s) {name[:40]}")

        try:
            pdf_path = download_pdf(token, relpath, f"{book_id}.pdf")
            sents = extract_sentences(pdf_path)
            total_sents += len(sents)

            if not args.dry_run:
                book_meta[book_id] = {
                    "t": info["title"], "s": info["stage"],
                    "sub": subject, "v": info["version"], "g": info["grade"],
                }

                if subject not in subject_indexes:
                    subject_indexes[subject] = {}

                idx = subject_indexes[subject]
                for s in sents:
                    ns = norm_sentence(s["text"])
                    if len(ns) < 10:
                        continue
                    entry = {"bi": book_id, "p": s["page"]}
                    head_key = ns[:30]
                    if head_key not in idx:
                        idx[head_key] = entry
                    if len(ns) > 30:
                        tail_key = ns[-30:]
                        if tail_key not in idx:
                            idx[tail_key] = entry

        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  [ERR] {name}: {e}")
            continue

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"Processed: {len(pdfs)} books ({errors} errors) in {elapsed:.0f}s")
    print(f"Total sentences: {total_sents}")
    print(f"\nSubject breakdown:")
    for subj, idx in sorted(subject_indexes.items(), key=lambda x: -len(x[1])):
        size_kb = len(json.dumps(idx, ensure_ascii=False).encode()) / 1024
        book_count = len(set(v["bi"] for v in idx.values()))
        status = "OK" if size_kb < 24000 else "TOO LARGE!"
        print(f"  {subj:>8}: {book_count:3d} books, {len(idx):6d} entries, {size_kb:7.0f}KB [{status}]")

    if not args.dry_run:
        print(f"\nUploading to KV...")
        total_ok = 0
        for subj, idx in subject_indexes.items():
            # 按 3MB 拆块（大值读取可能超时，小块更可靠）
            items = list(idx.items())
            chunk_size = 15000  # 每块 ~15000 条（约 2-3MB）
            chunks = [items[i:i+chunk_size] for i in range(0, len(items), chunk_size)]
            all_ok = True
            for ci, chunk in enumerate(chunks):
                chunk_dict = dict(chunk)
                ok = kv_put(f"tb:subj:{subj}:{ci}", chunk_dict)
                if not ok:
                    all_ok = False
            # 存块数元数据
            dir_data_subj = {"chunks": len(chunks), "entries": len(items)}
            kv_put(f"tb:subj:{subj}:_meta", dir_data_subj)
            if all_ok:
                total_ok += 1
                print(f"  {subj}: {len(chunks)} chunks, {len(items)} entries → OK")
            else:
                print(f"  {subj}: FAILED")
        # 删除旧的大块（如果存在）
        for subj in subject_indexes:
            try:
                old_key = f"tb:subj:{subj}"
                old_encoded = urllib.parse.quote(old_key)
                url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NAMESPACE}/values/{old_encoded}"
                req = urllib.request.Request(url, method="DELETE", headers={"Authorization": f"Bearer {CF_API_TOKEN}"})
                urllib.request.urlopen(req, timeout=10)
            except:
                pass
        ok_books = kv_put("tb:books", book_meta)
        dir_data = {subj: subject_indexes[subj].__len__() for subj in subject_indexes}
        dir_data["_chunked"] = True
        ok_dir = kv_put("tb:dir", dir_data)
        print(f"\nUploaded: {total_ok}/{len(subject_indexes)} subjects, books={'OK' if ok_books else 'FAIL'}, dir={'OK' if ok_dir else 'FAIL'}")


if __name__ == "__main__":
    main()
