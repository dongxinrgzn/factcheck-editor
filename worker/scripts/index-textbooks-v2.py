#!/usr/bin/env python3
"""
教材 PDF 索引 v2 — 整本教材存一个 KV value（绕过免费版 1000 写/天限额）

KV 结构:
  tb:master → {prefix_30chars: {b:书名, p:页码, t:原文}, ...}  （全部句子一个 key）
  tb:meta   → {book_count, sentence_count, last_updated, books: [{title, stage, subject, version, grade, count}]}

Worker 查询: 一次 KV get("tb:master") → 内存中按 prefix 匹配用户句子
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


def login():
    data = json.dumps({"username": EBOOK_USER, "password": EBOOK_PASS}).encode()
    req = urllib.request.Request(f"{EBOOK_BASE}/api/auth/login", data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=10)
    token = json.loads(resp.read())["data"]["token"]
    print(f"[OK] Login")
    return token


def get_book_list(token):
    req = urllib.request.Request(f"{EBOOK_BASE}/api/ebook-library/books", headers={"Authorization": f"Bearer {token}"})
    resp = urllib.request.urlopen(req, timeout=15)
    items = json.loads(resp.read())["data"]["items"]
    pdfs = [it for it in items if it.get("name", "").lower().endswith(".pdf")]
    print(f"[OK] Total PDFs: {len(pdfs)}")
    return pdfs


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


def extract_sentences(pdf_path):
    doc = pymupdf.open(pdf_path)
    sentences = []
    # 章节标题行模式："第X单元"、"第X章"、"第X节"、"实验X-X"等
    header_re = re.compile(r"^(第[一二三四五六七八九十百千\d]+[单元章节课]|实验[\d\-—]|课题\s*\d|本单元小结|归纳与整理|单元小结|拓展性课题|资料卡片|化学·技术·社会|调查与研究|家庭小实验)")
    for pg in range(len(doc)):
        text = doc[pg].get_text()
        # 1. 先按行切分，过滤掉章节标题行（保持正文行的完整性）
        lines = text.split('\n')
        content_lines = []
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            # 跳过标题行（"第二单元 空气和氧气"、"实验2-1"等）
            if header_re.match(stripped):
                continue
            # 跳过纯数字/页码行
            if re.match(r"^[\d\s\-—]+$", stripped):
                continue
            content_lines.append(stripped)
        # 2. 合并正文行（去空白），按标点切分
        content = re.sub(r"\s+", "", ''.join(content_lines))
        raw = re.split(r"[。；！？!?]+", content)
        for s in raw:
            s = s.strip()
            if len(s) < 12 or len(s) > 300:
                continue
            if re.match(r"^[\d.\-\u2013\u2014~\uFF5E%\u2103()\[\]]+$", s):
                continue
            if any(kw in s for kw in ["版权所有", "出版发行", "责任编辑", "开本", "印张", "版次"]):
                continue
            sentences.append({"page": pg + 1, "text": s})
    doc.close()
    return sentences


def norm_sentence(s):
    """与 Worker 的 normForTextbook 完全一致"""
    return re.sub(r"[，。；、：\u201c\u201d\u2018\u2019（）\[\]【】\s.\-,;:!?\uff01\uff1f\"'']", "", s)


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NAMESPACE}/values/{key}"
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    size_kb = len(data) / 1024
    if size_kb > 25000:
        print(f"  [WARN] Value too large: {size_kb:.0f}KB (limit 25MB)")
        return False
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        ok = resp.status == 200
        print(f"  [KV PUT] {key} → {size_kb:.0f}KB → {'OK' if ok else 'FAIL'}")
        return ok
    except Exception as e:
        print(f"  [KV PUT] {key} → FAIL: {e}")
        return False


def parse_book_info(relpath):
    parts = relpath.split("/")
    labels = ["stage", "subject", "version", "grade"]
    info = {k: "" for k in labels}
    for i, p in enumerate(parts[:-1]):
        if i < len(labels):
            info[labels[i]] = p
    info["title"] = os.path.splitext(parts[-1])[0] if parts else ""
    return info


def main():
    parser = argparse.ArgumentParser(description="Textbook indexer v2 (batch KV)")
    parser.add_argument("--subject", default="", help="Filter by subject")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.dry_run and not CF_API_TOKEN:
        print("[FAIL] Need CLOUDFLARE_API_TOKEN")
        sys.exit(1)

    token = login()
    pdfs = get_book_list(token)
    if args.subject:
        pdfs = [p for p in pdfs if args.subject in p.get("relpath", "")]
        print(f"  Filter '{args.subject}': {len(pdfs)}")
    if args.limit > 0:
        pdfs = pdfs[:args.limit]

    master = {}  # {prefix: {b, p, t}}
    book_meta = []
    total_sents = 0

    for i, pdf_info in enumerate(pdfs):
        relpath = pdf_info["relpath"]
        name = pdf_info["name"]
        info = parse_book_info(relpath)
        book_id = hashlib.md5(norm_sentence(name).encode()).hexdigest()[:16]

        print(f"\n[{i+1}/{len(pdfs)}] {name}")

        try:
            pdf_path = download_pdf(token, relpath, f"{book_id}.pdf")
            sents = extract_sentences(pdf_path)
            print(f"  {len(sents)} sentences")
            total_sents += len(sents)

            book_start = len(master)
            for s in sents:
                ns = norm_sentence(s["text"])
                if len(ns) < 10:
                    continue
                entry = {
                    "b": info["title"],
                    "p": s["page"],
                    "t": s["text"],
                }
                # 双端索引：首 30 字（用户从头引用）+ 尾 30 字（头部混入章节标题时仍可命中）
                # PDF 页首常有"第二单元 空气和氧气"等标题混入正文，导致首缀偏移
                head_key = ns[:30]
                if head_key not in master:
                    master[head_key] = entry
                tail_key = ns[-30:] if len(ns) > 30 else ns
                if tail_key not in master:
                    master[tail_key] = entry

            book_count = len(master) - book_start
            book_meta.append({
                "title": info["title"],
                "stage": info["stage"],
                "subject": info["subject"],
                "version": info["version"],
                "grade": info["grade"],
                "count": book_count,
            })
            print(f"  indexed: {book_count} unique prefixes")

        except Exception as e:
            print(f"  [ERROR] {e}")

    print(f"\n{'='*50}")
    print(f"Books: {len(book_meta)}, Total sentences: {total_sents}")
    print(f"Unique prefixes in master: {len(master)}")
    master_size = len(json.dumps(master, ensure_ascii=False).encode()) / 1024
    print(f"Master index size: {master_size:.0f}KB")

    if not args.dry_run:
        # 上传 master 索引（一个 key 存全部句子映射）
        ok1 = kv_put("tb:master", master)
        # 上传元数据
        ok2 = kv_put("tb:meta", {
            "book_count": len(book_meta),
            "sentence_count": total_sents,
            "prefix_count": len(master),
            "last_updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "books": book_meta,
        })
        print(f"\nUpload: master={'OK' if ok1 else 'FAIL'}, meta={'OK' if ok2 else 'FAIL'}")


if __name__ == "__main__":
    main()
