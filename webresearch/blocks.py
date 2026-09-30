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

"""MykyAgent webresearch.blocks — split from search_helper.py (verbatim moves)."""

from .config import TABLE_EXTRA
from .text import _SHORT_HEAD_RE, _STOP, _TOC_LINE_RE, _is_toc_block, bm25_scores, tok

_NAV_JUNK = (
    "you signed in with another tab",
    "reload to refresh your session",
    "you signed out in another tab",
    "log in](",
    "sign up](",
    "redirect_after_login",
    "clone via https",
    "dismiss alert",
    "skip to content",
    "we use cookies",
    "accept all cookies",
    "enable javascript and cookies",
    "javascript is disabled",
)
def split_blocks(text: str) -> list[str]:
    parts = re.split(r"(```[\s\S]*?```)", text)
    blocks: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if part.startswith("```"):
            blocks.append(part)
        else:
            blocks.extend(
                s.strip() for s in re.split(r"\n{2,}", part) if s.strip()
            )
    return blocks
def _split_toc_prefix(block: str) -> list[str]:
    """Giant single blocks (transcripts, dumps) often START with a ToC/nav run.

    A 250KB podcast transcript is one block because the body uses single
    newlines. Cut the leading ToC/nav lines so BM25 and the window cut see the
    actual content instead of "1. Introduction ... 24. Politics".
    """
    if len(block) <= 8000:
        return [block]
    lines = block.split("\n")
    i = 0
    while i < len(lines) and (
        _TOC_LINE_RE.match(lines[i])
        or _SHORT_HEAD_RE.match(lines[i])
        or len(lines[i]) < 60
    ):
        i += 1
    rest = "\n".join(lines[i:])
    if not i or len(rest) < 500:
        return [block]
    return [rest]
def _window_cut(block: str, query: str, budget: int) -> str:
    """Cut an oversized block at the best query-matching window, not the start.

    Podcast transcripts, giant issue dumps and scraped one-block pages put a
    navigation/ToC prefix in the same block as the body. A naive
    `block[:budget]` then returns the ToC every time. Sliding a budget-sized
    window over the block and keeping the one with the highest query-token
    overlap lands the cut inside the region that actually answers the query.
    """
    if len(block) <= budget:
        return block
    qt = {w for w in tok(query) if w not in _STOP}
    if not qt:
        return block[:budget]
    step = max(1, budget // 4)
    best, best_off = -1.0, 0
    for off in range(0, len(block) - budget + 1, step):
        win = set(tok(block[off : off + budget]))
        sc = len(qt & win) / len(qt)
        if sc > best:
            best, best_off = sc, off
        if best >= 0.999:
            break
    return block[best_off : best_off + budget]
def head_blocks(text: str, budget: int, skip_nav: bool = False) -> str:
    """Keep whole blocks from the top of the document until the budget is full.

    Used when there is no query to rank against. A raw `text[:budget]` cut lands
    mid-sentence or halfway through a code fence, which is both ugly and lossy.

    With skip_nav=True (BM25 fallback on a long doc), leading table-of-contents
    and nav blocks are dropped first. Filling the budget with "1. Introduction
    ... 24. Politics and immigration" links tells the summariser nothing and
    reads as a failed extraction.
    """
    if not text or budget <= 0:
        return ""
    if len(text) <= budget:
        return text

    if skip_nav and len(text) > budget * 2:
        blocks = split_blocks(text)
        total = len(text)
        skipped = 0
        i = 0
        while i < len(blocks) and skipped < total * 0.6:
            if _is_toc_block(blocks[i]):
                skipped += len(blocks[i]) + 2
                i += 1
            else:
                break
        # Keep a reasonable remainder; never strip everything.
        rest = "\n\n".join(blocks[i:]) if i else ""
        if i and i < len(blocks) and len(rest) >= max(300, budget * 0.4):
            text = rest

    out: list[str] = []
    used = 0
    for b in split_blocks(text):
        if out and used + len(b) + 2 > budget:
            # A block that does not fit is normally dropped whole. But after a
            # skip_nav strip the remainder is often one giant prose wall (a
            # podcast transcript body is a single block) -- dropping it would
            # leave only headings. Cut an oversized block to fill the budget.
            room = budget - used
            if len(b) > budget * 0.5 and room >= 120:
                cut = b[:room]
                nl = cut.rfind("\n")
                out.append(cut[:nl] if nl > 100 else cut)
            break
        out.append(b)
        used += len(b) + 2

    joined = "\n\n".join(out).strip() or text
    if len(joined) > budget:
        # One oversized block (usually a single code fence): cut on a line
        # break -- but only if the break is deep inside the budget. A doc like
        # "heading\n\ngiant-one-line-body" would otherwise cut at the heading
        # boundary and discard the entire body.
        cut = joined[:budget]
        nl = cut.rfind("\n")
        joined = cut[:nl] if nl > budget * 0.5 else cut
    return joined.strip()
def select_blocks(text: str, query: str | None, budget: int, enum_mode: bool = False) -> str:
    """Rank blocks by BM25 with heading-context inheritance, greedily fill budget."""
    if not text:
        return ""
    if not query:
        return head_blocks(text, budget)

    blocks = split_blocks(text)
    if not blocks:
        return ""

    clean: list[str] = []
    for b in blocks:
        low = b.lower()
        if not b.startswith("```") and any(j in low for j in _NAV_JUNK):
            continue
        clean.append(b)
    if not clean:
        clean = blocks

    # One giant block defeats BM25 (whole doc = one score) and the window cut
    # would land on its ToC prefix. Explode that prefix first.
    if any(len(b) > 8000 for b in clean):
        expanded: list[str] = []
        for b in clean:
            expanded.extend(_split_toc_prefix(b))
        clean = expanded

    base = bm25_scores(query, clean)
    if not any(base):
        # No lexical overlap at all: fall back to document order.
        return head_blocks(text, budget, skip_nav=True)

    max_base = max(base) or 1.0

    scored: list[tuple[float, int, str]] = []
    heading_score = 0.0
    for i, blk in enumerate(clean):
        is_heading = bool(re.match(r"^#{1,6} .+$", blk)) and "\n" not in blk
        is_code = blk.startswith("```")
        is_table = blk.startswith("| ") or ("\n| " in blk and "| ---" in blk)

        if is_heading:
            heading_score = max(0.0, base[i])

        # Section context: a code block under a matching heading inherits relevance.
        eff = base[i] + 0.6 * heading_score
        has_lex = base[i] > 0

        if not has_lex and not is_heading:
            if is_code and heading_score > 0:
                eff = 0.35 * heading_score
            elif is_table and heading_score > 0:
                eff = 0.3 * heading_score
            else:
                continue

        bonus = (0.30 if is_code else 0.15) * (eff / max_base)
        scored.append((eff + bonus, i, blk))

    if not scored:
        return head_blocks(text, budget, skip_nav=True)

    scored.sort(key=lambda x: x[0], reverse=True)

    picked: list[tuple[int, str]] = []
    used = 0
    table_used = 0
    for score, idx, blk in scored:
        is_table_blk = blk.startswith("| ") or "\n| " in blk
        # Tables answer enumerative questions, so they draw on a separate
        # allowance instead of crowding out the prose.
        if is_table_blk and enum_mode:
            if table_used + len(blk) > TABLE_EXTRA:
                continue
            table_used += len(blk)
            picked.append((idx, blk))
            continue

        if used + len(blk) > budget:
            room = budget - used
            if room < 220:
                continue
            blk = _window_cut(blk, query, room) + "\n…"
            used = budget
            picked.append((idx, blk))
            break
        picked.append((idx, blk))
        used += len(blk)
        if used >= budget - 60:
            break

    picked.sort(key=lambda x: x[0])
    return "\n\n".join(b for _, b in picked)
