from __future__ import annotations

import collections
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

try:
    from ddgs import DDGS
except Exception:  # pragma: no cover
    DDGS = None

"""MykyAgent webresearch.fetchmod — split from search_helper.py (verbatim moves)."""

from .blocks import select_blocks
from .cache import cache_get_age, cache_put
from .config import CONNECT_TIMEOUT, FORCE_BROWSER, JSON_BUDGET, MAX_HTML_BYTES, NO_BROWSER, NO_QUERY_BUDGET, PAGE_BUDGET, PAGE_TTL, READ_TIMEOUT, UA_BROWSER, dbg, out_of_time, remaining
from .html import _decode_html, html_to_markdown
from .http import session
from .text import tok

def _is_js_gated(html: str, text: str) -> bool:
    low = (text or "").strip().lower()
    if len(low) < 450:
        return True
    if any(
        pat in low
        for pat in (
            "user rating: safe",
            "user rating : safe",
            "rating: safe",
            "security status: safe",
            "100% clean",
            "100% safe",
            "download now",
            "click here to download",
        )
    ) and len(low) < 900:
        return True
    head = html[:6000].lower()
    if any(
        m in head
        for m in (
            "just a moment",
            "enable javascript",
            "cf-challenge",
            "checking your browser",
            "attention required",
            "please verify you are a human",
        )
    ) and len(low) < 900:
        return True
    if any(m in head for m in ('id="root"', 'id="app"', "__next_data__", "ng-version")) and len(low) < 600:
        return True
    return False
def _pdf_text(raw: bytes) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        pages = []
        for p in reader.pages[:40]:
            try:
                pages.append(p.extract_text() or "")
            except Exception:
                continue
        return "\n\n".join(pages).strip()
    except Exception as e:
        dbg("pdf parse failed:", e)
        return ""
_TEXT_EXT = (
    ".txt", ".md", ".markdown", ".rst", ".json", ".jsonl", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".properties", ".log", ".csv", ".tsv",
    ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".js", ".mjs", ".cjs", ".ts",
    ".jsx", ".tsx", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cc", ".cpp",
    ".hpp", ".cs", ".php", ".pl", ".lua", ".sql", ".diff", ".patch", ".lock",
)
def fetch(
    url: str,
    query: str | None = None,
    _browser=None,
    budget: int = PAGE_BUDGET,
    ttl: int = PAGE_TTL,
    enum_mode: bool = False,
    _fresh: bool = False,
    force_browser: bool = False,
) -> dict:
    """Fetch one URL.

    Returns {url,text,links,title[,browser][,cached,age_s][,final_url]} or
    {url,error}. Cache hits report their age so a caller can tell a fresh fetch
    from a day-old copy; `_fresh` bypasses the cache read entirely.
    """
    should_force_browser = force_browser or FORCE_BROWSER
    eff_budget = budget if query else max(budget, NO_QUERY_BUDGET)

    hit = None if _fresh else cache_get_age("page", url, ttl)
    if hit:
        ck, age = hit
        # If caller forces browser, do not reuse a non-browser static cache entry
        if (not should_force_browser or ck.get("browser")) and (query is None or ck.get("_q") == query):
            ck.pop("_q", None)
            ck["cached"] = True
            ck["age_s"] = round(age, 1)
            return ck

    try:
        resp = session().get(
            url,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            allow_redirects=True,
            stream=True,
        )
        try:
            status = resp.status_code
            ct = (resp.headers.get("content-type") or "").lower()
            if status >= 400:
                # EXPERIMENTAL: bot-walled pages (403s incl. tweets) get one
                # Jina reader attempt before admitting defeat.
                try:
                    from .backends import JINA_FALLBACK, jina_fetch
                    if JINA_FALLBACK and not out_of_time(35):
                        jr = jina_fetch(url)
                        if jr:
                            return {"url": url, "text": jr["text"], "links": [], "title": jr["title"], "via": "jina"}
                except Exception:
                    pass
                return {"url": url, "error": f"HTTP {status}"}

            # A redirect means the canonical URL is not the one we asked for.
            final = getattr(resp, "url", url) or url
            extra = {} if final == url else {"final_url": final}

            raw = resp.raw.read(MAX_HTML_BYTES + 1, decode_content=True)
            if len(raw) > MAX_HTML_BYTES:
                raw = raw[:MAX_HTML_BYTES]

            if "application/pdf" in ct or url.lower().endswith(".pdf"):
                text = _pdf_text(raw)
                if not text:
                    return {"url": url, "error": "pdf with no extractable text"}
                text = select_blocks(text, query, eff_budget, enum_mode)
                res = {"url": url, "text": text, "links": [], "title": "", **extra}
                cache_put("page", url, {**res, "_q": query})
                return res

            if "application/json" in ct or "+json" in ct:
                truncated = False
                try:
                    parsed = json.loads(raw.decode("utf-8", errors="replace"))
                    # Compact: indentation is pure token cost for no added meaning
                    # to a model that parses the structure anyway.
                    text = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
                except Exception:
                    text = _decode_html(raw, ct)
                if len(text) > JSON_BUDGET:
                    text, truncated = text[:JSON_BUDGET], True
                res = {
                    "url": url,
                    "text": text,
                    "links": [],
                    "title": "",
                    "truncated": truncated,
                    **extra,
                }
                cache_put("page", url, {**res, "_q": query})
                return res

            # Some hosts serve plain text with no Content-Type, or as
            # application/octet-stream. Fall back to the URL extension.
            explicit_text = ("html" in ct) or ("xml" in ct) or ("text/" in ct)
            tolerated = ct == "" or "octet-stream" in ct
            text_like_ext = urlparse(url).path.lower().endswith(_TEXT_EXT)
            if not explicit_text and not (tolerated and text_like_ext):
                return {"url": url, "error": f"unsupported content-type: {ct or '(none)'}"}

            html = _decode_html(raw, ct)
        finally:
            resp.close()

        text, links, title = html_to_markdown(html, url)

        # EXPERIMENTAL (MYKYAGENT_EXTRACTOR=trafilatura): purpose-built
        # boilerplate removal wins on blogs/news when it finds MORE text;
        # links/title stay on the builtin pass. Fail-soft by design.
        try:
            from .backends import EXTRACTOR, trafilatura_text
            alt = trafilatura_text(html, url) if EXTRACTOR == "trafilatura" else None
            if alt and len(alt) > len(text):
                text = alt
        except Exception as e:
            dbg(f"trafilatura hook failed: {e}")

        if (should_force_browser or _is_js_gated(html, text)) and not NO_BROWSER and not out_of_time(8):
            br = _fetch_browser(
                url, query, browser=_browser, budget=eff_budget, enum_mode=enum_mode
            )
            if br.get("text") and (should_force_browser or len(br["text"]) > len(text)):
                res = {
                    "url": url,
                    "text": br["text"],
                    "links": br.get("links") or links,
                    "title": br.get("title") or title,
                    "browser": True,
                    **extra,
                }
                cache_put("page", url, {**res, "_q": query})
                return res

        # EXPERIMENTAL (MYKYAGENT_JINA_FALLBACK=1): thin static text means a
        # JS shell, bot-wall or tweet page — try the Jina reader before
        # settling. Only when it returns MORE than we already have.
        if len(text.strip()) < 400 and not out_of_time(35):
            try:
                from .backends import JINA_FALLBACK, jina_fetch
                if JINA_FALLBACK:
                    jr = jina_fetch(url)
                    if jr and len(jr["text"]) > len(text):
                        text, links, title = jr["text"], links or jr["links"], title or jr["title"]
                        extra = {**extra, "via": "jina"}
            except Exception as e:
                dbg(f"jina hook failed: {e}")

        text = select_blocks(text, query, eff_budget, enum_mode)
        res = {"url": url, "text": text, "links": links, "title": title, **extra}
        cache_put("page", url, {**res, "_q": query})
        return res
    except Exception as e:
        # EXPERIMENTAL: network-level failures (DNS, reset, timeout) also get
        # one Jina attempt — it often succeeds precisely when direct fails.
        try:
            from .backends import JINA_FALLBACK, jina_fetch
            if JINA_FALLBACK and not out_of_time(35):
                jr = jina_fetch(url)
                if jr:
                    return {"url": url, "text": jr["text"], "links": [], "title": jr["title"], "via": "jina"}
        except Exception:
            pass
        return {"url": url, "error": str(e)}
def _ensure_browsers() -> bool:
    cache_base = Path.home() / ".cache" / "ms-playwright"
    if cache_base.exists():
        for pat in (
            "chromium-*/chrome-linux*/chrome",
            "chromium-*/chrome",
            "chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell",
        ):
            if any(cache_base.glob(pat)):
                return True
    if out_of_time(40):
        return False
    import subprocess

    dbg("installing chromium...")
    try:
        r = subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=min(120, max(20, int(remaining() - 10))),
        )
        return r.returncode == 0
    except Exception:
        return False
def _launch(pw):
    return pw.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--block-new-web-contents",
        ],
    )
def _new_page(browser):
    page = browser.new_page()
    page.set_extra_http_headers({"User-Agent": UA_BROWSER, "Accept-Language": "en-US,en;q=0.9"})
    # Block heavy resources we never read: big speed win on JS-heavy sites.
    try:
        page.route(
            "**/*",
            lambda route: route.abort()
            if route.request.resource_type in ("image", "media", "font")
            else route.continue_(),
        )
    except Exception:
        pass
    return page
def _interact(page) -> None:
    """Best-effort: dismiss consent banners, scroll for lazy content, expand rows."""
    for sel in (
        "#onetrust-accept-btn-handler",
        ".cc-accept",
        "[data-accept]",
        "[aria-label*='cookie' i]",
        "[aria-label*='consent' i]",
        "[id*='cookie' i] button",
        "[class*='consent' i] button",
        "button:has-text('Accept all')",
        "button:has-text('Accept')",
        "button:has-text('I agree')",
        "button:has-text('Got it')",
        "button:has-text('Allow all')",
    ):
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=250):
                btn.click(timeout=500)
                page.wait_for_timeout(300)
                break
        except Exception:
            pass

    try:
        h = page.evaluate("document.body.scrollHeight")
        for i in range(1, 4):
            page.evaluate(f"window.scrollTo(0,{h * i // 3})")
            page.wait_for_timeout(350)
        page.evaluate("window.scrollTo(0,0)")
        page.wait_for_timeout(200)
    except Exception:
        pass

    for sel in (
        "button:has-text('Show more')",
        "button:has-text('Load more')",
        "button:has-text('View all')",
        "[class*='load-more']",
        "[class*='show-more']",
    ):
        try:
            for _ in range(2):
                btn = page.locator(sel).first
                if btn.is_visible(timeout=250):
                    btn.click(timeout=500)
                    page.wait_for_timeout(500)
                else:
                    break
        except Exception:
            pass
def _fetch_browser(
    url: str,
    query: str | None = None,
    browser=None,
    budget: int = PAGE_BUDGET,
    enum_mode: bool = False,
) -> dict:
    if NO_BROWSER:
        return {"url": url, "error": "browser disabled"}
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        return {"url": url, "error": f"playwright unavailable: {e}"}

    if not _ensure_browsers():
        return {"url": url, "error": "chromium unavailable"}

    own = browser is None
    pw = None
    b = browser
    try:
        if own:
            pw = sync_playwright().start()
            b = _launch(pw)
        page = _new_page(b)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1200)
            _interact(page)
        except Exception:
            pass  # partial render is still useful
        html = page.content()
        page.close()
        text, links, title = html_to_markdown(html, url)
        text = select_blocks(text, query, budget, enum_mode)
        return {"url": url, "text": text, "links": links, "title": title, "browser": True}
    except Exception as e:
        return {"url": url, "error": f"[browser] {e}"}
    finally:
        if own:
            for closer in (lambda: b and b.close(), lambda: pw and pw.stop()):
                try:
                    closer()
                except Exception:
                    pass
DOWNLOAD_INTENT = re.compile(
    r"\b(download|install|release|version|latest|setup|update|jar|modpack|"
    r"build|binary|package)\b",
    re.I,
)
def _consolidate(pages: list[dict]) -> list[dict]:
    """Drop near-duplicate pages, then erase repeated blocks across survivors.

    Content-farm and commercial pages recycle the same advice almost verbatim;
    paying tokens for it twice is pure waste.
    """
    kept: list[dict] = []
    sigs: list[set] = []
    for p in pages:
        words = set(tok(p["content"][:1500]))
        if not words:
            continue
        if any(len(words & s) / max(1, len(words | s)) > 0.55 for s in sigs):
            continue
        sigs.append(words)
        kept.append(p)

    seen_blocks: set[str] = set()
    for p in kept:
        out = []
        for blk in p["content"].split("\n\n"):
            toks = tok(blk)
            if len(toks) < 12:  # keep short blocks; they carry code/config detail
                out.append(blk)
                continue
            sig = " ".join(toks[:40])
            if sig in seen_blocks:
                continue
            seen_blocks.add(sig)
            out.append(blk)
        p["content"] = "\n\n".join(b for b in out if b.strip())
    return [p for p in kept if len(p["content"].strip()) >= 120]
