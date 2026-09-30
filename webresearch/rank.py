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

"""MykyAgent webresearch.rank — split from search_helper.py (verbatim moves)."""

from .config import DOMAIN_BOOST, DOMAIN_PENALTY, _WALL_HOSTS, _is_farm, remaining
from .http import session
from .text import _STOP, _domain, tok

RECENCY_RE = re.compile(
    r"\b(new|newest|latest|current|currently|recent|recently|now|today|this\s+(?:week|month|year)|"
    r"changelog|whats?\s+new|updates?|added|released?|shipping|available\s+now|20(?:24|25|26))\b",
    re.I,
)
ENUM_RE = re.compile(
    r"\b(list|all|top|compare|comparison|leaderboard|ranking|rank|ranked|which|best|vs|versus|"
    r"enumerate|table|breakdown|scores?|pricing|matrix|overview\s+of)\b",
    re.I,
)
DATE_ASK_RE = re.compile(r"\b(when|date|dates|dated|timeline|as\s+of|since|updated?|released?)\b", re.I)
VERSION_ASK_RE = re.compile(r"\b(version|versions|releases?|build|tag|installer)\b", re.I)
SCORE_ASK_RE = re.compile(
    r"\b(score|scores|index|benchmark|benchmarks|rating|percent|%|rank|ranks|ranking|"
    r"leaderboard|pricing|cost|price|tokens?/s)\b",
    re.I,
)
DATE_RE = re.compile(
    r"\b(20\d{2}[-/\u2013]\d{1,2}[-/\u2013]\d{1,2}"
    r"|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*20\d{2}"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2})\b",
    re.I,
)
VERSION_RE = re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b")
NUMBER_RE = re.compile(r"(?<![\w.-])\d{1,4}(?:\.\d+)?(?![\w])")
def asked_fields(query: str) -> set[str]:
    """Which concrete fields does the user expect to come back?"""
    f: set[str] = set()
    if DATE_ASK_RE.search(query) or RECENCY_RE.search(query):
        f.add("date")
    if VERSION_ASK_RE.search(query):
        f.add("version")
    if SCORE_ASK_RE.search(query):
        f.add("score")
    return f
def field_present(field: str, text: str) -> bool:
    if not text:
        return False
    if field == "date":
        return bool(DATE_RE.search(text))
    if field == "version":
        return bool(VERSION_RE.search(text))
    if field == "score":
        return bool(NUMBER_RE.search(text))
    return True
_ENTITY_RE = re.compile(r"\b([A-Z][A-Za-z0-9]*(?:[ \-][A-Z0-9][A-Za-z0-9.]*){1,3})\b")
def detect_conflicts(pages: list[dict], limit: int = 3) -> list[dict]:
    """Flag named entities whose numeric value differs across sources.

    Deliberately conservative: an entity must appear with two *different* values
    drawn from two *different* URLs before anything is reported, and the values
    must sit in the same magnitude band. It is a hint for the reader to check,
    not an authoritative correction.
    """
    ent_vals: dict[str, dict[str, set[str]]] = collections.defaultdict(
        lambda: collections.defaultdict(set)
    )
    for p in pages:
        text = p.get("content") or ""
        url = p.get("url") or ""
        if not text or not url:
            continue
        for m in _ENTITY_RE.finditer(text):
            ent = m.group(1).strip()
            if len(ent) < 6:
                continue
            tail = text[m.end() : m.end() + 40]
            for n in NUMBER_RE.findall(tail)[:2]:
                try:
                    v = float(n)
                except ValueError:
                    continue
                if v < 1 or v > 1000:
                    continue
                ent_vals[ent][n].add(url)

    out: list[dict] = []
    for ent, vals in ent_vals.items():
        distinct = {v: urls for v, urls in vals.items() if urls}
        if len(distinct) < 2:
            continue
        all_sources = {u for urls in distinct.values() for u in urls}
        if len(all_sources) < 2:
            continue
        nums = sorted(float(v) for v in distinct)
        if nums[-1] > max(1.0, nums[0]) * 10:  # different magnitude = different metric
            continue
        out.append(
            {
                "entity": ent,
                "values": [
                    {"value": v, "sources": sorted(distinct[v])[:2]}
                    for v in sorted(distinct, key=lambda x: -len(distinct[x]))
                ][:4],
            }
        )
    out.sort(key=lambda c: -len(c["values"]))
    return out[:limit]
WELL_KNOWN_PATHS = ("/changelog", "/releases", "/news", "/updates", "/blog")
_DOMAIN_TOKEN_RE = re.compile(
    r"\b([a-z0-9][a-z0-9-]{1,60}\.(?:com|org|net|ai|io|dev|co|edu|gov|app|xyz|me|sh|so|gg|tv|us|uk|de|fr|jp|cn|info|biz))\b",
    re.I,
)
def _prior(url: str, community: bool = False) -> float:
    d = _domain(url)
    s = 0.0
    for host, boost in DOMAIN_BOOST.items():
        if d == host or d.endswith("." + host):
            s += boost
            break
    # First-party docs are worth more than any third-party writeup.
    if d.startswith("docs.") or d.startswith("wiki.") or d.startswith("developer."):
        s += 0.8
    try:
        path = urlparse(url).path.lower()
        if any(seg in path for seg in ("/docs/", "/doc/", "/wiki/", "/manual/", "/reference/", "/api/")):
            s += 0.6
    except Exception:
        pass
    if _is_farm(url):
        s -= 3.0
    # JS-walled hosts: requests gets an empty shell, the browser pass gets a
    # login wall. They still crowd page 1 of SERPs for people-shaped queries,
    # so rank them below everything that can actually be read.
    if any(d == h or d.endswith("." + h) for h in _WALL_HOSTS):
        s -= 4.0
    for bad in DOMAIN_PENALTY:
        if bad in d:
            # Community-sentiment queries explicitly want Reddit threads; the
            # penalty must not fight the intent that summoned them.
            if community and "reddit" in bad:
                break
            s -= 1.2
            break
    return s
_DIAGNOSTIC_RE = re.compile(
    r"\b(root cause|crash|crashes|issue|bug|cve|why|analysis|postmortem|"
    r"post-mortem|outage|incident|vulnerab\w*|security|regression|broken|"
    r"fails?|failure|debug)\b",
    re.I,
)
_SHALLOW_PATHS = (
    "", "/", "/about", "/news", "/press", "/company", "/home", "/careers",
    "/products", "/product", "/pricing", "/contact", "/investors", "/customers",
)
def _is_promo_path(url: str) -> bool:
    try:
        path = urlparse(url).path.lower().rstrip("/")
    except Exception:
        return True
    return path in _SHALLOW_PATHS
def nav_host(query: str, results: list[dict]) -> str | None:
    """Detect a navigational query: the user named the site they want.

    "artificial analysis leaderboard" must resolve to artificialanalysis.ai, not
    to whichever aggregator happens to rank well. Matching is done on
    concatenated query n-grams against the flattened hostname, so word-splitting
    differences do not matter.
    """
    explicit = _DOMAIN_TOKEN_RE.search(query)
    if explicit:
        return explicit.group(1).lower()

    qt = [w for w in tok(query) if w not in _STOP and len(w) > 2]
    if not qt:
        return None
    joined = "".join(qt)

    best, best_hit = None, 0
    for idx, r in enumerate(results):
        d = _domain(r.get("url", ""))
        if not d:
            continue
        core = re.sub(r"^www\.", "", d).split(".")[0]
        flat = re.sub(r"[^a-z0-9]", "", core)
        if len(flat) < 6:
            continue

        hit = 0
        # Multi-word brand: "artificial analysis" -> "artificialanalysis". Strong.
        for n in (3, 2):
            for i in range(max(0, len(qt) - n + 1)):
                gram = "".join(qt[i : i + n])
                if len(gram) >= 8 and gram in flat:
                    hit = max(hit, len(gram))

        # Single query word matching a hostname is weak evidence -- any Kubernetes
        # query would resolve to kubernetes.ae. Require a long, distinctive brand
        # token that also ranks near the top.
        if flat in joined and len(flat) >= 12 and idx < 3:
            hit = max(hit, len(flat))

        if hit > best_hit:
            best, best_hit = d, hit
    return best
def probe_paths(host: str, paths: tuple[str, ...] = WELL_KNOWN_PATHS) -> list[str]:
    """Probe conventional changelog/release paths on a site in parallel.

    A site's changelog page carries the dates its landing page omits.
    """
    if not host:
        return []

    def _one(p: str):
        try:
            r = session().get(
                f"https://{host}{p}", timeout=(4, 8), allow_redirects=True, stream=True
            )
            try:
                ct = (r.headers.get("content-type") or "").lower()
                if r.status_code == 200 and "html" in ct:
                    return f"https://{host}{p}"
            finally:
                r.close()
        except Exception:
            pass
        return None

    found: list[str] = []
    ex = ThreadPoolExecutor(max_workers=min(5, len(paths)))
    try:
        futs = [ex.submit(_one, p) for p in paths]
        for f in futs:
            try:
                r = f.result(timeout=max(1.0, min(10.0, remaining() - 5)))
            except Exception:
                continue
            if r:
                found.append(r)
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    return found
