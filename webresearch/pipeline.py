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

"""MykyAgent webresearch.pipeline — split from search_helper.py (verbatim moves)."""

from .cache import cache_get, cache_put
from .config import DEADLINE_S, NO_BROWSER, PAGE_BUDGET, PAGE_TTL, PAGE_TTL_FRESH, SERP_TTL, SERP_TTL_FRESH, _is_farm, _reset_backends, dbg, out_of_time, remaining
from .fetchmod import DOWNLOAD_INTENT, _consolidate, _ensure_browsers, _fetch_browser, _launch, fetch
from .providers import _filter_structured, gather_providers
from .rank import ENUM_RE, RECENCY_RE, _DIAGNOSTIC_RE, _is_promo_path, _prior, asked_fields, detect_conflicts, field_present, nav_host, probe_paths
from .serp import fused_search
from .text import _STOP, _dedupe_key, _domain, _overlap, clean_q, tok

def research(query: str) -> dict:
    _reset_backends()
    t0 = time.monotonic()
    stats = {"candidates": 0, "fetched": 0, "browser": 0, "dropped": 0}
    timings: dict[str, float] = {}
    warnings: list[str] = []

    # --- intent -----------------------------------------------------------
    recency = bool(RECENCY_RE.search(query))
    enumeration = bool(ENUM_RE.search(query))
    fields = asked_fields(query)
    page_budget = PAGE_BUDGET
    page_ttl = PAGE_TTL_FRESH if recency else PAGE_TTL
    serp_ttl = SERP_TTL_FRESH if recency else SERP_TTL

    ck = cache_get("research", query, serp_ttl)
    if ck:
        ck["cached"] = True
        return ck

    # Operators belong to the SERP engines only. Ranking, nav detection and
    # block selection must see plain query words (see clean_q docstring).
    query_c = clean_q(query)

    _t = time.monotonic()
    results, variants, engines = fused_search(query, fresh=recency)
    # EXPERIMENTAL (MYKYAGENT_SERP_BACKEND=searxng): merge self-hosted
    # aggregate candidates; downstream dedupe/rerank treats them uniformly.
    try:
        from .backends import SERP_BACKEND, extra_serp_results
        if SERP_BACKEND == "searxng":
            extra = extra_serp_results(query, fresh=recency)
            if extra:
                results = list(extra) + list(results)
                engines = list(engines) + ["searxng"]
    except Exception as e:
        dbg(f"searxng hook failed: {e}")
    timings["serp"] = round(time.monotonic() - _t, 2)
    stats["engines"] = engines
    stats["intent"] = {
        "recency": recency,
        "enumeration": enumeration,
        "fields": sorted(fields),
    }

    # --- navigational: honour the site the user named ----------------------
    nav = nav_host(query_c, results)
    if nav:
        results.append(
            {
                "title": f"{nav} (site named in query)",
                "snippet": "",
                "url": f"https://{nav}/",
                "_prov": 6.0,
            }
        )
        if recency and remaining() > 30:
            _t = time.monotonic()
            probed = probe_paths(nav)
            timings["nav_probe"] = round(time.monotonic() - _t, 2)
            for p in probed:
                results.append(
                    {
                        "title": f"{nav}{urlparse(p).path}",
                        "snippet": "changelog / release notes",
                        "url": p,
                        "_prov": 7.0,
                    }
                )
        stats["nav_domain"] = nav

    qt = {w for w in tok(query_c) if w not in _STOP}
    diagnostic = bool(_DIAGNOSTIC_RE.search(query_c))
    community_intent = bool(
        re.search(
            r"\b(reddit|community|consensus|opinions?|reviews?|sentiment|"
            r"thoughts|experiences?|recommend\w*|worth it|hype|complain\w*|"
            r"gotchas?|pitfalls?)\b",
            query_c,
            re.I,
        )
    )

    def _rank(pool: list[dict]) -> list[tuple[float, dict]]:
        out: list[tuple[float, dict]] = []
        seen_keys: set[str] = set()
        for i, r in enumerate(pool):
            key = _dedupe_key(r["url"])
            if key in seen_keys:
                continue
            seen_keys.add(key)
            blob = f"{r['title']} {r['snippet']}"
            score = (
                _overlap(blob, qt) * 3.0
                + (1.0 / (1 + i * 0.25)) * 1.5
                + _prior(r["url"], community=community_intent)
                + float(r.get("_prov") or 0.0)
            )
            if nav and _domain(r["url"]) == nav:
                # Diagnostic queries: only deep content on the named site earns
                # the boost; the homepage would just inject marketing copy.
                if not (diagnostic and _is_promo_path(r["url"])):
                    score += 4.0
            out.append((score, r))
        out.sort(key=lambda x: x[0], reverse=True)
        return out

    ranked = _rank(results)

    # Structured APIs get the *ranked* URL list, so when we ask GitHub about a
    # repo we ask about the one the query is actually about.
    _t = time.monotonic()
    structured = _filter_structured(
        gather_providers(query_c, [r["url"] for _, r in ranked], nav, recency), query_c
    )
    timings["providers"] = round(time.monotonic() - _t, 2)

    prov_pool: list[dict] = []
    for name, items in structured.items():
        if name not in ("github_search", "modrinth", "wikipedia", "stackoverflow", "reddit"):
            continue
        for it in items:
            if not isinstance(it, dict) or not it.get("url"):
                continue
            prov_pool.append(
                {
                    "title": f"[{name}] {it.get('full_name') or it.get('title') or it.get('name') or ''}",
                    "snippet": (
                        it.get("description")
                        or it.get("excerpt")
                        or it.get("extract")
                        or ""
                    ),
                    "url": it["url"],
                    "_prov": 1.5,
                }
            )
    if prov_pool:
        ranked = _rank(results + prov_pool)

    stats["candidates"] = len(ranked)

    # A total SERP outage must not throw away API data. GitHub/Modrinth/PyPI/
    # Wikipedia/StackExchange are different hosts and usually still answer.
    if not ranked and not any(
        k in structured for k in ("neoforge_maven", "github_releases", "github_search",
                                  "modrinth", "pypi", "npm", "wikipedia", "stackoverflow")
    ):
        return {
            "query": query,
            "queries_used": variants,
            "engines_used": engines,
            "pages": [],
            "direct_links": [],
            "search_snippets": [],
            "structured": {},
            "stats": stats,
        "timings": timings,
            "error": "no results: SERP empty for all query variants across all engines (rate limited or zero hits) and no API provider matched",
        }

    # Adaptive depth: structured answers present -> fewer pages needed.
    have_answer = any(
        k in structured
        for k in ("neoforge_maven", "github_releases", "modrinth", "pypi", "npm")
    )
    # The distillation subagent ingests 30k-60k chars happily, so fetch deeper
    # than a context-starved summariser could afford. Structured-answer
    # downloads still stay shallow (the API data already carries the artifact).
    cap = 4 if (have_answer and DOWNLOAD_INTENT.search(query)) else (7 if enumeration else 6)
    if remaining() < 25:
        cap = min(cap, 3)

    # Over-fetch a little, then keep only the pages that actually fit the query.
    picked = [r for _, r in ranked[: cap + 3]][: cap + 1]

    # Time reserved for assembly/return. Scales with the caller's budget so a
    # short deadline still fetches at least one page instead of none.
    reserve = max(6.0, min(18.0, DEADLINE_S * 0.25))

    # --- parallel fetch with per-fetch deadline ----------------------------
    _t_fetch = time.monotonic()
    fetched: dict[str, dict] = {}
    ex = ThreadPoolExecutor(max_workers=max(1, min(8, len(picked))))
    try:
        futs = {}
        for r in picked:
            if futs and out_of_time(reserve):
                break
            futs[ex.submit(fetch, r["url"], query_c, None, page_budget, page_ttl, enumeration)] = r["url"]
        try:
            for f in as_completed(futs, timeout=max(1.0, min(30.0, remaining() - reserve * 0.6))):
                try:
                    res = f.result()
                except Exception:
                    continue
                if res and not res.get("error") and len(res.get("text", "").strip()) >= 120:
                    fetched[res["url"]] = res
        except TimeoutError:
            dbg("fetch phase hit its budget; keeping what finished")
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    stats["fetched"] = len(fetched)
    timings["fetch"] = round(time.monotonic() - _t_fetch, 2)

    # --- browser pass for the rest (sequential, budgeted) ------------------
    missing = [r for r in picked if r["url"] not in fetched]
    _t_browser = time.monotonic()

    # Decide before launching Chromium: if the plain fetches already contain the
    # fields the user asked for, a headless browser adds latency and nothing else.
    _pre = [{"url": u, "content": res.get("text", "")} for u, res in fetched.items()]
    _fields_satisfied = (
        all(any(field_present(f, pg["content"]) for pg in _pre) for f in fields)
        if fields else True
    )
    # For a navigational query the named site must actually be represented; if the
    # plain fetch could not get it (JS-gated), it is worth paying for a browser.
    _nav_missing = bool(nav) and not any(_domain(u) == nav for u in fetched)
    if missing and (not _fields_satisfied or len(_pre) < 2 or _nav_missing) and not NO_BROWSER and remaining() > reserve + 6:
        try:
            from playwright.sync_api import sync_playwright

            if _ensure_browsers():
                with sync_playwright() as pw:
                    b = _launch(pw)
                    for r in missing:
                        if out_of_time(reserve * 0.75):
                            break
                        res = _fetch_browser(
                            r["url"], query_c, browser=b, budget=page_budget, enum_mode=enumeration
                        )
                        if res and not res.get("error") and len(res.get("text", "").strip()) >= 120:
                            fetched[res["url"]] = res
                            stats["browser"] += 1
                    b.close()
        except Exception as e:
            dbg("browser phase skipped:", e)
    timings["browser"] = round(time.monotonic() - _t_browser, 2)

    # --- assemble, collapse near-duplicates, collect links -----------------
    pages = []
    all_links: list[str] = []
    direct_urls: list[str] = []
    for r in picked:
        res = fetched.get(r["url"])
        if not res:
            stats["dropped"] += 1
            continue
        for lnk in res.get("links", []):
            if lnk not in all_links:
                all_links.append(lnk)
                m = re.search(r"\((https?://[^)]+)\)", lnk)
                if m:
                    direct_urls.append(m.group(1))
        pages.append(
            {
                "url": r["url"],
                "title": res.get("title") or r.get("title", ""),
                "content": res["text"],
                "score": round(next((s for s, q in ranked if q["url"] == r["url"]), 0.0), 2),
                "browser": res.get("browser", False),
            }
        )

    # provider-derived direct links (API-verified, better than scraped hrefs)
    answer_links: list[str] = []
    for name in ("neoforge_maven", "github_releases", "pypi", "npm"):
        for item in structured.get(name, []):
            if not isinstance(item, dict):
                continue
            for rel in item.get("releases", []) or []:
                for a in rel.get("assets", []) or []:
                    if a.get("url"):
                        lnk = f"- [{a.get('name')}]({a['url']})"
                        if lnk not in answer_links:
                            answer_links.append(lnk)
                            direct_urls.append(a["url"])
            if item.get("installer_url"):
                lnk = (
                    f"- [{item.get('artifact','artifact').split(':')[-1]}-"
                    f"{item.get('latest')}-installer.jar]({item['installer_url']})"
                )
                if lnk not in answer_links:
                    answer_links.insert(0, lnk)
                direct_urls.insert(0, item["installer_url"])
            if item.get("repo") and item.get("latest"):
                rel_url = f"https://github.com/{item['repo']}/releases"
                if rel_url not in direct_urls:
                    direct_urls.append(rel_url)
            if item.get("home"):
                direct_urls.append(item["home"])

    all_links = answer_links + [l for l in all_links if l not in answer_links]

    # Rank by how well the *content* answers the query, keep the strongest few,
    # then strip duplicate pages and repeated blocks across pages.
    for p in pages:
        p["_fit"] = _overlap(f"{p.get('title','')} {p['content'][:1500]}", qt)

    def _page_key(p: dict) -> float:
        # Carry the candidate-stage ranking forward. Without this the navigational
        # target loses to GitHub purely because github.com has a bigger domain prior.
        nav_bonus = 0.0
        if nav and _domain(p["url"]) == nav and not (diagnostic and _is_promo_path(p["url"])):
            nav_bonus = 8.0
        return nav_bonus + p["_fit"] * 3.0 + _prior(p["url"], community=community_intent) + 0.25 * float(p.get("score") or 0.0)

    pages.sort(key=_page_key, reverse=True)
    pages = [p for p in pages if not (_is_farm(p["url"]) and p["_fit"] < 0.6)]
    pages = pages[: max(1, cap)]
    pages = _consolidate(pages)
    for p in pages:
        p.pop("_fit", None)

    # Provider Q&A pages (StackOverflow excerpt, Wikipedia summary) are cheap
    # high-signal context even when scraping them directly would fail.
    for item in structured.get("stackoverflow", []):
        pages.append(
            {
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "content": f"(accepted excerpt, score {item.get('score')})\n{item.get('excerpt','')}",
                "score": 1.0,
            }
        )
    for item in structured.get("wikipedia", []):
        pages.append(
            {
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "content": item.get("extract", ""),
                "score": 1.0,
            }
        )
    for item in structured.get("reddit", []):
        pages.append(
            {
                "url": item.get("url", ""),
                "title": f"r/{item.get('subreddit', '')}: {item.get('title', '')}",
                "content": (
                    f"(reddit discussion, {item.get('ups', 0)} upvotes, "
                    f"{item.get('comments', 0)} comments)\n{item.get('excerpt', '')}"
                ),
                "score": 1.0,
            }
        )
    for item in structured.get("osv", []):
        fixed = item.get("fixed") or []
        fx = ("\nFixed versions: " + "; ".join(fixed)) if fixed else ""
        pages.append(
            {
                "url": item.get("url", ""),
                "title": item.get("title", ""),
                "content": f"(OSV.dev advisory, authoritative){fx}\n{item.get('excerpt', '')}",
                "score": 1.0,
            }
        )

    # Provider excerpts must never duplicate a page we already fetched.
    seen_urls: set[str] = set()
    deduped: list[dict] = []
    for p in pages:
        key = _dedupe_key(p["url"])
        if key in seen_urls:
            continue
        seen_urls.add(key)
        deduped.append(p)
    pages = deduped

    # --- field coverage: did we actually return what was asked for? --------
    # A page with no dates cannot answer "what is new". One escalation attempt,
    # only if there is budget for it.
    if fields and remaining() > 35:
        missing = [
            f for f in sorted(fields)
            if not any(field_present(f, p["content"]) for p in pages)
        ]
        if missing:
            _t = time.monotonic()
            suffix = "changelog release notes" if "date" in missing else "release notes"
            more, _, _ = fused_search(f"{query} {suffix}", max_results=6, fresh=True)
            have_keys = {_dedupe_key(p["url"]) for p in pages}
            extra = [r for r in more if _dedupe_key(r["url"]) not in have_keys][:2]
            if extra and remaining() > 22:
                added = 0
                for r in extra:
                    if out_of_time(20):
                        break
                    res = fetch(
                        r["url"], query_c, None, page_budget, PAGE_TTL_FRESH, enumeration
                    )
                    if res and not res.get("error") and len(res.get("text", "").strip()) >= 120:
                        pages.append(
                            {
                                "url": r["url"],
                                "title": res.get("title") or r.get("title", ""),
                                "content": res["text"],
                                "score": 2.0,
                                "browser": res.get("browser", False),
                            }
                        )
                        have_keys.add(_dedupe_key(r["url"]))
                        added += 1
                if added:
                    warnings.append(
                        f"escalated once for missing field(s): {', '.join(missing)}"
                    )
                    pages = _consolidate(pages)
                    missing = [
                        f for f in missing
                        if not any(field_present(f, p["content"]) for p in pages)
                    ]
            timings["escalation"] = round(time.monotonic() - _t, 2)
            if missing:
                warnings.append(
                    f"requested field(s) not found in fetched sources: {', '.join(missing)}"
                )

    # --- cross-source disagreement ----------------------------------------
    conflicts: list[dict] = []
    if fields & {"score", "version", "date"} and len(pages) >= 2:
        conflicts = detect_conflicts(pages, limit=3)
        if conflicts:
            warnings.append(
                "sources disagree on numeric values for "
                + ", ".join(c["entity"] for c in conflicts[:3])
                + "; verify before relying on a single figure"
            )

    payload = {
        "query": query,
        "queries_used": variants,
        "engines_used": engines,
        "nav_domain": nav,
        "warnings": warnings,
        "conflicts": conflicts,
        "direct_links": all_links[:20],
        "direct_urls": list(dict.fromkeys(direct_urls))[:20],
        "structured": structured,
        "pages": pages,
        "search_snippets": [
            {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("snippet", "")}
            for _, r in ranked[:6]
        ],
        "stats": stats,
        "timings": timings,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }
    cache_put("research", query, payload)
    return payload
