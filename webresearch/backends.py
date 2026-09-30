"""MykyAgent webresearch.backends — EXPERIMENTAL alternatives.

The default pipeline (serp/ + providers/ + fetchmod/) is the original
implementation and never changes behavior. Everything here is env-gated
and fail-soft: unset env = original path, backend error = fall back.

    MYKYAGENT_SERP_BACKEND=searxng  merge SearXNG aggregate into candidates
    MYKYAGENT_SEARXNG_URL           base URL (default http://127.0.0.1:8888)
    MYKYAGENT_EXTRACTOR=trafilatura try trafilatura first, builtin fallback
    MYKYAGENT_JINA_FALLBACK=1       r.jina.ai when static fetch yields nothing
    MYKYAGENT_JINA_KEY              optional Bearer key (higher limits)

    multi mode: research N queries concurrently, one merged bundle.
"""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .cache import cache_get, cache_put
from .config import dbg
from .http import session
from .text import _dedupe_key

SERP_BACKEND = os.environ.get("MYKYAGENT_SERP_BACKEND", "original").lower()
SEARXNG_URL = os.environ.get("MYKYAGENT_SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")
EXTRACTOR = os.environ.get("MYKYAGENT_EXTRACTOR", "builtin").lower()
JINA_FALLBACK = os.environ.get("MYKYAGENT_JINA_FALLBACK") == "1"
JINA_KEY = os.environ.get("MYKYAGENT_JINA_KEY", "")
JINA_PREFIX = "https://r.jina.ai/"


# --- SearXNG aggregate SERP ---------------------------------------------------
# Self-hosted metasearch (docker: searxng/searxng). One JSON call fans out to
# dozens of engines server-side: no per-engine scraping, no DDG throttling,
# and range/bang support. This is the single biggest reliability upgrade over
# the original ddgs fan-out — at the cost of hosting one container.

def map_searxng(data: dict, limit: int = 10) -> list[dict]:
    """Pure mapper: SearXNG JSON -> {url,title,snippet} candidate list."""
    out: list[dict] = []
    try:
        items = data.get("results") or []
    except Exception:
        return out
    for r in items:
        try:
            url = r.get("url") or ""
            if not url.startswith("http"):
                continue
            out.append({
                "url": url,
                "title": r.get("title") or "",
                "snippet": r.get("content") or "",
            })
        except Exception:
            continue
        if len(out) >= limit:
            break
    return out


def searxng_search(query: str, max_results: int = 10, categories: str = "general") -> list[dict]:
    """Live SearXNG query. Fail-soft: any error -> []. Never raises."""
    try:
        r = session().get(
            f"{SEARXNG_URL}/search",
            params={"q": query, "format": "json", "language": "en", "categories": categories},
            timeout=(5, 20),
        )
        if r.status_code >= 400:
            dbg(f"searxng HTTP {r.status_code}")
            return []
        return map_searxng(r.json(), max_results)
    except Exception as e:
        dbg(f"searxng failed: {e}")
        return []


def extra_serp_results(query: str, max_results: int = 10, fresh: bool = False) -> list[dict]:
    """Extra candidates for the pipeline to merge. [] unless searxng selected."""
    if SERP_BACKEND != "searxng":
        return []
    key = f"searxng:{query}"
    hit = None if fresh else cache_get("serp", key, 3600)
    if hit is not None:
        return hit
    res = searxng_search(query, max_results)
    if res:
        cache_put("serp", key, res)
    return res


# --- trafilatura extraction ---------------------------------------------------
# Purpose-built article/boilerplate removal; beats hand-rolled tag filters on
# blogs and news. Optional dep (pip install trafilatura); guarded import so
# the default install never breaks.

_trafi = None
_trafi_tried = False


def _trafilatura():
    global _trafi, _trafi_tried
    if _trafi_tried:
        return _trafi
    _trafi_tried = True
    try:
        import trafilatura
        _trafi = trafilatura
    except Exception:
        _trafi = None
    return _trafi


def trafilatura_text(html: str, url: str) -> str | None:
    """Extract article text with trafilatura. None when unavailable/thin."""
    mod = _trafilatura()
    if mod is None:
        return None
    try:
        text = mod.extract(html, include_comments=False, include_tables=True,
                           url=url, favor_recall=True)
    except Exception:
        return None
    if not text or len(text.strip()) < 500:
        return None
    return text.strip()


# --- Jina AI reader fallback ---------------------------------------------------
# https://r.jina.ai/<url> returns server-rendered markdown: handles JS-heavy
# pages, SPAs and tweet pages without local Chromium. Free tier works without
# a key; MYKYAGENT_JINA_KEY raises limits. Last resort only — proxied reads
# are slower and less trustworthy than direct fetches.

def jina_url(url: str) -> str:
    return JINA_PREFIX + url


def jina_fetch(url: str, timeout: int = 30) -> dict | None:
    """Fetch via Jina reader. Returns page-like dict or None (fail-soft)."""
    try:
        headers = {"Accept": "text/plain"}
        if JINA_KEY:
            headers["Authorization"] = f"Bearer {JINA_KEY}"
        r = session().get(jina_url(url), headers=headers, timeout=(5, timeout))
        if r.status_code >= 400:
            dbg(f"jina HTTP {r.status_code} for {url}")
            return None
        text = (r.text or "").strip()
        if len(text) < 200:
            return None
        return {"url": url, "text": text, "links": [], "title": url, "via": "jina"}
    except Exception as e:
        dbg(f"jina failed: {e}")
        return None


# --- batch: N queries concurrently, one merged bundle --------------------------
# The TS side runs research serially per hop; batch lets experiments fan out
# multiple sensible queries at once (e.g. version + changelog + API docs) and
# pay the fetch cost once with cross-query dedupe.

def merge_bundles(bundles: list[dict]) -> dict:
    """Pure merge: dedupe pages by URL key, union links/structured/queries."""
    pages: list[dict] = []
    seen: set[str] = set()
    links: list = []
    seen_links: set[str] = set()
    structured: dict = {}
    snippets: list = []
    queries: list = []
    warnings: list = []
    for b in bundles:
        if not isinstance(b, dict):
            continue
        for p in b.get("pages") or []:
            try:
                k = _dedupe_key(p.get("url", ""))
            except Exception:
                k = p.get("url", "")
            if not k or k in seen:
                continue
            seen.add(k)
            pages.append(p)
        for l in b.get("direct_links") or []:
            lk = l if isinstance(l, str) else json.dumps(l, sort_keys=True)
            if lk not in seen_links:
                seen_links.add(lk)
                links.append(l)
        for k, v in (b.get("structured") or {}).items():
            structured.setdefault(k, v)
        snippets.extend(b.get("search_snippets") or [])
        queries.extend(b.get("queries_used") or [])
        warnings.extend(b.get("warnings") or [])
    return {
        "pages": pages,
        "direct_links": links,
        "structured": structured,
        "search_snippets": snippets,
        "queries_used": list(dict.fromkeys(queries)),
        "warnings": warnings,
    }


def research_batch(queries: list[str], research_fn, max_workers: int = 4) -> dict:
    """Run research_fn over queries concurrently; merged bundle + timings."""
    t0 = time.monotonic()
    out: dict = {}
    with ThreadPoolExecutor(max_workers=min(max_workers, max(1, len(queries)))) as ex:
        futs = {ex.submit(research_fn, q): q for q in queries}
        for fut in as_completed(futs):
            try:
                out[futs[fut]] = fut.result()
            except Exception as e:
                out[futs[fut]] = {"error": str(e)}
    merged = merge_bundles([out[q] for q in queries if isinstance(out.get(q), dict)])
    merged["queries_used"] = list(queries)
    merged["batch_s"] = round(time.monotonic() - t0, 2)
    return merged


# --- offline unit checks (pure; no network) ------------------------------------

def backends_unit() -> list[dict]:
    checks: list[dict] = []

    def ck(name, cond, extra=""):
        checks.append({"name": name, "ok": bool(cond), "extra": "" if cond else str(extra)})

    ck("searxng mapper keeps http results",
       map_searxng({"results": [{"url": "https://a.io/x", "title": "T", "content": "S"}]})[0]["url"] == "https://a.io/x")
    ck("searxng mapper drops non-http",
       map_searxng({"results": [{"url": "magnet:?x", "title": "T"}]}) == [])
    ck("searxng mapper caps limit",
       len(map_searxng({"results": [{"url": f"https://a.io/{i}"} for i in range(20)]}, limit=5)) == 5)
    ck("searxng mapper tolerates garbage", map_searxng({}) == [] and map_searxng(None) == [])
    ck("jina url builder", jina_url("https://x.com/a") == "https://r.jina.ai/https://x.com/a")
    ck("extra serp inert by default",
       SERP_BACKEND != "searxng" and extra_serp_results("q") == [])
    b1 = {"pages": [{"url": "https://a.io/x", "text": "1"}], "direct_links": ["https://a.io/x"],
          "structured": {"pypi": 1}, "queries_used": ["q1"], "warnings": []}
    b2 = {"pages": [{"url": "https://a.io/x", "text": "1"}, {"url": "https://b.io/y", "text": "2"}],
          "direct_links": [], "structured": {"npm": 2}, "queries_used": ["q2"], "warnings": ["w"]}
    m = merge_bundles([b1, b2])
    ck("merge dedupes pages", len(m["pages"]) == 2)
    ck("merge unions structured", m["structured"] == {"pypi": 1, "npm": 2})
    ck("merge unions queries+links", m["queries_used"] == ["q1", "q2"] and len(m["direct_links"]) == 1)
    ck("trafilatura absent-or-string",
       trafilatura_text("<html><body><p>tiny</p></body></html>", "https://a.io") in (None,) or isinstance(trafilatura_text("x", "y"), (str, type(None))))
    return checks
