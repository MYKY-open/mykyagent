#!/usr/bin/env python3
# /// script
# dependencies = [
#     "ddgs>=7.0.0",
#     "beautifulsoup4>=4.12.0",
#     "requests>=2.31.0",
#     "playwright>=1.47.0",
#     "pypdf>=4.0.0",
# ]
# ///
"""
MykyAgent search helper — v2

    search   <query>                single-engine SERP, cached, domain-prior ranked
    fetch    <url> [query]          one page -> distilled markdown
    research <query>                full pipeline (fan-out -> APIs -> fetch -> rerank)

Pipeline
    fan-out SERP  ->  RRF fusion  ->  structured API providers  ->  domain priors
    ->  parallel fetch (status/type validated)  ->  BM25 + section-context block
    selection  ->  near-duplicate collapse  ->  bounded bundle

Guarantees
    * Every HTTP response is status- and content-type-validated (no more 504 pages
      surfacing as "research content").
    * ONE chunking pass per document. The old code chunked at extract, then chunked
      the chunk again, silently dropping good blocks.
    * Hard internal deadline (default 75s, env MYKYAGENT_SEARCH_DEADLINE). Always
      emits valid JSON, even on partial/browser failure.
    * Results are relevance-ranked, not "top 4 unique domains in DDG order".
    * Disk cache: SERP 1h, pages 24h -> repeat queries are near-instant and we stop
      tripping DuckDuckGo rate limits.
    * Web text is emitted as untrusted data; the caller fences it before it reaches
      a model.

Env knobs
    MYKYAGENT_SEARCH_DEADLINE   seconds, default 75
    MYKYAGENT_NO_BROWSER=1      disable Playwright entirely
    MYKYAGENT_NO_APIS=1         disable structured API providers
    MYKYAGENT_CACHE_DIR         default ~/.cache/mykyagent
    MYKYAGENT_DEBUG=1           progress to stderr
"""

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

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

START = time.monotonic()
DEADLINE_S = float(os.environ.get("MYKYAGENT_SEARCH_DEADLINE", "75"))
NO_BROWSER = os.environ.get("MYKYAGENT_NO_BROWSER") == "1"
NO_APIS = os.environ.get("MYKYAGENT_NO_APIS") == "1"
DEBUG = os.environ.get("MYKYAGENT_DEBUG") == "1"

CACHE_DIR = Path(
    os.environ.get("MYKYAGENT_CACHE_DIR", str(Path.home() / ".cache" / "mykyagent"))
).expanduser()
CACHE_DB = CACHE_DIR / "search.db"

# Independent indexes, ordered by observed reliability. Each variant is
# assigned one, then falls back through the rest, so a single throttled engine
# (DuckDuckGo throttles in bursts) cannot take the whole search down.
BACKEND_CHAIN = ["duckduckgo", "bing", "yahoo", "mojeek", "brave", "google"]

# Backends that already failed in this process. Avoids every variant re-walking
# the same dead engines within a single run.
_bad_backends: dict[str, float] = {}
_bad_lock = threading.Lock()

# Engines already consumed in this run. DuckDuckGo in particular serves roughly
# one query and then throttles hard, so variants are spread one-per-engine
# before any engine is reused.
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
# Recency questions must not be answered from a day-old cache.
SERP_TTL_FRESH = 300
PAGE_TTL_FRESH = 900

CONNECT_TIMEOUT = 5
READ_TIMEOUT = 15
MAX_HTML_BYTES = 3_000_000
HARD_TEXT_CAP = 300_000
# Per-page character budget handed to the summariser. This is the single
# biggest lever on token spend. The distillation subagent is a cheap,
# high-context model, so feed it whole sections, full code blocks and complete
# tables -- it does the distilling, not the window-cutter.
PAGE_BUDGET = int(os.environ.get("MYKYAGENT_PAGE_BUDGET", "12000"))
# Enumerative questions need whole tables, but paying 3x for every page is
# wasteful. Extra allowance applies to table blocks only.
TABLE_EXTRA = int(os.environ.get("MYKYAGENT_TABLE_EXTRA", "2600"))
# When there is no query to rank blocks against (an explicit web_fetch of a
# URL), a tiny head cut tends to return the intro and table of contents
# rather than the answer. The model asked for this page by name, so give it
# enough of the page to be worth the fetch.
NO_QUERY_BUDGET = int(os.environ.get("MYKYAGENT_NO_QUERY_BUDGET", "8000"))
# Cap on a JSON API response passed through verbatim.
JSON_BUDGET = int(os.environ.get("MYKYAGENT_JSON_BUDGET", "6000"))

UA_BROWSER = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)

# Domains we trust for technical answers, and blog-farm domains we distrust.
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

# Hosts whose pages cannot be read without a logged-in JS app. Snippets may
# surface them but the fetched content is an empty shell.
_WALL_HOSTS = (
    "twitter.com",
    "x.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "threads.net",
    "threads.com",
)

# Commercial hosting companies and tutorial farms dominate page 1 for any
# "how do I make X faster" query while carrying almost no real information.
# These get a hard penalty, not a filter, so they still surface if nothing
# better exists.
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


# ---------------------------------------------------------------------------
# Query intent
#
# Three classes that a plain keyword pipeline handles badly:
#   navigational - the query names its own source ("artificial analysis leaderboard")
#   recency      - the answer is "what changed recently", not "what is true"
#   enumerative  - the answer is a table, which a small per-page budget truncates
# ---------------------------------------------------------------------------

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


def dbg(*a) -> None:
    if DEBUG:
        print("[search_helper]", *a, file=sys.stderr, flush=True)


def remaining() -> float:
    return DEADLINE_S - (time.monotonic() - START)


def out_of_time(reserve: float = 5.0) -> bool:
    return remaining() <= reserve


# ---------------------------------------------------------------------------
# Disk cache
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

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


# Search-operator tokens a summariser may sprinkle into a followup query
# ("site:news OR site:twitter.com"). They mean something to the SERP engine but
# poison ranking: the operator payloads become "query words" and a page titled
# "twitter.com releases" then scores as a perfect match.
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


# ---------------------------------------------------------------------------
# HTML -> markdown  (single pass, no query-aware truncation)
# ---------------------------------------------------------------------------

_BOILER_PAT = re.compile(
    r"(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|header|comment|comments|"
    r"promo|promotion|advert|ads|ad-|sponsor|cookie|consent|breadcrumb|pagination|"
    r"social|share|newsletter|subscribe|related-posts|recommend|toolbar|masthead|"
    r"skip-link|banner)([-_ ]|$)",
    re.I,
)

_DL_EXT = (
    ".jar", ".zip", ".tar", ".gz", ".tgz", ".xz", ".7z", ".deb", ".rpm",
    ".appimage", ".exe", ".msi", ".dmg", ".whl", ".iso", ".pkg", ".apk",
)
_DL_HINT = (
    "releases/download", "/download", "/releases/latest", "piston-data",
    "objects.githubusercontent.com", "files.pythonhosted.org", "cdn.",
)


def _absolutize(href: str, base: str) -> str:
    if not href:
        return ""
    href = href.strip()
    if href.startswith(("javascript:", "mailto:", "tel:", "#", "data:")):
        return ""
    if href.startswith("//"):
        return "https:" + href
    return urljoin(base, href)


_BOM_ENCODINGS = (
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)
_HEADER_CHARSET_RE = re.compile(r"charset\s*=\s*[\"']?([\w.:-]+)", re.I)
_META_CHARSET_RE = re.compile(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([\w.:-]+)", re.I)


def _decode_html(raw: bytes, content_type: str = "") -> str:
    """Decode an HTML byte string to text using the best available signal.

    This matters more than it looks. `requests` reports ISO-8859-1 for any
    `text/html` response without an explicit charset parameter, because that is
    the RFC 2616 default - so `raw.decode(resp.encoding)` silently mojibakes
    every page that declares its charset only in a <meta> tag. 'Cafe\u0301' becomes
    'Caf\u00c3\u00a9'; Japanese becomes garbage.

    Order: BOM, then the raw HTTP header, then the <meta> tag, then UTF-8, then
    Latin-1 as a last resort that can never fail.
    """
    if not raw:
        return ""

    for bom, enc in _BOM_ENCODINGS:
        if raw.startswith(bom):
            try:
                return raw.decode(enc, errors="replace")
            except LookupError:
                break

    m = _HEADER_CHARSET_RE.search(content_type or "")
    if m:
        try:
            return raw.decode(m.group(1), errors="replace")
        except (LookupError, UnicodeDecodeError):
            pass

    m = _META_CHARSET_RE.search(raw[:4096])  # covers <meta charset> and http-equiv
    if m:
        try:
            return raw.decode(m.group(1).decode("ascii", "ignore"), errors="replace")
        except (LookupError, UnicodeDecodeError):
            pass

    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="replace")


def html_to_markdown(html: str, url: str) -> tuple[str, list[str], str]:
    """Return (markdown, direct_download_links, title). One shot, no chunking here."""
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return "", [], ""

    # --- page title ---------------------------------------------------------
    # Grab it before stripping, otherwise <title> leaks in as a bare first line
    # of the body: a wasted token on every fetch and a useless "title".
    title = ""
    t_el = soup.find("title")
    if t_el is not None:
        title = t_el.get_text(" ", strip=True)
    if not title:
        h1 = soup.find("h1")
        if h1 is not None:
            title = h1.get_text(" ", strip=True)
    title = re.sub(r"\s+", " ", title).strip()[:200]

    # --- direct download / resource links (before any stripping) -------------
    links: list[str] = []
    seen_links: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = _absolutize(a["href"], url)
        if not href:
            continue
        low = href.lower()
        label = a.get_text(" ", strip=True)[:80]
        if any(k in low for k in _DL_HINT) or any(low.endswith(e) for e in _DL_EXT):
            entry = f"- [{label or href.split('/')[-1]}]({href})"
            if entry not in seen_links:
                seen_links.add(entry)
                links.append(entry)
    links = links[:20]

    # --- drop structural noise ---------------------------------------------
    for tag in soup(
        ["script", "style", "noscript", "svg", "iframe", "video", "canvas",
         "form", "button", "input", "select", "textarea", "template", "title",
         "nav", "footer", "aside"]
    ):
        tag.decompose()

    # Class/id heuristic. Two hard guards, because a naive version of this
    # deletes the whole document on sites like Wikipedia (whose <html> element
    # carries classes such as "vector-feature-language-in-main-menu-disabled").
    total_chars = len(soup.get_text(" ", strip=True)) or 1
    for tag in soup.find_all(["div", "section", "ul", "ol", "span", "p"]):
        attrs = getattr(tag, "attrs", None)
        if not attrs:
            continue
        ident = " ".join(
            filter(None, [attrs.get("id") or "", " ".join(attrs.get("class") or [])])
        )
        if not ident or not _BOILER_PAT.search(ident):
            continue
        # Guard: a container holding a large share of the text is never boilerplate.
        if len(tag.get_text(" ", strip=True)) > total_chars * 0.4:
            continue
        try:
            tag.decompose()
        except Exception:
            pass

    # --- narrow to main content container when one is obvious ---------------
    main = (
        soup.find("article")
        or soup.find(attrs={"role": "main"})
        or soup.find("main")
        or soup.find(id=re.compile(r"^(content|main|body|article)", re.I))
    )
    body_chars = len(soup.get_text(" ", strip=True))
    if main is not None:
        main_chars = len(main.get_text(" ", strip=True))
        if main_chars >= max(400, body_chars * 0.35):
            soup = BeautifulSoup(str(main), "html.parser")

    # --- code blocks (survive everything) ----------------------------------
    for pre in soup.find_all("pre"):
        code = pre.get_text()
        if len(code.strip()) < 2:
            pre.decompose()
            continue
        lang = ""
        ctag = pre.find("code")
        if ctag is not None:
            for cls in (getattr(ctag, "attrs", None) or {}).get("class") or []:
                if cls.startswith("language-"):
                    lang = cls.split("-", 1)[1]
                    break
        pre.replace_with(f"\n\n```{lang}\n{code.rstrip()}\n```\n\n")

    # --- tables -------------------------------------------------------------
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
            if any(cells):
                rows.append("| " + " | ".join(cells) + " |")
        if not rows:
            table.decompose()
            continue
        first_tr = table.find("tr")
        ncol = len(first_tr.find_all(["th", "td"])) if first_tr else 1
        sep = "| " + " | ".join(["---"] * max(1, ncol)) + " |"
        md = "\n\n" + rows[0] + "\n" + sep + "\n" + "\n".join(rows[1:]) + "\n\n"
        table.replace_with(md)

    # --- headings -----------------------------------------------------------
    for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
        text = h.get_text(" ", strip=True)
        if not text:
            h.decompose()
            continue
        h.replace_with(f"\n\n{'#' * int(h.name[1])} {text}\n\n")

    # --- list items ---------------------------------------------------------
    for li in soup.find_all("li"):
        text = li.get_text(" ", strip=True)
        li.replace_with(f"\n- {text}" if text else "")

    # --- inline links -------------------------------------------------------
    for a in soup.find_all("a", href=True):
        href = _absolutize(a["href"], url)
        text = a.get_text(" ", strip=True)
        if text and href:
            a.replace_with(f"[{text}]({href}) ")

    text = "\n".join(s for s in soup.stripped_strings if s)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if title:
        # The <title> is very often repeated verbatim as the first heading.
        first, _, rest = text.partition("\n")
        if re.sub(r"^#+\s*", "", first).strip() == title:
            text = rest.lstrip()
    if len(text) > HARD_TEXT_CAP:
        text = text[:HARD_TEXT_CAP]

    return text, links, title


# ---------------------------------------------------------------------------
# Block selection: BM25 + section-context inheritance
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

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


# Diagnostic/technical questions want post-mortems, RCA documents and deep
# docs -- the brand homepage's marketing hero text only crowds them out. When
# this matches, navigational boosting must skip shallow promo paths and only
# reward deep subpaths (blog posts, docs, advisories) on the named domain.
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


# ---------------------------------------------------------------------------
# Structured API providers  (exact data instead of scraping HTML)
# ---------------------------------------------------------------------------

def _api_json(url: str, timeout: int = 6):
    try:
        text, ct, _ = http_get(url, accept_json=True, timeout=(4, timeout))
        return json.loads(text)
    except Exception as e:
        dbg("api miss", url, e)
        return None


_GH_URL = re.compile(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")
_MOD_URL = re.compile(r"modrinth\.com/(?:mod|plugin|datapack|shader|resourcepack|modpack)/([A-Za-z0-9_.-]+)")
_PYPI_URL = re.compile(r"pypi\.org/project/([A-Za-z0-9_.-]+)")
_NPM_URL = re.compile(r"npmjs\.com/package/((?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+)")


def prov_github(urls: list[str], limit: int = 1, query: str = "") -> list[dict]:
    qt = {w for w in tok(query) if w not in _STOP}
    cands: list[str] = []
    seen: set[str] = set()
    for u in urls:
        m = _GH_URL.search(u)
        if not m:
            continue
        repo = f"{m.group(1)}/{m.group(2)}"
        repo = repo.split("/releases")[0].split("/issues")[0].split("/pull")[0].rstrip("/")
        if repo in seen:
            continue
        seen.add(repo)
        cands.append(repo)

    # Prefer the repo the query is actually about, not merely the first URL
    # that happened to appear in the SERP.
    cands.sort(
        key=lambda r: _overlap(r.replace("/", " ").replace("-", " ").replace("_", " "), qt),
        reverse=True,
    )

    out: list[dict] = []
    for repo in cands[: max(limit, 1)]:
        data = _api_json(f"https://api.github.com/repos/{repo}/releases?per_page=3")
        if isinstance(data, list) and data:
            entries = []
            for rel in data[:3]:
                entries.append(
                    {
                        "tag": rel.get("tag_name"),
                        "name": rel.get("name"),
                        "published": (rel.get("published_at") or "")[:10],
                        "prerelease": rel.get("prerelease"),
                        "assets": [
                            {
                                "name": a.get("name"),
                                "url": a.get("browser_download_url"),
                                "size": a.get("size"),
                            }
                            for a in (rel.get("assets") or [])[:6]
                        ],
                    }
                )
            out.append({"kind": "github_releases", "repo": repo, "releases": entries})
            continue

        # Many projects publish no GitHub Releases at all (NeoForge, Paper,
        # anything Maven/Docker-distributed). Fall back to tags so the caller
        # still gets real version strings instead of a guess.
        tags = _api_json(f"https://api.github.com/repos/{repo}/tags?per_page=8")
        if isinstance(tags, list) and tags:
            out.append(
                {
                    "kind": "github_tags",
                    "repo": repo,
                    "latest": tags[0].get("name"),
                    "tags": [t.get("name") for t in tags[:8]],
                    "note": "no GitHub Releases; tags only",
                }
            )
    return out


_MAVEN_VER = re.compile(r"<version>([^<]+)</version>")


def prov_maven_neoforge(query: str) -> list[dict]:
    """NeoForge ships via Maven, not GitHub Releases. This is the real source."""
    base = "https://maven.neoforged.net/releases/net/neoforged/neoforge"
    try:
        xml, _ct, _st = http_get(f"{base}/maven-metadata.xml", timeout=(4, 10))
    except Exception as e:
        dbg("neoforge maven failed:", e)
        return []
    vers = _MAVEN_VER.findall(xml)
    if not vers:
        return []

    # Honour a version prefix in the query ("neoforge 21.1" -> 21.1.x)
    pref = re.search(r"\b(\d+\.\d+)\b", query)
    pool = [v for v in vers if v.startswith(pref.group(1) + ".")] if pref else vers
    if not pool:
        pool = vers

    def numkey(v: str) -> tuple:
        return tuple(int(x) for x in re.findall(r"\d+", v))

    pool.sort(key=numkey)
    latest = pool[-1]
    return [
        {
            "kind": "maven",
            "artifact": "net.neoforged:neoforge",
            "version_prefix": pref.group(1) if pref else None,
            "latest": latest,
            "matching": len(pool),
            "recent": pool[-6:],
            "installer_url": f"{base}/{latest}/neoforge-{latest}-installer.jar",
            "checksums_url": f"{base}/{latest}/neoforge-{latest}-installer.jar.sha1",
            "install_hint": f"java -jar neoforge-{latest}-installer.jar --installServer",
            "metadata_url": f"{base}/maven-metadata.xml",
        }
    ]


def prov_github_search(query: str, limit: int = 3) -> list[dict]:
    # Keyword query, not the raw sentence: GitHub's relevance model is lexical.
    kws = [w for w in tok(query) if w not in _STOP and len(w) > 2]
    q = " ".join(kws[:6]) or re.sub(r"[^\w\s.-]", " ", query).strip()
    data = _api_json(
        f"https://api.github.com/search/repositories?q={requests.utils.quote(q)}"
        f"&sort=stars&order=desc&per_page={limit}"
    )
    if not isinstance(data, dict) or not data.get("items"):
        return []
    # Low-star repos matching loose keywords are noise, not answers. A floor
    # keeps the provider high-precision.
    items = [it for it in data["items"][:limit] if (it.get("stargazers_count") or 0) >= 20]
    if not items:
        return []
    return [
        {
            "kind": "github_repo",
            "full_name": it.get("full_name"),
            "url": it.get("html_url"),
            "stars": it.get("stargazers_count"),
            "description": (it.get("description") or "")[:200],
            "updated": (it.get("pushed_at") or "")[:10],
        }
        for it in items
    ]


def prov_modrinth(query: str, limit: int = 2) -> list[dict]:
    q = re.sub(r"[^\w\s.-]", " ", query).strip()
    data = _api_json(
        f"https://api.modrinth.com/v2/search?limit={limit}&query={requests.utils.quote(q)}"
    )
    if not isinstance(data, dict) or not data.get("hits"):
        return []
    out = []
    for hit in data["hits"][:limit]:
        out.append(
            {
                "kind": "modrinth_project",
                "title": hit.get("title"),
                "slug": hit.get("slug"),
                "url": f"https://modrinth.com/project/{hit.get('slug')}",
                "downloads": hit.get("downloads"),
                "description": (hit.get("description") or "")[:200],
                "versions": hit.get("versions", [])[-3:] if hit.get("versions") else [],
            }
        )
    return out


def prov_pypi(urls: list[str]) -> list[dict]:
    out, seen = [], set()
    for u in urls:
        m = _PYPI_URL.search(u)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        d = _api_json(f"https://pypi.org/pypi/{m.group(1)}/json")
        if not isinstance(d, dict):
            continue
        info = d.get("info", {})
        out.append(
            {
                "kind": "pypi",
                "name": info.get("name"),
                "version": info.get("version"),
                "requires_python": info.get("requires_python"),
                "summary": (info.get("summary") or "")[:200],
                "home": info.get("home_page") or info.get("project_url"),
            }
        )
    return out


def prov_npm(urls: list[str]) -> list[dict]:
    out, seen = [], set()
    for u in urls:
        m = _NPM_URL.search(u)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        d = _api_json(f"https://registry.npmjs.org/{requests.utils.quote(m.group(1), safe='@/')}/latest")
        if not isinstance(d, dict):
            continue
        out.append(
            {
                "kind": "npm",
                "name": d.get("name"),
                "version": d.get("version"),
                "description": (d.get("description") or "")[:200],
                "homepage": d.get("homepage"),
            }
        )
    return out


_FACTUAL = re.compile(r"\b(who|what|when|where|which|why|define|definition|meaning|is|are)\b", re.I)


def prov_wikipedia(query: str) -> list[dict]:
    # Same trap as the SERP engines: the Wikipedia search API returns nothing
    # useful for a 200-char sentence. Reduce to content keywords first.
    q = re.sub(r"\b(who|what|when|where|is|are|the|a|an)\b", " ", serp_keywords(query, cap=10), flags=re.I).strip()
    if len(q) < 2:
        return []
    d = _api_json(
        f"https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch="
        f"{requests.utils.quote(q)}&format=json&srlimit=1"
    )
    try:
        title = d["query"]["search"][0]["title"]
    except Exception:
        return []
    s = _api_json(
        f"https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(title)}"
    )
    if not isinstance(s, dict) or not s.get("extract"):
        return []
    return [
        {
            "kind": "wikipedia",
            "title": s.get("title"),
            "url": (s.get("content_urls", {}).get("desktop", {}) or {}).get("page"),
            "extract": s["extract"][:600],
        }
    ]


# Community-intent meta words. They describe WHERE/WANT, not WHAT: Reddit
# titles never repeat them, searching for them pollutes the corpus query, and
# counting them in relevance overlap inflates the denominator until relevant
# threads fall below threshold. Strip before talking to reddit providers.
_META_TERM_RE = re.compile(
    r"\b(reddit|community|consensus|opinions?|reviews?|sentiment|"
    r"thoughts?|experiences?|recommend\w*|worth it|hype|complain\w*|"
    r"gotchas?|pitfalls?)\b",
    re.I,
)


def _strip_meta_terms(query: str) -> str:
    """Remove community-intent meta words, keeping the actual topic words."""
    return re.sub(r"\s+", " ", _META_TERM_RE.sub(" ", query)).strip()


def _reddit_pullpush(query: str, limit: int) -> list[dict]:
    """Fallback via the PullPush mirror (PushShift successor).

    reddit.com's JSON endpoints hard-403 many datacenter/hosting IPs, but this
    public mirror serves the same submission corpus without auth.
    """
    d = _api_json(
        "https://api.pullpush.io/reddit/search/submission/?"
        f"q={requests.utils.quote(query)}&size={max(6, limit * 3)}"
        "&sort=desc&sort_type=score"
    )
    if not isinstance(d, dict):
        return []
    out: list[dict] = []
    for d2 in d.get("data") or []:
        pid, sub = d2.get("id") or "", d2.get("subreddit") or ""
        if not pid or not sub:
            continue
        out.append(
            {
                "kind": "reddit",
                "url": f"https://www.reddit.com/r/{sub}/comments/{pid}/",
                "title": (d2.get("title") or "").strip(),
                "subreddit": sub,
                "ups": int(d2.get("score") or 0),
                "comments": int(d2.get("num_comments") or 0),
                "excerpt": (d2.get("selftext") or "").strip()[:1500],
            }
        )
    return out


def prov_reddit(query: str, limit: int = 3) -> list[dict]:
    """Reddit search via public JSON APIs.

    The HTML site is Cloudflare-walled for scrapers, but the JSON search
    endpoint (or the PullPush mirror when reddit 403s the IP) still answers.
    Gives high-signal developer discussion for community-sentiment /
    migration-gotcha questions that SEO listicles would otherwise crowd out.
    """
    # Meta words ("... reddit", "community consensus on ...") must not reach
    # the corpus query: Reddit would rank posts literally containing them.
    q = _strip_meta_terms(query) or query
    items: list[dict] = []
    try:
        r = session().get(
            "https://www.reddit.com/search.json",
            params={"q": q, "limit": max(6, limit * 3), "sort": "relevance", "t": "year"},
            headers={"User-Agent": "MykyAgent/1.0 (technical research agent)"},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        if r.status_code == 200:
            for c in ((r.json() or {}).get("data") or {}).get("children") or []:
                d = c.get("data") or {}
                permalink = d.get("permalink") or ""
                if not permalink:
                    continue
                items.append(
                    {
                        "kind": "reddit",
                        "url": "https://www.reddit.com" + permalink,
                        "title": (d.get("title") or "").strip(),
                        "subreddit": d.get("subreddit") or "",
                        "ups": int(d.get("score") or 0),
                        "comments": int(d.get("num_comments") or 0),
                        "excerpt": (d.get("selftext") or "").strip()[:1500],
                    }
                )
        else:
            dbg(f"reddit provider: HTTP {r.status_code}, trying PullPush mirror")
    except Exception as e:
        dbg("reddit provider failed:", e)
    if not items:
        try:
            items = _reddit_pullpush(q, limit)
        except Exception as e:
            dbg("pullpush fallback failed:", e)
            return []
    # Engagement-weighted: an upvoted thread with an active comment section
    # carries far more community signal than a stale lonely post.
    items.sort(key=lambda it: it["ups"] + 3 * it["comments"], reverse=True)
    return items[:limit]


_CVE_RE = re.compile(r"\bCVE-\d{4}-\d{4,}\b", re.I)


def prov_osv(query: str, limit: int = 3) -> list[dict]:
    """OSV.dev advisory lookup for explicit CVE IDs in the query.

    Returns exact affected/fixed version ranges straight from the advisory
    database -- authoritative security ground truth with zero scraping.
    """
    ids: list[str] = []
    for m in _CVE_RE.finditer(query):
        up = m.group(0).upper()
        if up not in ids:
            ids.append(up)
    ids = ids[:limit]
    out: list[dict] = []
    for vuln_id in ids:
        try:
            d = _api_json(f"https://api.osv.dev/v1/vulns/{vuln_id}")
            if not isinstance(d, dict) or not d.get("id"):
                continue
            fixed: list[str] = []
            for aff in d.get("affected") or []:
                pkg = ((aff.get("package") or {}).get("name") or "").strip()
                for rng in aff.get("ranges") or []:
                    for ev in rng.get("events") or []:
                        if ev.get("fixed"):
                            fixed.append(f"{pkg}: fixed in {ev['fixed']}" if pkg else f"fixed in {ev['fixed']}")
            summary = (d.get("summary") or "").strip()
            details = (d.get("details") or "").strip()
            out.append(
                {
                    "kind": "osv",
                    "url": f"https://osv.dev/vulnerability/{vuln_id}",
                    "title": f"{vuln_id}: {summary}" if summary else vuln_id,
                    "excerpt": details[:2000],
                    "fixed": fixed[:10],
                    "aliases": [a for a in (d.get("aliases") or []) if isinstance(a, str)][:5],
                }
            )
        except Exception as e:
            dbg(f"osv provider failed for {vuln_id}:", e)
    return out


def prov_stackexchange(query: str, limit: int = 2) -> list[dict]:
    # SE relevance collapses on natural-language questions; feed it keywords only.
    kws = [w for w in tok(query) if w not in _STOP and len(w) > 2]
    q = " ".join(kws[:8]) or re.sub(r"[^\w\s.-]", " ", query).strip()
    d = _api_json(
        "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance"
        f"&q={requests.utils.quote(q)}&site=stackoverflow&pagesize={limit}&filter=withbody"
    )
    if not isinstance(d, dict) or not d.get("items"):
        return []
    out = []
    for it in d["items"][:limit]:
        body = re.sub(r"<[^>]+>", " ", it.get("body") or "")
        body = re.sub(r"\s+", " ", body).strip()
        out.append(
            {
                "kind": "stackoverflow",
                "title": (it.get("title") or "").replace("&quot;", '"'),
                "url": it.get("link"),
                "score": it.get("score"),
                "answered": it.get("is_answered"),
                "excerpt": body[:400],
            }
        )
    return out


def gather_providers(query: str, urls: list[str], nav_hint: str | None = None,
                     recency_hint: bool = False) -> dict:
    """Best-effort structured providers. Never blocks the pipeline."""
    if NO_APIS:
        return {}
    low = query.lower()
    tech_intent = bool(
        re.search(
            r"\b(github|release|download|install|library|cli|mod|plugin|tool|sdk|"
            r"api|python|rust|java|javascript|typescript|node|docker|package|"
            r"optimiz\w*|performance|benchmark|tuning|config\w*|server)\b",
            low,
        )
    )
    mc_intent = bool(re.search(r"\b(minecraft|neoforge|forge|fabric|modpack|mod)\b", low))
    version_intent = bool(
        re.search(r"\b(download|install|release|version|latest|update|setup|jar|build|binary)\b", low)
    )
    so_intent = bool(
        re.search(
            r"\b(error|exception|traceback|stacktrace|crash|fail|fails|failing|"
            r"fix|fixed|issue|problem|bug|denied|refused|timeout|not working)\b",
            low,
        )
    )
    community_intent = bool(
        re.search(
            r"\b(reddit|community|consensus|opinions?|reviews?|sentiment|"
            r"thoughts|experiences?|recommend\w*|worth it|hype|complain\w*|"
            r"gotchas?|pitfalls?)\b",
            low,
        )
    )
    osv_intent = bool(_CVE_RE.search(low))

    jobs = {
        "github_releases": lambda: prov_github(urls, query=query),
        "pypi": lambda: prov_pypi(urls),
        "npm": lambda: prov_npm(urls),
    }
    if (tech_intent or mc_intent) and remaining() > 20:
        jobs["github_search"] = lambda: prov_github_search(query)
    if mc_intent and remaining() > 20:
        jobs["modrinth"] = lambda: prov_modrinth(query)
        # Maven metadata is a version/download source, not a general Minecraft
        # source -- don't drag NeoForge builds into "how do I speed up my server".
        if version_intent:
            jobs["neoforge_maven"] = lambda: prov_maven_neoforge(query)
    if so_intent and remaining() > 20:
        jobs["stackoverflow"] = lambda: prov_stackexchange(query)
    if community_intent and remaining() > 20:
        jobs["reddit"] = lambda: prov_reddit(query)
    if osv_intent and remaining() > 20:
        jobs["osv"] = lambda: prov_osv(query)
    # An encyclopaedia summary is useless for "what changed on this site lately"
    # and costs two sequential API calls.
    if _FACTUAL.search(query) and not recency_hint and not nav_hint and remaining() > 20:
        jobs["wikipedia"] = lambda: prov_wikipedia(query)

    found: dict = {}
    ex = ThreadPoolExecutor(max_workers=min(6, len(jobs)))
    try:
        futs = {ex.submit(fn): name for name, fn in jobs.items()}
        budget = max(2.0, min(12.0, remaining() * 0.18))
        try:
            for f in as_completed(futs, timeout=budget):
                name = futs[f]
                try:
                    r = f.result()
                    if r:
                        found[name] = r
                except Exception:
                    pass
        except TimeoutError:
            # A single slow provider must never abort the whole research run.
            dbg("provider phase hit its budget; keeping what finished")
    finally:
        ex.shutdown(wait=False, cancel_futures=True)

    # Maven metadata is authoritative for NeoForge. Its GitHub tags are decoys
    # (v99.99, v8.99, ...), so never let the tag fallback contradict the Maven answer.
    if "neoforge_maven" in found and "github_releases" in found:
        kept = [it for it in found["github_releases"] if it.get("kind") != "github_tags"]
        if kept:
            found["github_releases"] = kept
        else:
            found.pop("github_releases", None)

    return found


def provider_hit_urls(structured: dict) -> list[str]:
    urls = []
    for v in structured.values():
        if isinstance(v, list):
            for it in v:
                if isinstance(it, dict) and it.get("url"):
                    urls.append(it["url"])
    return urls


def _overlap(text: str, qt: set[str]) -> float:
    if not qt:
        return 1.0
    return len(qt & set(tok(text))) / len(qt)


def _filter_structured(structured: dict, query: str) -> dict:
    """Drop provider hits that do not actually relate to the query.

    Relevance is computed on *identity* fields only (titles, repo names,
    package names) -- never on long body excerpts, which otherwise let an
    unrelated high-score question pass on incidental word overlap.
    """
    qt = {w for w in tok(query) if w not in _STOP}
    # Community meta words ("reddit", "community", ...) never appear in Reddit
    # titles but inflate the overlap denominator, so relevant threads land
    # right on (or below) the threshold. Judge reddit items on topic words only.
    meta_qt = {w for w in tok(_strip_meta_terms(query)) if w not in _STOP}
    # name -> (identity fields, min overlap). Wikipedia is excluded because its
    # own search API already ranked relevance and titles are single words.
    fields: dict[str, tuple[tuple[str, ...], float]] = {
        "stackoverflow": (("title",), 0.5),
        "github_search": (("full_name", "description"), 0.4),
        "modrinth": (("title", "slug", "description"), 0.5),
        "reddit": (("title", "subreddit"), 0.4),
    }
    out: dict = {}
    for name, items in structured.items():
        if not isinstance(items, list):
            continue
        spec = fields.get(name)
        keep = []
        for it in items:
            if not isinstance(it, dict):
                continue
            if spec and qt:
                keys, thresh = spec
                blob = " ".join(str(it.get(k) or "") for k in keys)
                use_qt = meta_qt if (name == "reddit" and meta_qt) else qt
                # A fixed fraction over a variable-length denominator is
                # length-biased: a title cannot contain 40% of a 12-token
                # question, so long specific queries get good hits rejected.
                # Relax the fraction for long queries so the absolute match
                # requirement saturates (~2 tokens); short queries keep the
                # original strictness unchanged.
                eff = thresh * min(1.0, 4.0 / len(use_qt))
                if _overlap(blob, use_qt) < eff:
                    continue
            keep.append(it)
        if keep:
            out[name] = keep
    return out


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def _is_js_gated(html: str, text: str) -> bool:
    low = (text or "").strip().lower()
    if len(low) < 250:
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
) -> dict:
    """Fetch one URL.

    Returns {url,text,links,title[,browser][,cached,age_s][,final_url]} or
    {url,error}. Cache hits report their age so a caller can tell a fresh fetch
    from a day-old copy; `_fresh` bypasses the cache read entirely.
    """
    eff_budget = budget if query else max(budget, NO_QUERY_BUDGET)

    hit = None if _fresh else cache_get_age("page", url, ttl)
    if hit:
        ck, age = hit
        if query is None or ck.get("_q") == query:
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

        if _is_js_gated(html, text) and not NO_BROWSER and not out_of_time(8):
            br = _fetch_browser(
                url, query, browser=_browser, budget=eff_budget, enum_mode=enum_mode
            )
            if br.get("text") and len(br["text"]) > len(text):
                res = {
                    "url": url,
                    "text": br["text"],
                    "links": links,
                    "title": br.get("title") or title,
                    "browser": True,
                    **extra,
                }
                cache_put("page", url, {**res, "_q": query})
                return res

        text = select_blocks(text, query, eff_budget, enum_mode)
        res = {"url": url, "text": text, "links": links, "title": title, **extra}
        cache_put("page", url, {**res, "_q": query})
        return res
    except Exception as e:
        return {"url": url, "error": str(e)}


# ---------------------------------------------------------------------------
# Playwright fallback
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Research
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Selftest: regression harness. Run after any change to the pipeline.
# ---------------------------------------------------------------------------

SELFTEST_CASES = [
    {"q": "neoforge 21.1 latest version download", "api": "neoforge_maven",
     "want": ["installer.jar"], "domains": ["maven.neoforged.net"]},
    {"q": "python asyncio TaskGroup timeout example", "domains": ["docs.python.org"]},
    {"q": "what is the ZGC garbage collector", "want": ["zgc"],
     "domains": ["oracle.com", "openjdk.org"]},
    {"q": "fix nginx 502 bad gateway upstream", "api": "stackoverflow", "want": ["502"]},
    {"q": "how do i make my minecraft server faster", "want": ["minecraft"]},
    {"q": "rust cargo workspace dependency version", "want": ["cargo"]},
    {"q": "kubernetes ingress controller comparison", "want": ["ingress"]},
    # --- the classes the original suite was blind to ------------------------
    # navigational + recency + requested field (dates)
    {"q": "what are the current new models on the artificial analysis leaderboard",
     "nav": "artificialanalysis.ai", "has_dates": True, "no_field_warnings": True},
    # navigational, short form
    {"q": "artificial analysis leaderboard", "nav": "artificialanalysis.ai"},
    # enumerative (needs whole tables)
    {"q": "compare nginx and traefik as kubernetes ingress controller",
     "want": ["traefik"], "min_pages": 3},
    # version field on a recency query
    {"q": "latest kubernetes release version", "want": ["kubernetes"], "min_pages": 2},
]


def unit() -> dict:
    """Offline assertions for the intent/field/nav/conflict heuristics. No network."""
    checks: list[dict] = []

    def ck(name: str, cond, extra="") -> None:
        checks.append({"name": name, "ok": bool(cond), "extra": "" if cond else str(extra)})

    # --- intent detection --------------------------------------------------
    ck("recency: 'currently new models'", RECENCY_RE.search("what are currently new models"))
    ck("recency: 'latest release'", RECENCY_RE.search("latest release of x"))
    ck("recency: clean on how-to", not RECENCY_RE.search("how do i sort a list in python"))
    ck("enum: leaderboard", ENUM_RE.search("artificial analysis leaderboard"))
    ck("enum: comparison", ENUM_RE.search("compare nginx vs traefik"))
    ck("enum: clean on error query", not ENUM_RE.search("fix nginx 502 bad gateway upstream"))

    # --- asked fields ------------------------------------------------------
    ck("fields: 'new' asks for date", "date" in asked_fields("what models are new"))
    ck("fields: 'latest version' asks version", "version" in asked_fields("neoforge latest version download"))
    ck("fields: 'leaderboard scores' asks score", "score" in asked_fields("artificial analysis leaderboard scores"))
    ck("fields: error query asks nothing", asked_fields("fix nginx 502 bad gateway upstream") == set(), asked_fields("fix nginx 502 bad gateway upstream"))

    # --- field presence ----------------------------------------------------
    ck("date: '13 Sept 2026'", field_present("date", "Added 13 Sept 2026 - K2 Horizon"))
    ck("date: 'September 4, 2026'", field_present("date", "released September 4, 2026"))
    ck("date: ISO", field_present("date", "2026-09-13 update"))
    ck("date: absent", not field_present("date", "no timestamps at all here"))
    ck("version: present", field_present("version", "latest is 21.1.250"))
    ck("version: absent", not field_present("version", "no numbers here"))

    # --- navigational ------------------------------------------------------
    navres = [
        {"url": "https://aichangelog.dev/changelog"},
        {"url": "https://artificialanalysis.ai/leaderboards/models"},
        {"url": "https://ai-analysis.ai/changelog"},
    ]
    q_nav = "what are the new models on artificial analysis leaderboard"
    ck(
        "nav: 'artificial analysis' -> artificialanalysis.ai",
        nav_host(q_nav, navres) == "artificialanalysis.ai",
        nav_host(q_nav, navres),
    )
    ck(
        "nav: explicit domain in query wins",
        nav_host("check artificialanalysis.ai for new models", navres) == "artificialanalysis.ai",
        nav_host("check artificialanalysis.ai for new models", navres),
    )
    ck(
        "nav: no false positive on error query",
        nav_host("how to fix nginx 502 bad gateway upstream", navres) is None,
        nav_host("how to fix nginx 502 bad gateway upstream", navres),
    )

    # --- charset decoding ---------------------------------------------------
    # requests reports ISO-8859-1 for text/html with no charset parameter, which
    # used to mojibake every page declaring its charset only in <meta>.
    fr = "Caf\u00e9 na\u00efve".encode("utf-8")
    ck("charset: no header charset still decodes utf-8", _decode_html(fr, "text/html") == "Caf\u00e9 na\u00efve", _decode_html(fr, "text/html"))
    ck("charset: explicit header honoured", _decode_html(fr, "text/html; charset=utf-8") == "Caf\u00e9 na\u00efve")
    ck("charset: latin-1 header honoured", _decode_html("Caf\u00e9".encode("latin-1"), "text/html; charset=iso-8859-1") == "Caf\u00e9")
    ck("charset: quoted header value", _decode_html(fr, 'text/html; charset="utf-8"') == "Caf\u00e9 na\u00efve")
    ck("charset: <meta charset> honoured", _decode_html(b'<meta charset="utf-8">' + fr, "text/html").endswith("Caf\u00e9 na\u00efve"))
    ck(
        "charset: <meta http-equiv> honoured",
        _decode_html(b'<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' + fr, "text/html").endswith("Caf\u00e9 na\u00efve"),
    )
    ck("charset: utf-8 BOM stripped", _decode_html(b"\xef\xbb\xbfhi", "text/html") == "hi")
    ck("charset: header beats meta", _decode_html("caf\u00e9".encode("latin-1"), "text/html; charset=latin-1") == "caf\u00e9")
    ck("charset: invalid utf-8 does not raise", _decode_html(b"\xff\xfe\xfa", "text/html") != "")
    ck("charset: empty input", _decode_html(b"", "text/html") == "")
    ck("charset: json-ish plain text", _decode_html(b'{"a":"\xc3\xa9"}', "application/json") == '{"a":"\u00e9"}')

    # --- block-aware truncation when there is no query to rank against ------
    doc = "First paragraph here.\n\nSecond paragraph here.\n\n```py\ncode_here()\n```\n\nTAIL that must be dropped."
    ck("head_blocks: never exceeds budget", len(head_blocks(doc, 60)) <= 60, len(head_blocks(doc, 60)))
    ck("head_blocks: keeps whole blocks", "TAIL" not in head_blocks(doc, 60), repr(head_blocks(doc, 60)))
    ck("head_blocks: short input untouched", head_blocks("tiny", 100) == "tiny")
    ck("head_blocks: empty input", head_blocks("", 100) == "")
    ck("head_blocks: zero budget", head_blocks("abc", 0) == "")

    # --- operator stripping -------------------------------------------------
    ck("clean_q: strips site: operators", clean_q('dhh "wolves" reaction site:news OR site:twitter.com') == 'dhh "wolves" reaction', clean_q('dhh "wolves" reaction site:news OR site:twitter.com'))
    ck("clean_q: strips bare OR/AND/NOT", clean_q("hypergamy OR marriage NOT twitter") == "hypergamy marriage twitter", clean_q("hypergamy OR marriage NOT twitter"))
    ck("clean_q: keeps plain query", clean_q("best python orm 2026") == "best python orm 2026")
    ck("clean_q: inurl/intitle too", clean_q("foo inurl:admin intitle:login") == "foo", clean_q("foo inurl:admin intitle:login"))
    ck("clean_q: empty", clean_q("") == "")

    # --- TOC-skipping head fallback -----------------------------------------
    _toc_bullets = "\n\n".join(f"- {n}. Chapter number {n}" for n in range(1, 40))
    _toc_body = "Real prose body text about dating apps and coupling. " * 30
    toc_doc = (
        "# Transcript for a Show\nThis is a transcript of a show.\n\n"
        + "## Contents\n" + _toc_bullets
        + "\n\n## Chapter 1\n" + _toc_body
    )
    skipped = head_blocks(toc_doc, 600, skip_nav=True)
    ck("head_blocks skip_nav: drops leading ToC", "Chapter number 12" not in skipped and "dating apps" in skipped, skipped[:200])
    plain = head_blocks(toc_doc, 600)
    ck("head_blocks plain: keeps top of doc", "Contents" in plain or "Transcript" in plain, plain[:120])
    ck("head_blocks skip_nav: short doc untouched", head_blocks("tiny doc", 600, skip_nav=True) == "tiny doc")
    toc_only = "# Title\n\n" + "\n\n".join(f"- item {n}" for n in range(30)) + "\n\n" + "body " * 40
    ck("head_blocks skip_nav: never strips everything", len(head_blocks(toc_only, 50, skip_nav=True)) > 0)

    # --- oversized-block window cut -----------------------------------------
    giant = "Contents\n" + "\n".join(f"- {n}. filler heading" for n in range(1, 60)) + "\n" + (
        "Talk about programming and agents. " * 40
        + "Now we discuss dating apps and traditional marriage. " * 20
        + "More programming filler text here. " * 40
    )
    sel = select_blocks(giant, "dating apps traditional marriage", 300)
    ck("window cut: lands on matching region", "dating apps" in sel, repr(sel[:120]))
    sel2 = select_blocks("no overlap at all with query", "dating apps marriage", 100)
    ck("window cut: no-query-token block still returns text", len(sel2) > 0, repr(sel2))

    # --- wall-host penalty ---------------------------------------------------
    ck("prior: twitter penalised", _prior("https://twitter.com/releases") <= -4.0, _prior("https://twitter.com/releases"))
    ck("prior: x.com penalised", _prior("https://x.com/dhh/status/123") <= -4.0, _prior("https://x.com/dhh/status/123"))
    ck("prior: normal host untouched", _prior("https://example.com/post") == 0.0, _prior("https://example.com/post"))
    big_code = "```\n" + "\n".join(f"line{i:03d}" for i in range(200)) + "\n```"
    hb = head_blocks(big_code, 200)
    ck("head_blocks: oversized block cut on a line break", len(hb) <= 200 and hb.endswith(tuple("0123456789")), repr(hb[-20:]))
    ck("select_blocks: no query defers to head_blocks", select_blocks(doc, None, 60) == head_blocks(doc, 60))

    # --- title --------------------------------------------------------------
    md, _lk, ti = html_to_markdown(
        "<html><head><title>My Page</title></head><body><p>Body text long enough to survive.</p></body></html>",
        "https://x.test/",
    )
    ck("title: extracted from <title>", ti == "My Page", ti)
    ck("title: does not leak into the body", "My Page" not in md, repr(md[:60]))
    ck("title: body survives", "Body text" in md, repr(md[:80]))
    _md, _lk, ti2 = html_to_markdown("<html><body><h1>Only H1</h1><p>Text.</p></body></html>", "https://x.test/")
    ck("title: falls back to <h1>", ti2 == "Only H1", ti2)
    _md, _lk, ti3 = html_to_markdown("<html><body><p>No title at all.</p></body></html>", "https://x.test/")
    ck("title: empty when absent", ti3 == "")
    md4, _lk, ti4 = html_to_markdown(
        "<html><head><title>Dup</title></head><body><h1>Dup</h1><p>Body.</p></body></html>", "https://x.test/"
    )
    ck("title: verbatim repeat of first heading dropped", md4 == "Body.", repr(md4))
    md5, _lk, _t5 = html_to_markdown(
        "<html><head><title>T</title></head><body><h1>Caf\u00e9 na\u00efve</h1><p>Body.</p></body></html>", "https://x.test/"
    )
    ck("title: distinct heading is kept", md5.startswith("# Caf\u00e9"), repr(md5[:40]))
    # Regression: a single generic query word must not hijack a squatter domain.
    sq = [
        {"url": "https://nginx.org/en/docs/"},
        {"url": "https://doc.traefik.io/traefik/"},
        {"url": "https://kubernetes.ae/"},
        {"url": "https://kubernetes.io/docs/"},
    ]
    q_sq = "compare nginx and traefik as kubernetes ingress controller"
    ck("nav: generic single word does not hijack (kubernetes.ae)", nav_host(q_sq, sq) is None, nav_host(q_sq, sq))
    ck(
        "nav: multi-word brand still detected",
        nav_host("what is new on the artificial analysis leaderboard", navres) == "artificialanalysis.ai",
        nav_host("what is new on the artificial analysis leaderboard", navres),
    )

    # --- cross-source conflicts -------------------------------------------
    pgs = [
        {"url": "https://a.com/x", "content": "Claude Fable 5.1 scored 65.7 on the index."},
        {"url": "https://b.com/y", "content": "Claude Fable 5.1 scored 53.4 on the index."},
    ]
    cf = detect_conflicts(pgs)
    ck("conflict: detects Claude Fable 5.1", any("Claude Fable" in c["entity"] for c in cf), cf)
    ck("conflict: single source is not a conflict", detect_conflicts([pgs[0]]) == [])
    ck(
        "conflict: same value twice is not a conflict",
        detect_conflicts(
            [
                {"url": "https://a.com/x", "content": "Zeta 9 scored 40.0 on the index."},
                {"url": "https://b.com/y", "content": "Zeta 9 scored 40.0 on the index."},
            ]
        )
        == [],
    )

    # --- domain priors -----------------------------------------------------
    ck("prior: hosting farm penalised", _prior("https://wisehosting.com/blog/x") < 0)
    ck(
        "prior: first-party docs beat generic",
        _prior("https://docs.oracle.com/en/java/x") > _prior("https://randomblog.example.com/x"),
    )

    passed = sum(1 for c in checks if c["ok"])
    return {
        "checks": len(checks),
        "passed": passed,
        "failed": [c for c in checks if not c["ok"]],
    }


def selftest() -> dict:
    results = []
    for idx, case in enumerate(SELFTEST_CASES):
        if idx:
            time.sleep(1.5)  # pace the run; search engines throttle bursts hard
        t0 = time.monotonic()
        try:
            r = research(case["q"])
        except Exception as e:
            r = {"error": f"{type(e).__name__}: {e}"}

        blob = json.dumps(r).lower()
        urls = " ".join(
            list(r.get("direct_urls") or [])
            + [p.get("url", "") for p in (r.get("pages") or [])]
        ).lower()

        checks: dict[str, bool] = {}
        if case.get("api"):
            checks[f"api={case['api']}"] = case["api"] in (r.get("structured") or {})
        if case.get("domains"):
            # Any-of semantics: different engines legitimately surface different
            # (equally authoritative) sources for the same question.
            checks["any_domain"] = any(d.lower() in urls for d in case["domains"])
        for s in case.get("want", []):
            checks[f"text={s}"] = s.lower() in blob
        if case.get("nav"):
            checks[f"nav={case['nav']}"] = r.get("nav_domain") == case["nav"]
        if case.get("min_pages"):
            checks[f"pages>={case['min_pages']}"] = len(r.get("pages") or []) >= case["min_pages"]
        if case.get("has_dates"):
            combined = " ".join(p.get("content", "") for p in (r.get("pages") or []))
            checks["has_dates"] = bool(DATE_RE.search(combined))
        if case.get("no_field_warnings"):
            checks["no_missing_field_warning"] = not any(
                "not found in fetched sources" in w for w in (r.get("warnings") or [])
            )

        err = r.get("error") or ""
        # Engine exhaustion is an environment condition, not a pipeline defect.
        # Report it as skipped so the score stays meaningful.
        skipped = "rate limited" in err or "unreachable" in err
        passed = bool(checks) and all(checks.values()) and not err

        results.append(
            {
                "query": case["q"],
                "pass": passed and not skipped,
                "skipped": skipped,
                "checks": checks,
                "pages": len(r.get("pages") or []),
                "ms": int((time.monotonic() - t0) * 1000),
                "error": err or None,
            }
        )

    scored = [x for x in results if not x["skipped"]]
    ok = sum(1 for x in scored if x["pass"])
    return {
        "cases": len(results),
        "passed": ok,
        "skipped": len(results) - len(scored),
        "failed": sum(1 for x in scored if not x["pass"]),
        "score": round(ok / max(1, len(scored)), 3),
        "results": results,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {"error": "Usage: search_helper.py <search|fetch|research|selftest|unit> <arg> [query]"}
            )
        )
        return

    mode, arg = sys.argv[1], sys.argv[2]
    try:
        if mode == "search":
            res = fused_search(arg, max_results=10)[0]
            print(json.dumps(res))
        elif mode == "fetch":
            rest = [a for a in sys.argv[3:] if a != "--fresh"]
            q = rest[0] if rest else None
            print(json.dumps(fetch(arg, q, _fresh="--fresh" in sys.argv[3:])))
        elif mode == "research":
            print(json.dumps(research(arg)))
        elif mode == "selftest":
            print(json.dumps(selftest()))
        elif mode == "unit":
            print(json.dumps(unit()))
        else:
            print(json.dumps({"error": f"Unknown mode: {mode}"}))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
