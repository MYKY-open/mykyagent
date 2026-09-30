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

"""MykyAgent webresearch.cli — split from search_helper.py (verbatim moves)."""

from .blocks import head_blocks, select_blocks
from .fetchmod import _is_js_gated, fetch
from .html import _decode_html, html_to_markdown
from .pipeline import research
from .rank import DATE_RE, ENUM_RE, RECENCY_RE, _prior, asked_fields, detect_conflicts, field_present, nav_host
from .serp import fused_search
from .text import clean_q

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

    # --- js-gated detection ------------------------------------------------
    ck("js_gated: short text triggers browser", _is_js_gated("<html></html>", "short text"))
    ck("js_gated: rating safe stub triggers browser", _is_js_gated("<html></html>", "Softpedia Tool\nUser rating: safe\nDownload now"))
    ck("js_gated: clean substantive text does not trigger", not _is_js_gated("<html><body>" + "x" * 600 + "</body></html>", "A substantive technical article explaining details. " * 20))

    # --- experimental backends (pure, offline) ---------------------------------
    try:
        from .backends import backends_unit
        checks.extend(backends_unit())
    except Exception as e:
        checks.append({"name": "backends harness loads", "ok": False, "extra": str(e)})

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
def main() -> None:
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {"error": "Usage: search_helper.py <search|fetch|research|multi|selftest|unit> <arg> [query]"}
            )
        )
        return

    mode, arg = sys.argv[1], sys.argv[2]
    try:
        if mode == "search":
            res = fused_search(arg, max_results=10)[0]
            print(json.dumps(res))
        elif mode == "fetch":
            rest = [a for a in sys.argv[3:] if a not in ("--fresh", "--browser", "--force-browser")]
            q = rest[0] if rest else None
            force_br = "--browser" in sys.argv[3:] or "--force-browser" in sys.argv[3:]
            print(json.dumps(fetch(arg, q, _fresh="--fresh" in sys.argv[3:], force_browser=force_br)))
        elif mode == "research":
            print(json.dumps(research(arg)))
        elif mode == "multi":
            from .backends import research_batch
            queries = json.loads(arg)
            assert isinstance(queries, list) and queries, "multi needs a JSON list of queries"
            print(json.dumps(research_batch([str(q) for q in queries], research)))
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
