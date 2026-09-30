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

"""MykyAgent webresearch.providers — split from search_helper.py (verbatim moves)."""

from .config import CONNECT_TIMEOUT, NO_APIS, READ_TIMEOUT, dbg, remaining
from .http import http_get, session
from .serp import serp_keywords
from .text import _STOP, _overlap, tok

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
