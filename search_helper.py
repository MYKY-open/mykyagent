#!/usr/bin/env python3
# /// script
# dependencies = [
#     "ddgs>=7.0.0",
#     "beautifulsoup4>=4.12.0",
#     "requests>=2.31.0",
#     "playwright>=1.47.0",
# ]
# ///
import sys
import json
import re
import requests
from pathlib import Path
from bs4 import BeautifulSoup
from ddgs import DDGS
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

# Shared session for TCP connection reuse across fetch() calls
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})


# ---------------------------------------------------------------------------
# Playwright browser management
# ---------------------------------------------------------------------------

def _ensure_browsers():
    """
    Ensure Playwright Chromium binary is installed.
    Auto-installs silently on first use — no manual steps needed.
    Binary cached in ~/.cache/ms-playwright/ and reused across all uv venv invocations.
    """
    cache_base = Path.home() / ".cache" / "ms-playwright"
    has_chromium = False
    if cache_base.exists():
        for pattern in [
            "chromium-*/chrome-linux*/chrome",
            "chromium-*/chrome",
            "chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell",
        ]:
            if any(cache_base.glob(pattern)):
                has_chromium = True
                break

    if not has_chromium:
        import subprocess
        print("[search_helper] First use: installing Playwright Chromium browser...", file=sys.stderr)
        result = subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180
        )
        if result.returncode != 0:
            print(f"[search_helper] Warning: playwright install failed: {result.stderr.decode()[:300]}", file=sys.stderr)


# ---------------------------------------------------------------------------
# HTML -> clean markdown extraction (shared by requests and browser paths)
# ---------------------------------------------------------------------------

def _extract_from_soup(soup, url, query=None):
    """Convert a BeautifulSoup tree to clean markdown text."""

    # Extract direct download/file links before stripping the tree
    important_links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)
        if any(k in href.lower() for k in [".jar", "piston-data", ".tar", ".zip", ".gz", ".sh", "releases/download", "/download"]):
            important_links.append(f"- [{text}]({href})")
    important_links = list(dict.fromkeys(important_links))[:15]

    # Format code blocks FIRST so they survive stripping
    for pre in soup.find_all("pre"):
        code_text = pre.get_text()
        pre.replace_with(f"\n\n```\n{code_text}\n```\n\n")

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

    # Strip non-content layout tags (incl. iframe/video/canvas)
    for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "svg", "iframe", "video", "canvas"]):
        tag.decompose()

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

    return text


def _is_js_gated(text):
    """True if fetched content looks like an empty SPA shell or Cloudflare challenge."""
    return len(text.strip()) < 200


# ---------------------------------------------------------------------------
# Chunk relevance scoring
# ---------------------------------------------------------------------------

def split_blocks(text):
    """Split text into paragraphs, preserving fenced code blocks intact."""
    pattern = r"(```[\s\S]*?```)"
    parts = re.split(pattern, text)
    blocks = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if part.startswith("```") and part.endswith("```"):
            blocks.append(part)
        else:
            sub = [s.strip() for s in re.split(r"\n{2,}", part) if s.strip()]
            blocks.extend(sub)
    return blocks


def extract_relevant_chunks(text, query, max_total_chars=1800):
    if not query or not text:
        return text[:max_total_chars]
    query_terms = set(re.findall(r"\w+", query.lower()))
    stop_words = {"the", "a", "an", "and", "or", "to", "in", "of", "for", "on", "with", "at", "by", "from", "is", "it", "this", "that", "how", "what", "where", "can", "you", "my"}
    keywords = {t for t in query_terms if t not in stop_words and len(t) > 1}
    if not keywords:
        keywords = query_terms

    blocks = split_blocks(text)
    scored = []

    for idx, blk in enumerate(blocks):
        blk_clean = blk.strip()
        if not blk_clean:
            continue
        is_code = blk_clean.startswith("```") and blk_clean.endswith("```")
        is_table = "|" in blk_clean and ("http" in blk_clean or "-" in blk_clean)
        is_heading = bool(re.match(r"^#{1,6} .+$", blk_clean)) and "\n" not in blk_clean

        if not is_code and any(skip in blk_clean for skip in [
            "You signed in with another tab or window",
            "Reload to refresh your session",
            "You signed out in another tab or window",
            "Clone via HTTPS",
            "Dismiss alert",
            "Skip to content",
        ]):
            continue

        blk_lower = blk_clean.lower()
        hits = sum(1 for kw in keywords if kw in blk_lower)
        if hits > 0 or is_code or is_table or is_heading:
            score = hits * 3 + (15 if is_code else (8 if is_table else (4 if is_heading else 0)))
            scored.append({"index": idx, "score": score, "block": blk_clean})

    scored.sort(key=lambda x: x["score"], reverse=True)

    selected = []
    total_len = 0
    for item in scored:
        b_len = len(item["block"])
        if total_len + b_len > max_total_chars:
            if not selected and max_total_chars > 200:
                item["block"] = item["block"][:max_total_chars] + "\n..."
                selected.append(item)
            break
        selected.append(item)
        total_len += b_len

    selected.sort(key=lambda x: x["index"])
    return "\n\n".join(x["block"] for x in selected) if selected else text[:max_total_chars]


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search(query):
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=8))
            return [{"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")} for r in raw]
    except Exception as e:
        return [{"error": str(e)}]


# ---------------------------------------------------------------------------
# Fetch: requests fast path + Playwright fallback
# ---------------------------------------------------------------------------

def fetch(url, query=None, _browser=None):
    """
    Fetch a URL and extract clean text/markdown.

    Fast path  : requests + BeautifulSoup (no browser, milliseconds).
    Fallback   : Playwright Chromium when content looks JS-gated (< 200 chars).

    _browser   : optional live playwright Browser object.
                 Pass from research() to reuse one browser across multiple
                 JS-gated pages (single cold-start cost).
    """
    try:
        resp = SESSION.get(url, timeout=20)
        soup = BeautifulSoup(resp.text, "html.parser")
        text = _extract_from_soup(soup, url, query)

        if _is_js_gated(text):
            return _fetch_browser(url, query, browser=_browser)

        return {"url": url, "text": text}
    except Exception as e:
        return {"url": url, "error": str(e)}


def _fetch_browser(url, query=None, browser=None):
    """
    Fetch a URL using headless Playwright Chromium.

    browser : if provided, reuse it (caller manages lifecycle).
              if None, launch and close our own instance.
    """
    from playwright.sync_api import sync_playwright

    _ensure_browsers()

    own_instance = browser is None
    pw = None
    _b = browser

    try:
        if own_instance:
            pw = sync_playwright().start()
            _b = pw.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )

        page = _b.new_page()
        page.set_extra_http_headers({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/127.0.0.0 Safari/537.36"
            )
        })

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(1500)  # Initial JS hydration
            _interact(page)              # Scroll, dismiss banners, expand sections
        except Exception:
            pass  # Timeout fine -- grab whatever rendered

        html = page.content()
        page.close()

        soup = BeautifulSoup(html, "html.parser")
        text = _extract_from_soup(soup, url, query)
        return {"url": url, "text": text, "browser": True}

    except Exception as e:
        return {"url": url, "error": f"[browser] {e}"}
    finally:
        if own_instance:
            try:
                if _b:
                    _b.close()
            except Exception:
                pass
            try:
                if pw:
                    pw.stop()
            except Exception:
                pass


def _interact(page):
    """
    Standard multi-step interaction sequence after initial page load.

    1. Dismiss cookie/consent banners — unblocks content on many sites.
    2. Progressive scroll — triggers lazy-loaded sections and deferred JS bundles.
    3. Click "Show more" / "Load more" / "Expand" buttons — exposes hidden rows
       on benchmark tables, comparison grids, and paginated content.
    4. Brief settle wait after each interaction.

    All steps are best-effort; failures are silently ignored.
    """
    # -- 1. Cookie / consent banners ------------------------------------------
    # Try common accept-button patterns; stop after first successful click.
    cookie_texts = ["Accept all", "Accept All", "Accept cookies", "Accept Cookies",
                    "Accept", "I agree", "I Accept", "Agree", "OK", "Got it",
                    "Allow all", "Continue", "Consent"]
    cookie_selectors = [
        f"button:has-text('{t}')" for t in cookie_texts
    ] + [
        "[id*='cookie'] button", "[class*='cookie'] button",
        "[id*='consent'] button", "[class*='consent'] button",
        "[aria-label*='cookie']", "[aria-label*='consent']",
        "#onetrust-accept-btn-handler", ".cc-accept", "[data-accept]",
    ]
    for sel in cookie_selectors:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=300):
                btn.click(timeout=500)
                page.wait_for_timeout(400)
                break
        except Exception:
            pass

    # -- 2. Progressive scroll ------------------------------------------------
    # Scroll in 4 steps so lazy loaders fire at each viewport boundary.
    try:
        scroll_height = page.evaluate("document.body.scrollHeight")
        steps = 4
        for i in range(1, steps + 1):
            page.evaluate(f"window.scrollTo(0, {scroll_height * i // steps})")
            page.wait_for_timeout(500)
        # Return to top so extraction sees a consistent DOM order
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(300)
    except Exception:
        pass

    # -- 3. Expand / load-more buttons ----------------------------------------
    expand_texts = ["Show more", "Load more", "View all", "See all",
                    "Show all", "Expand", "More results", "Next"]
    expand_selectors = [f"button:has-text('{t}')" for t in expand_texts] + [
        "a:has-text('Show more')", "a:has-text('Load more')",
        "[class*='load-more']", "[class*='show-more']",
        "[data-testid*='load-more']", "[data-testid*='show-more']",
    ]
    for sel in expand_selectors:
        try:
            # Click up to 3 times (paginated tables may need multiple clicks)
            for _ in range(3):
                btn = page.locator(sel).first
                if btn.is_visible(timeout=300):
                    btn.click(timeout=500)
                    page.wait_for_timeout(700)
                else:
                    break
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Research: parallel requests + sequential browser fallback
# ---------------------------------------------------------------------------

def research(query):
    # 1. DDGS search
    results = search(query)
    if not results or not isinstance(results, list) or (len(results) > 0 and "error" in results[0]):
        return {"query": query, "search_results": results, "pages": [], "direct_links": []}

    # 2. Select up to 4 unique domains
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
        if len(candidate_urls) >= 4:
            break

    # 3. Phase 1 -- parallel requests fetch (fast path, all URLs simultaneously)
    requests_results = {}
    js_gated_urls = []

    def _requests_only(u):
        try:
            resp = SESSION.get(u, timeout=20)
            soup = BeautifulSoup(resp.text, "html.parser")
            text = _extract_from_soup(soup, u, query)
            return u, {"url": u, "text": text}
        except Exception as e:
            return u, {"url": u, "error": str(e)}

    with ThreadPoolExecutor(max_workers=4) as executor:
        future_to_url = {executor.submit(_requests_only, u): u for u in candidate_urls}
        for future in as_completed(future_to_url):
            u, res = future.result()
            if res.get("error") or _is_js_gated(res.get("text", "")):
                js_gated_urls.append(u)
            else:
                requests_results[u] = res

    # 4. Phase 2 -- browser fetch for JS-gated pages.
    #    One shared Chromium instance: single cold-start cost regardless of how many pages need it.
    browser_results = {}
    if js_gated_urls:
        _ensure_browsers()
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as pw:
                browser = pw.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
                for u in js_gated_urls:
                    res = _fetch_browser(u, query, browser=browser)
                    if res and not res.get("error") and len(res.get("text", "").strip()) >= 100:
                        browser_results[u] = res
                browser.close()
        except Exception:
            pass  # Browser unavailable -- requests results still valid

    # 5. Combine, preserving candidate URL order
    all_fetched = {**requests_results, **browser_results}
    pages = []
    all_direct_links = []

    for u in candidate_urls:
        res = all_fetched.get(u)
        if not res or "text" not in res:
            continue
        raw_text = res["text"]
        if "Direct Download Links:\n" in raw_text:
            parts = raw_text.split("Direct Download Links:\n", 1)[1].split("\n\nContent:\n", 1)
            for line in parts[0].splitlines():
                clean = line.strip()
                if clean.startswith("- [") and clean not in all_direct_links:
                    all_direct_links.append(clean)
        page_summary = extract_relevant_chunks(raw_text, query, max_total_chars=2500)
        pages.append({
            "url": u,
            "content": page_summary,
            "browser": res.get("browser", False),
        })

    # 6. Download follow-up if needed
    download_keywords = ["download", ".jar", ".zip", ".tar", ".gz", "release", "installer", "server"]
    is_download_query = any(k in query.lower() for k in download_keywords)
    if is_download_query and not all_direct_links:
        targeted_q = f"{query} direct download link github"
        targeted_results = search(targeted_q)
        if isinstance(targeted_results, list):
            for tr in targeted_results[:1]:
                tu = tr.get("url", "")
                if tu and tu not in [p["url"] for p in pages]:
                    tr_fetch = fetch(tu, query)
                    if tr_fetch and "text" in tr_fetch and not tr_fetch.get("error"):
                        raw_text = tr_fetch["text"]
                        if "Direct Download Links:\n" in raw_text:
                            parts = raw_text.split("Direct Download Links:\n", 1)[1].split("\n\nContent:\n", 1)
                            for line in parts[0].splitlines():
                                clean = line.strip()
                                if clean.startswith("- [") and clean not in all_direct_links:
                                    all_direct_links.append(clean)
                        pages.append({
                            "url": tu,
                            "content": extract_relevant_chunks(raw_text, query, max_total_chars=2500),
                        })
                        if len(all_direct_links) >= 5:
                            break

    return {
        "query": query,
        "direct_links": all_direct_links[:15],
        "pages": pages,
        "search_snippets": results[:4],
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
