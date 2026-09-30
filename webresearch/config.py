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

"""MykyAgent webresearch.config — split from search_helper.py (verbatim moves)."""

from .text import _domain

START = time.monotonic()
DEADLINE_S = float(os.environ.get("MYKYAGENT_SEARCH_DEADLINE", "75"))
NO_BROWSER = os.environ.get("MYKYAGENT_NO_BROWSER") == "1"
FORCE_BROWSER = os.environ.get("MYKYAGENT_FORCE_BROWSER") == "1"
NO_APIS = os.environ.get("MYKYAGENT_NO_APIS") == "1"
DEBUG = os.environ.get("MYKYAGENT_DEBUG") == "1"
CACHE_DIR = Path(
    os.environ.get("MYKYAGENT_CACHE_DIR", str(Path.home() / ".cache" / "mykyagent"))
).expanduser()
CACHE_DB = CACHE_DIR / "search.db"
BACKEND_CHAIN = ["duckduckgo", "bing", "yahoo", "mojeek", "brave", "google"]
_bad_backends: dict[str, float] = {}
_bad_lock = threading.Lock()
_used_engines: set[str] = set()
_used_lock = threading.Lock()
def _backend_dead(name: str) -> bool:
    with _bad_lock:
        t = _bad_backends.get(name)
        return t is not None and time.time() - t < 900
def _mark_backend_dead(name: str) -> None:
    with _bad_lock:
        _bad_backends[name] = time.time()
def _engine_used(name: str) -> bool:
    with _used_lock:
        return name in _used_engines
def _mark_engine_used(name: str) -> None:
    with _used_lock:
        _used_engines.add(name)
def _reset_backends() -> None:
    """Clear per-run backend state so one throttled query cannot poison the
    rest of the process (a selftest run makes seven in a row)."""
    with _bad_lock:
        _bad_backends.clear()
    with _used_lock:
        _used_engines.clear()
SERP_TTL = 3600
PAGE_TTL = 86400
SERP_TTL_FRESH = 300
PAGE_TTL_FRESH = 900
CONNECT_TIMEOUT = 5
READ_TIMEOUT = 15
MAX_HTML_BYTES = 3_000_000
HARD_TEXT_CAP = 300_000
PAGE_BUDGET = int(os.environ.get("MYKYAGENT_PAGE_BUDGET", "12000"))
TABLE_EXTRA = int(os.environ.get("MYKYAGENT_TABLE_EXTRA", "2600"))
NO_QUERY_BUDGET = int(os.environ.get("MYKYAGENT_NO_QUERY_BUDGET", "8000"))
JSON_BUDGET = int(os.environ.get("MYKYAGENT_JSON_BUDGET", "6000"))
UA_BROWSER = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)
DOMAIN_BOOST = {
    "github.com": 3.0,
    "raw.githubusercontent.com": 3.0,
    "gitlab.com": 2.0,
    "docs.rs": 3.0,
    "readthedocs.io": 3.0,
    "developer.mozilla.org": 3.0,
    "docs.python.org": 3.0,
    "rust-lang.org": 2.5,
    "kernel.org": 2.5,
    "wikipedia.org": 1.5,
    "stackoverflow.com": 2.0,
    "stackexchange.com": 2.0,
    "serverfault.com": 2.0,
    "superuser.com": 2.0,
    "modrinth.com": 2.5,
    "neoforged.net": 2.5,
    "minecraftforge.net": 2.5,
    "pypi.org": 2.0,
    "npmjs.com": 2.0,
    "crates.io": 2.0,
    "archlinux.org": 2.0,
    "wiki.archlinux.org": 2.5,
    "huggingface.co": 2.0,
    "arxiv.org": 2.0,
}
DOMAIN_PENALTY = (
    "w3schools",
    "geeksforgeeks",
    "javatpoint",
    "tutorialspoint",
    "scaler.com",
    "simplilearn",
    "upgrad.com",
    "guru99",
    "quora.com",
    "pinterest.",
    "medium.com",
    "dev.to",
    "hashnode",
    "blogspot.",
    "wordpress.com",
    "linkedin.com",
    "facebook.com",
    "reddit.com",
)
_WALL_HOSTS = (
    "twitter.com",
    "x.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "threads.net",
    "threads.com",
)
FARM_HOSTS = (
    "hosting", "serverlist", "unanswered.", "scalacube", "shockbyte",
    "bisecthosting", "pebblehost", "ggservers", "mcprohosting", "hostinger",
    "a2hosting", "liquidweb", "siteground", "bluehost", "dreamhost",
    "hostgator", "namecheap", "kinsta", "greengeeks", "godaddy", "ionos",
    "ctekin", "advancedhosting", "fastahost", "gaminghost",
    "server.pro", "pterodactyl", "gaming4free", "silentcraft",
)
def _is_farm(url: str) -> bool:
    d = _domain(url)
    return any(f in d for f in FARM_HOSTS)
def dbg(*a) -> None:
    if DEBUG:
        print("[search_helper]", *a, file=sys.stderr, flush=True)
def remaining() -> float:
    return DEADLINE_S - (time.monotonic() - START)
def out_of_time(reserve: float = 5.0) -> bool:
    return remaining() <= reserve
