"""MykyAgent webresearch package.

Split of the original search_helper.py monolith into modules:

    config    env knobs, budgets, domain priors, backend dead-cache, dbg/clock
    cache     sqlite disk cache (SERP 1h, pages 24h)
    http      per-thread requests.Session + validated http_get
    text      tokenize/stem/BM25 + shared pures (_STOP, _overlap, _domain, ...)
    html      charset-aware decode + html_to_markdown
    blocks    BM25 block select / TOC / table budgets / windowing
    rank      intent regexes, domain priors, nav-host, recency probes, conflicts
    serp      original multi-engine fan-out (ddgs) + RRF fused_search
    providers structured APIs (GitHub/Modrinth/PyPI/npm/Maven/Wiki/Reddit/OSV/SO)
    fetchmod  static fetch + Playwright browser fetch + PDF + consolidate
    pipeline  research() full pipeline (default = original behavior)
    backends  EXPERIMENTAL alternatives (searxng serp, trafilatura, jina, batch)
    cli       unit/selftest/main entry points

Default behavior is byte-identical to the original monolith; alternatives
are env-gated (see backends.py) so experiments never disturb the default.
"""
from .pipeline import research
from .fetchmod import fetch
from .serp import fused_search
from .cli import unit, selftest

__all__ = ["research", "fetch", "fused_search", "unit", "selftest"]
