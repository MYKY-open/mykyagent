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

"""MykyAgent webresearch.cache — split from search_helper.py (verbatim moves)."""

from .config import CACHE_DB, CACHE_DIR, PAGE_TTL, dbg

_cache_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
def _db() -> sqlite3.Connection | None:
    global _conn
    if _conn is not None:
        return _conn
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(CACHE_DB), check_same_thread=False, timeout=5)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute(
            "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, ts REAL, val TEXT)"
        )
        c.execute("DELETE FROM kv WHERE ts < ?", (time.time() - PAGE_TTL,))
        c.commit()
        _conn = c
        return c
    except Exception as e:  # cache is best-effort, never fatal
        dbg("cache unavailable:", e)
        return None
def _ck(kind: str, key: str) -> str:
    return f"{kind}:{hashlib.sha256(key.encode('utf-8', 'ignore')).hexdigest()[:40]}"
def cache_get(kind: str, key: str, ttl: int):
    c = _db()
    if c is None:
        return None
    try:
        with _cache_lock:
            row = c.execute(
                "SELECT ts, val FROM kv WHERE k = ?", (_ck(kind, key),)
            ).fetchone()
        if not row or time.time() - row[0] > ttl:
            return None
        return json.loads(row[1])
    except Exception:
        return None
def cache_get_age(kind: str, key: str, ttl: int):
    """Like cache_get, but also returns the entry's age in seconds.

    Callers that hand cached content to a model need to say how old it is;
    silently serving a 24h-old page for "check this page now" is worse than
    paying to re-fetch it.
    """
    c = _db()
    if c is None:
        return None
    try:
        with _cache_lock:
            row = c.execute(
                "SELECT ts, val FROM kv WHERE k = ?", (_ck(kind, key),)
            ).fetchone()
        if not row:
            return None
        age = time.time() - row[0]
        if age > ttl:
            return None
        return json.loads(row[1]), age
    except Exception:
        return None
def cache_put(kind: str, key: str, val) -> None:
    c = _db()
    if c is None:
        return
    try:
        blob = json.dumps(val, ensure_ascii=False)
        if len(blob) > 2_000_000:
            return
        with _cache_lock:
            c.execute(
                "INSERT OR REPLACE INTO kv (k, ts, val) VALUES (?,?,?)",
                (_ck(kind, key), time.time(), blob),
            )
            c.commit()
    except Exception:
        pass
