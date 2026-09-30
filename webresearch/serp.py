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

"""MykyAgent webresearch.serp — split from search_helper.py (verbatim moves)."""

from .cache import cache_get, cache_put
from .config import BACKEND_CHAIN, SERP_TTL, SERP_TTL_FRESH, _backend_dead, _engine_used, _mark_backend_dead, _mark_engine_used, _reset_backends, dbg, out_of_time
from .rank import _prior
from .text import _STOP, _dedupe_key, _overlap, tok

def ddg(query: str, max_results: int = 8, preferred: str | None = None, fresh: bool = False):
    """Search via ddgs with backend failover.

    DuckDuckGo throttles aggressively -- three fan-out queries against it in a
    burst will start returning nothing. Spreading variants across independent
    engines both widens recall and removes the single point of failure.
    """
    ck = cache_get("serp", query, SERP_TTL_FRESH if fresh else SERP_TTL)
    if ck is not None:
        return ck.get("results", []), ck.get("backend")

    if DDGS is None:
        return [{"error": "ddgs not installed"}], None

    chain = ([preferred] if preferred else []) + [
        b for b in BACKEND_CHAIN if b != preferred
    ]
    # Prefer the assigned engine, then any engine not yet used this run, and only
    # fall back to a reused engine as a last resort.
    chain.sort(key=lambda b: 0 if b == preferred else (1 if not _engine_used(b) else 2))

    for backend in chain:
        if _backend_dead(backend):
            continue
        if out_of_time(15):
            break
        try:
            with DDGS() as d:
                raw = list(d.text(query, max_results=max_results, backend=backend))
            res = [
                {
                    "title": (r.get("title") or "").strip(),
                    "snippet": (r.get("body") or r.get("snippet") or "").strip(),
                    "url": (r.get("href") or r.get("url") or "").strip(),
                }
                for r in raw
                if (r.get("href") or r.get("url"))
            ]
            if res:
                _mark_engine_used(backend)
                cache_put("serp", query, {"results": res, "backend": backend})
                return res, backend
            dbg(f"serp [{backend}] empty")
        except Exception as e:
            msg = str(e)
            if "no results found" in msg.lower():
                # Zero hits for THIS query, not a dead engine. Marking the
                # backend dead here poisoned every other variant's fallback
                # chain and produced false "all engines rate limited" runs.
                dbg(f"serp [{backend}] zero hits for this query")
                continue
            if "rate" in msg.lower() or "throttl" in msg.lower() or "timed out" in msg.lower():
                dbg(f"serp [{backend}] throttled/timeout")
                _mark_backend_dead(backend)
                continue
            dbg(f"serp [{backend}] failed:", msg[:70])
        _mark_backend_dead(backend)

    return [], None
def serp_keywords(query: str, cap: int = 14) -> str:
    """Reduce a query to leading content keywords for the SERP engines.

    DDG/Bing/Yahoo are keyword matchers, not LLMs. The web_search contract
    encourages the agent to pass a full natural-language research goal, and a
    200-char prose query returns ZERO hits from every backend -- which ddgs
    reports as a generic "No results found" exception, indistinguishable from
    a throttle, so every engine gets marked dead and the run dies with a false
    "all search engines rate limited" error. Keep the raw query for ranking
    and API providers; only the SERP backends see the reduced form."""
    q = re.sub(r"^\s*(research goal|goal|task|question|query|search)\s*[:\-]\s*", "", query, flags=re.I)
    toks = re.findall(r"[a-z0-9][a-z0-9+#-]*(?:\.[a-z0-9][a-z0-9+#-]*)*", q.lower())
    seen: set[str] = set()
    out: list[str] = []
    for t in toks:
        if t not in _STOP and t not in seen:
            seen.add(t)
            out.append(t)
    return " ".join(out[:cap]) or query.strip()
def fanout_queries(query: str) -> list[str]:
    """Cheap query expansion. No LLM, no latency cost worth mentioning."""
    q = serp_keywords(query)
    variants = [q]
    low = q.lower()
    # Incident / post-mortem queries benefit from an RCA-hunting variant before
    # the generic ones; the first slots win because the list is capped at 3.
    if re.search(
        r"\b(root cause|crash|crashes|outage|incident|postmortem|post-mortem|"
        r"cve|vulnerab\w*|security|breach)\b",
        low,
    ):
        variants.append(f"{q} postmortem root cause analysis")
    elif re.search(r"\b(vs\.?|versus|compare|comparison|better|alternative)\b", low):
        variants.append(f"{q} benchmark comparison")
    if not re.search(r"\b(docs?|documentation|api|reference)\b", low):
        variants.append(f"{q} documentation")
    if re.search(r"\b(download|install|release|version|latest|setup)\b", low):
        variants.append(f"{q} github release download")
    elif re.search(r"\b(error|fix|issue|problem|crash|fail)\b", low):
        variants.append(f"{q} stackoverflow solution")
    else:
        variants.append(f"{q} github")
    # de-dup, cap at 3 to stay polite to DuckDuckGo
    seen, out = set(), []
    for v in variants:
        if v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out[:3]
def fused_search(
    query: str, max_results: int = 8, fresh: bool = False
) -> tuple[list[dict], list[str], list[str]]:
    """Fan out queries across *different* engines, fuse with RRF, apply priors."""
    _reset_backends()
    variants = fanout_queries(query)
    prefer = (BACKEND_CHAIN * 2)[: len(variants)]
    lists: list[list[dict]] = []
    used: list[str] = []

    with ThreadPoolExecutor(max_workers=len(variants)) as ex:
        futs = {
            ex.submit(ddg, v, max_results, prefer[i] if i < len(prefer) else None, fresh): v
            for i, v in enumerate(variants)
        }
        for f in as_completed(futs):
            try:
                r, backend = f.result()
            except Exception:
                continue
            if r and not (len(r) == 1 and "error" in r[0]):
                lists.append(r)
                if backend and backend not in used:
                    used.append(backend)

    if not lists:
        # Recovery sweep: one more pass on the unmodified query with a clean
        # backend slate. Covers transient throttling and momentary network
        # blips that would otherwise fail the whole search.
        _reset_backends()
        time.sleep(0.5)
        try:
            r, backend = ddg(serp_keywords(query), max_results, None, fresh)
        except Exception:
            r, backend = [], None
        if r and not (len(r) == 1 and "error" in r[0]):
            lists.append(r)
            if backend and backend not in used:
                used.append(backend)

    if not lists:
        return [], variants, used

    k = 60.0
    rrf: dict[str, float] = collections.defaultdict(float)
    best: dict[str, dict] = {}
    for lst in lists:
        for rank, item in enumerate(lst):
            key = _dedupe_key(item["url"])
            rrf[key] += 1.0 / (k + rank + 1)
            if key not in best or len(item.get("snippet", "")) > len(
                best[key].get("snippet", "")
            ):
                item = dict(item)
                item.setdefault("title", "")
                best[key] = item

    # lexical + domain-prior nudge on top of RRF
    qt = {w for w in tok(query) if w not in _STOP}
    merged = []
    for key, item in best.items():
        blob = f"{item.get('title','')} {item.get('snippet','')}"
        overlap = _overlap(blob, qt)
        score = rrf[key] * 10.0 + overlap * 2.0 + _prior(item["url"])
        merged.append((score, item))

    merged.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in merged], variants, used
