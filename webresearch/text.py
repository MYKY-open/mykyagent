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

"""MykyAgent webresearch.text — split from search_helper.py (verbatim moves)."""

_TOKEN = re.compile(r"[a-z0-9]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
def _stem(w: str) -> str:
    """Lightweight suffix normaliser so 'crash'/'crashes', 'timeout'/'timeouts',
    'build'/'building', 'fix'/'fixed' match in BM25 and overlap scoring.
    Deliberately crude: applied identically to query and document tokens, and
    only ever affects ranking -- never filtering -- so a bad stem costs a
    little recall, not correctness."""
    if len(w) <= 4:
        return w
    if w.endswith("ies") and len(w) > 5:
        return w[:-3] + "y"
    if w.endswith("es"):
        base = w[:-2]
        # crashes/matches/boxes lose 'es' (voiced sibilant plurals); types/notes
        # keep their stem and fall through to the plain 's' rule below.
        if len(base) >= 3 and base[-1] in "hxzs" and not base.endswith("ss"):
            return base
    if w.endswith("ing"):
        base = w[:-3]
        if len(base) >= 3:
            # running -> runn is wrong; undouble the trailing consonant.
            if base[-1] == base[-2] and base[-1] not in "lsz":
                base = base[:-1]
            return base
    if w.endswith("ed"):
        base = w[:-2]
        if len(base) >= 3:
            if base[-1] == base[-2] and base[-1] not in "lsz":
                base = base[:-1]
            return base
    if w.endswith("s") and not w.endswith(("ss", "us", "is")) and len(w) > 4:
        return w[:-1]
    return w
def tok(s: str) -> list[str]:
    s = _CAMEL.sub(" ", s)
    return [_stem(t) for t in _TOKEN.findall(s.lower())]
_SEARCH_OPS_RE = re.compile(
    r"(?:^|\s)(?:site|inurl|inanchor|intitle|intext|filetype|related|cache|after|before|lang|tld):\S*",
    re.I,
)
_BARE_OP_RE = re.compile(r"(?:^|\s)(?:AND|OR|NOT|XOR)(?=\s|$)", re.I)
def clean_q(query: str) -> str:
    """Strip search operators + bare boolean words for ranking/nav use.

    The raw query still goes to the SERP engines (site: filters are useful
    there); everything downstream that compares query tokens against page
    text must use the cleaned form.
    """
    if not query:
        return query
    q = _SEARCH_OPS_RE.sub(" ", query)
    q = _BARE_OP_RE.sub(" ", q)
    return re.sub(r"\s+", " ", q).strip()
_TOC_LINE_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+|^\s*\d+:\d{2}\b")
_SHORT_HEAD_RE = re.compile(r"^#{1,6} ")
def _is_toc_block(block: str) -> bool:
    """A block made of bullets / timestamp links / tiny lines = nav junk."""
    lines = [l for l in block.splitlines() if l.strip()]
    if not lines or len(block) > 300:
        return False
    for l in lines:
        if _TOC_LINE_RE.match(l):
            continue
        if _SHORT_HEAD_RE.match(l) or len(l) < 60:
            continue
        return False
    return True
def bm25_scores(query: str, docs: list[str], k1: float = 1.5, b: float = 0.75) -> list[float]:
    n = len(docs)
    if n == 0:
        return []
    doc_toks = [tok(d) for d in docs]
    lens = [max(1, len(t)) for t in doc_toks]
    avgdl = sum(lens) / n
    df: collections.Counter = collections.Counter()
    for t in doc_toks:
        for w in set(t):
            df[w] += 1
    q = tok(query)
    if not q:
        return [0.0] * n
    scores = []
    for i, t in enumerate(doc_toks):
        tf = collections.Counter(t)
        s = 0.0
        for w in q:
            f = tf.get(w, 0)
            if not f:
                continue
            idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * lens[i] / avgdl))
        scores.append(s)
    return scores
_STOP = {
    "the", "a", "an", "and", "or", "to", "in", "of", "for", "on", "with", "at",
    "by", "from", "is", "it", "this", "that", "how", "what", "where", "can",
    "you", "my", "i", "do", "does", "me", "get", "best", "good",
}
def _dedupe_key(url: str) -> str:
    try:
        p = urlparse(url)
        path = p.path.rstrip("/")
        return f"{p.netloc.lower().replace('www.', '')}{path}"
    except Exception:
        return url
def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""
def _overlap(text: str, qt: set[str]) -> float:
    if not qt:
        return 1.0
    return len(qt & set(tok(text))) / len(qt)
