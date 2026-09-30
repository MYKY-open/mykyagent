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

"""MykyAgent webresearch.http — split from search_helper.py (verbatim moves)."""

from .config import CONNECT_TIMEOUT, MAX_HTML_BYTES, READ_TIMEOUT, UA_BROWSER

_tls = threading.local()
def session() -> requests.Session:
    """One requests.Session per thread — sharing one across a pool is not safe."""
    s = getattr(_tls, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update(
            {
                "User-Agent": UA_BROWSER,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        try:
            from requests.adapters import HTTPAdapter
            from urllib3.util.retry import Retry

            retry = Retry(
                total=1,
                backoff_factor=0.4,
                status_forcelist=(429, 500, 502, 503, 504),
                allowed_methods=frozenset(["GET"]),
                respect_retry_after_header=True,
            )
            ad = HTTPAdapter(
                pool_connections=8, pool_maxsize=8, max_retries=retry
            )
            s.mount("https://", ad)
            s.mount("http://", ad)
        except Exception:
            pass
        _tls.s = s
    return s
def http_get(url: str, *, accept_json: bool = False, timeout: tuple | None = None):
    """GET with validation. Returns (text, content_type, status) or raises."""
    hdrs = {}
    if accept_json:
        hdrs = {"Accept": "application/json"}
    r = session().get(
        url,
        timeout=timeout or (CONNECT_TIMEOUT, READ_TIMEOUT),
        headers=hdrs,
        allow_redirects=True,
        stream=True,
    )
    try:
        ct = (r.headers.get("content-type") or "").lower()
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} for {url}")
        raw = r.raw.read(MAX_HTML_BYTES + 1, decode_content=True)
        if len(raw) > MAX_HTML_BYTES:
            raw = raw[:MAX_HTML_BYTES]
        enc = r.encoding or r.apparent_encoding or "utf-8"
        try:
            text = raw.decode(enc, errors="replace")
        except Exception:
            text = raw.decode("utf-8", errors="replace")
        return text, ct, r.status_code
    finally:
        r.close()
