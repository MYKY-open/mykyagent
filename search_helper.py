#!/usr/bin/env python3
# /// script
# dependencies = [
#     "ddgs>=7.0.0",
#     "beautifulsoup4>=4.12.0",
#     "requests>=2.31.0",
#     "playwright>=1.47.0",
#     "pypdf>=4.0.0",
#     "websocket-client>=1.7.0",
# ]
# ///
"""
MykyAgent search helper — v3 (shim over webresearch/ package)

    search   <query>                single-engine SERP, cached, domain-prior ranked
    fetch    <url> [query]          one page -> distilled markdown
    research <query>                full pipeline (fan-out -> APIs -> fetch -> rerank)
    multi    <json-list>            research N queries concurrently, merged bundle

The original monolith now lives in webresearch/ (one concern per module);
default behavior is unchanged. Experimental alternatives live in
webresearch/backends.py and are env-gated so they never disturb the default:

    MYKYAGENT_SERP_BACKEND=searxng  SearXNG aggregate instead of ddgs fan-out
    MYKYAGENT_SEARXNG_URL           SearXNG base URL (default http://127.0.0.1:8888)
    MYKYAGENT_EXTRACTOR=trafilatura trafilatura first, builtin fallback (pip install trafilatura)
    MYKYAGENT_JINA_FALLBACK=1       r.jina.ai reader when static fetch yields nothing

Original env knobs still apply: MYKYAGENT_SEARCH_DEADLINE (75),
MYKYAGENT_NO_BROWSER=1, MYKYAGENT_NO_APIS=1, MYKYAGENT_CACHE_DIR,
MYKYAGENT_DEBUG=1, MYKYAGENT_PAGE_BUDGET, MYKYAGENT_MAX_HOPS (TS side).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from webresearch.cli import main

if __name__ == "__main__":
    main()
