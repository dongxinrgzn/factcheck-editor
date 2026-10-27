#!/usr/bin/env python3
"""
教材 PDF 文本提取 + KV 索引（逐句直查版）
用法: python index-textbooks.py [--subject 化学] [--limit 20] [--dry-run]

KV 结构:
  tbs:{sentence_hash}  → {b: book_title, s: stage, sub: subject, v: version, g: grade, p: page, t: text}
  tb:index             → {book_id: {title, stage, subject, version, grade, count}}

Worker 查询: 归一化用户句子 → md5 前 16 位 → KV get("tbs:" + hash) → 命中即教材原句
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
    print(f"[OK] Login, Token: {token[:20]}...")
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
    req = urllib.request.Request(
        f"{EBOOK_BASE}/api/ebook-library/file/{encoded}",
        headers={"Authorization": f"Bearer {token}"},
    )
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
    for pg in range(len(doc)):
        text = doc[pg].get_text()
        raw = re.split(r"[。；！？!?\n]+", text)
        for s in raw:
            s = re.sub(r"\s+", "", s).strip()
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
    return re.sub(r"[，。；、：\u201c\u201d\u2018\u2019（）\[\]【】\s.\-,;:!?\uff01\uff1f\"'']", "", s)


def sent_key(normed):
    """KV key = 归一化句子前 30 字符（与 Worker 的 textbookKey 完全一致，无哈希碰撞）"""
    return "tbs:" + normed[:30]


def kv_put(key, value):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/storage/kv/namespaces/{CF_KV_NAMESPACE}/values/{key}"
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return resp.status == 200
    except Exception:
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
    parser = argparse.ArgumentParser(description="Textbook PDF indexer")
    parser.add_argument("--subject", default="", help="Filter by subject")
    parser.add_argument("--limit", type=int, default=0, help="Max books")
    parser.add_argument("--dry-run", action="store_true", help="No upload")
    args = parser.parse_args()

    if not args.dry_run and not CF_API_TOKEN:
        print("[FAIL] Need CLOUDFLARE_API_TOKEN")
        sys.exit(1)

    token = login()
    pdfs = get_book_list(token)
    if args.subject:
        pdfs = [p for p in pdfs if args.subject in p.get("relpath", "")]
        print(f"  Filter '{args.subject}': {len(pdfs)} books")
    if args.limit > 0:
        pdfs = pdfs[:args.limit]

    total_sents = 0
    total_uploaded = 0
    book_index = {}
    all_keys = set()

    for i, pdf_info in enumerate(pdfs):
        relpath = pdf_info["relpath"]
        name = pdf_info["name"]
        info = parse_book_info(relpath)
        book_id = hashlib.md5(norm_sentence(name).encode()).hexdigest()[:16]

        print(f"\n[{i+1}/{len(pdfs)}] {name}")

        try:
            pdf_path = download_pdf(token, relpath, f"{book_id}.pdf")
            size_mb = os.path.getsize(pdf_path) / 1024 / 1024
            sents = extract_sentences(pdf_path)
            print(f"  {size_mb:.1f}MB, {len(sents)} sentences")
            total_sents += len(sents)

            if not args.dry_run:
                book_index[book_id] = {
                    "title": info["title"],
                    "stage": info["stage"],
                    "subject": info["subject"],
                    "version": info["version"],
                    "grade": info["grade"],
                    "count": len(sents),
                }

                uploaded = 0
                for s in sents:
                    ns = norm_sentence(s["text"])
                    if len(ns) < 8:
                        continue
                    key = sent_key(ns)
                    if key in all_keys:
                        continue
                    all_keys.add(key)

                    ok = kv_put(key, {
                        "b": info["title"], "s": info["stage"], "sub": info["subject"],
                        "v": info["version"], "g": info["grade"], "p": s["page"], "t": s["text"],
                    })
                    if ok:
                        uploaded += 1
                    if uploaded % 500 == 0 and uploaded > 0:
                        print(f"    {uploaded} uploaded...")
                        time.sleep(0.1)

                total_uploaded += uploaded
                print(f"  uploaded: {uploaded}")

        except Exception as e:
            print(f"  [ERROR] {e}")

    if not args.dry_run and book_index:
        kv_put("tb:index", book_index)
        print(f"\n[OK] Book index uploaded ({len(book_index)} books)")

    print(f"\n{'='*50}")
    print(f"Books: {len(pdfs)}, Sentences: {total_sents}, Uploaded: {total_uploaded}")


if __name__ == "__main__":
    main()
