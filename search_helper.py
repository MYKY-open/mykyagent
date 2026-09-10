#!/usr/bin/env python3
# /// script
# dependencies = [
#     "ddgs>=7.0.0",
#     "beautifulsoup4>=4.12.0",
#     "requests>=2.31.0",
# ]
# ///
import sys
import json
import re
import requests
from bs4 import BeautifulSoup
from ddgs import DDGS
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

def search(query):
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=8))
            return [{"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")} for r in raw]
    except Exception as e:
        return [{"error": str(e)}]

def extract_relevant_chunks(text, query, max_total_chars=1800):
    if not query or not text:
        return text[:max_total_chars]
    query_terms = set(re.findall(r"\w+", query.lower()))
    stop_words = {"the", "a", "an", "and", "or", "to", "in", "of", "for", "on", "with", "at", "by", "from", "is", "it", "this", "that", "how", "what", "where", "can", "you", "my"}
    keywords = {t for t in query_terms if t not in stop_words and len(t) > 1}
    if not keywords:
        keywords = query_terms

    blocks = re.split(r"\n{2,}", text)
    scored_blocks = []

    for block in blocks:
        block_clean = block.strip()
        if not block_clean:
            continue
        # Skip UI noise / nav boilerplate
        if any(skip in block_clean for skip in ["Sign in", "Sign up", "Clone via HTTPS", "Dismiss alert", "Skip to content", "You signed in with another"]):
            continue
        is_code = block_clean.startswith("```") or "```" in block_clean
        is_table = "|" in block_clean and ("http" in block_clean or "-" in block_clean)
        block_lower = block_clean.lower()
        
        hits = sum(1 for kw in keywords if kw in block_lower)
        if hits > 0 or is_code or is_table:
            # Massive priority for code blocks and data tables containing links
            score = hits * 2 + (10 if (is_code or is_table) else 0)
            scored_blocks.append((score, block_clean))

    scored_blocks.sort(key=lambda x: x[0], reverse=True)

    result = []
    total_len = 0
    for _, blk in scored_blocks:
        if total_len + len(blk) > max_total_chars:
            remaining = max_total_chars - total_len
            if remaining > 150:
                result.append(blk[:remaining] + "\n...")
            break
        result.append(blk)
        total_len += len(blk)

    return "\n\n".join(result) if result else text[:max_total_chars]

def fetch(url, query=None):
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=20)
        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Extract direct download/file links first, prioritizing binary/archive links
        important_links = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if any(k in href.lower() for k in [".jar", "piston-data", ".tar", ".zip", ".gz", ".sh", "releases/download", "/download"]):
                important_links.append(f"- [{text}]({href})")
        important_links = list(dict.fromkeys(important_links))[:15]

        # Decompose non-content tags
        for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "svg"]):
            tag.decompose()

        # Format markdown tables
        for table in soup.find_all("table"):
            rows = []
            for tr in table.find_all("tr"):
                cells = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
                if cells:
                    rows.append("| " + " | ".join(cells) + " |")
            if rows:
                first_tr = table.find("tr")
                col_count = len(first_tr.find_all(["th", "td"])) if first_tr else 1
                sep = "| " + " | ".join(["---"] * col_count) + " |"
                table_md = "\n\n" + rows[0] + "\n" + sep + "\n" + "\n".join(rows[1:]) + "\n\n"
                table.replace_with(table_md)

        # Format code blocks so markdown retains code structure
        for pre in soup.find_all("pre"):
            code_text = pre.get_text()
            pre.replace_with(f"\n\n```\n{code_text}\n```\n\n")

        # Format headings
        for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
            htext = h.get_text(strip=True)
            if htext:
                level = int(h.name[1])
                h.replace_with(f"\n\n{'#' * level} {htext}\n\n")

        # Format list items
        for li in soup.find_all("li"):
            litext = li.get_text(strip=True)
            if litext:
                li.replace_with(f"\n- {litext}")

        # Format links
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if text and ("http" in href or href.endswith(".jar") or "download" in href):
                a.replace_with(f"[{text}]({href}) ")

        text = "\n".join([s for s in soup.stripped_strings if s])
        if query:
            text = extract_relevant_chunks(text, query, max_total_chars=3500)
        else:
            if len(text) > 8000:
                text = text[:8000] + "\n\n... [Content truncated at 8,000 characters]"

        if important_links:
            text = "Direct Download Links:\n" + "\n".join(important_links) + "\n\nContent:\n" + text

        return {"url": url, "text": text}
    except Exception as e:
        return {"url": url, "error": str(e)}

def research(query):
    # 1. First hop: search
    results = search(query)
    if not results or not isinstance(results, list) or (len(results) > 0 and "error" in results[0]):
        return {"query": query, "search_results": results, "pages": [], "direct_links": []}

    # 2. Select top candidate URLs (up to 2 unique domains to keep context small)
    candidate_urls = []
    seen_domains = set()
    for r in results:
        u = r.get("url", "")
        if not u or not u.startswith("http"):
            continue
        domain = urlparse(u).netloc.lower()
        if domain not in seen_domains:
            seen_domains.add(domain)
            candidate_urls.append(u)
        if len(candidate_urls) >= 2:
            break

    # 3. Parallel fetch of candidate pages
    pages = []
    all_direct_links = []
    with ThreadPoolExecutor(max_workers=min(len(candidate_urls) or 1, 3)) as executor:
        future_to_url = {executor.submit(fetch, u): u for u in candidate_urls}
        for future in as_completed(future_to_url):
            try:
                res = future.result()
                if res and "text" in res and not res.get("error"):
                    raw_text = res["text"]
                    if "Direct Download Links:\n" in raw_text:
                        parts = raw_text.split("Direct Download Links:\n", 1)[1].split("\n\nContent:\n", 1)
                        for line in parts[0].splitlines():
                            clean = line.strip()
                            if clean.startswith("- [") and clean not in all_direct_links:
                                all_direct_links.append(clean)
                    
                    # Extract only query-relevant chunks (max 1500 chars per page)
                    page_summary = extract_relevant_chunks(raw_text, query, max_total_chars=1500)
                    pages.append({
                        "url": res["url"],
                        "content": page_summary
                    })
            except Exception:
                pass

    # 4. If download query and no direct links found yet, execute targeted follow-up
    download_keywords = ["download", ".jar", ".zip", ".tar", ".gz", "release", "installer", "server"]
    is_download_query = any(k in query.lower() for k in download_keywords)
    if is_download_query and not all_direct_links:
        targeted_q = f"{query} direct download link github"
        targeted_results = search(targeted_q)
        if isinstance(targeted_results, list):
            for tr in targeted_results[:1]:
                tu = tr.get("url", "")
                if tu and tu not in [p["url"] for p in pages]:
                    tr_fetch = fetch(tu)
                    if tr_fetch and "text" in tr_fetch and not tr_fetch.get("error"):
                        raw_text = tr_fetch["text"]
                        if "Direct Download Links:\n" in raw_text:
                            parts = raw_text.split("Direct Download Links:\n", 1)[1].split("\n\nContent:\n", 1)
                            for line in parts[0].splitlines():
                                clean = line.strip()
                                if clean.startswith("- [") and clean not in all_direct_links:
                                    all_direct_links.append(clean)
                        pages.append({"url": tu, "content": extract_relevant_chunks(raw_text, query, max_total_chars=1500)})
                        if len(all_direct_links) >= 5:
                            break

    return {
        "query": query,
        "direct_links": all_direct_links[:15],
        "pages": pages,
        "search_snippets": results[:4]
    }

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: search_helper.py <search|fetch|research> <arg> [query]"}))
        return
    mode = sys.argv[1]
    arg = sys.argv[2]
    if mode == "search":
        print(json.dumps(search(arg)))
    elif mode == "fetch":
        q = sys.argv[3] if len(sys.argv) > 3 else None
        print(json.dumps(fetch(arg, q)))
    elif mode == "research":
        print(json.dumps(research(arg)))
    else:
        print(json.dumps({"error": f"Unknown mode: {mode}"}))

if __name__ == "__main__":
    main()
