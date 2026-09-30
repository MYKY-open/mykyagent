"""MykyAgent webresearch.helium — fetch via the user's real browser (CDP).

Why: headless Chromium (even hardened) eats bot-walls on shops like eBay;
a real profile-backed browser on a residential IP renders them fine
(proven live: 78 eBay listings + CZK prices through helium).

How: talk Chrome DevTools Protocol directly (no MCP round-trip, no new
deps beyond websocket-client). Every fetch opens a NEW BACKGROUND TAB,
reads, and closes it — the visible tab is never touched.

    MYKYAGENT_HELIUM=1      enable (default off: never hijack a browser unasked)
    MYKYAGENT_CDP_URL       CDP base (default http://127.0.0.1:9222)

Fail-soft everywhere: no browser / no ws lib / nav error -> None, caller
falls through to the next engine.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

from .config import dbg
from .html import html_to_markdown
from .blocks import select_blocks

HELIUM_ON = os.environ.get("MYKYAGENT_HELIUM") == "1"


def cdp_base() -> str:
    return os.environ.get("MYKYAGENT_CDP_URL", "http://127.0.0.1:9222").rstrip("/")


def cdp_reachable(base: str | None = None, timeout: int = 3) -> bool:
    """Is a debuggable browser listening? Cheap GET, never raises."""
    try:
        with urllib.request.urlopen(f"{(base or cdp_base())}/json/version", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _http_json(url: str, timeout: int = 10, method: str = "GET") -> dict | list | None:
    try:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        dbg(f"cdp http failed: {e}")
        return None


def new_tab(base: str) -> dict | None:
    """Open a background about:blank tab. Returns target info (with webSocketDebuggerUrl)."""
    info = _http_json(f"{base}/json/new?about:blank", method="PUT")
    return info if isinstance(info, dict) and info.get("webSocketDebuggerUrl") else None


def close_tab(base: str, target_id: str) -> None:
    try:
        _http_json(f"{base}/json/close/{target_id}", timeout=5)
    except Exception:
        pass


class Cdp:
    """Minimal sync CDP session (send cmd, await matching id)."""

    def __init__(self, ws_url: str, timeout: int = 30):
        import websocket  # guarded: caller checks first
        self._ws = websocket.create_connection(ws_url, timeout=timeout)
        self._id = 0

    def call(self, method: str, params: dict | None = None, timeout: int = 30) -> dict:
        import select as _select
        self._id += 1
        mid = self._id
        self._ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return {"error": "cdp timeout"}
            r, _, _ = _select.select([self._ws.sock], [], [], left)
            if not r:
                return {"error": "cdp timeout"}
            try:
                msg = json.loads(self._ws.recv())
            except Exception:
                continue
            if msg.get("id") == mid:
                return msg.get("result", {})
            # else: event broadcast — ignore

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:
            pass


def settle_pred(lengths: list[int], min_len: int = 200) -> bool:
    """Pure: True when the last 3 samples are equal and non-trivial."""
    return len(lengths) >= 3 and lengths[-1] == lengths[-2] == lengths[-3] and lengths[-1] >= min_len


def helium_fetch(url: str, query: str | None = None, budget: int = 12000,
                 enum_mode: bool = False, nav_timeout: int = 25) -> dict | None:
    """Full fetch through a background helium tab. Dict or None (fail-soft)."""
    try:
        import websocket  # noqa: F401
    except ImportError:
        dbg("helium: websocket-client missing (add to search_helper.py deps)")
        return None
    base = cdp_base()
    if not cdp_reachable(base):
        return None
    target = new_tab(base)
    if not target:
        return None
    cdp = Cdp(target["webSocketDebuggerUrl"])
    html = ""
    try:
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        nav = cdp.call("Page.navigate", {"url": url}, timeout=nav_timeout + 5)
        if nav.get("errorText"):
            return None
        # settle: poll rendered-text length until stable (async listings)
        lengths: list[int] = []
        t0 = time.monotonic()
        while (time.monotonic() - t0) * 1000 < 12000:
            r = cdp.call("Runtime.evaluate",
                         {"expression": "document.body ? document.body.innerText.length : 0",
                          "returnByValue": True}, timeout=10)
            try:
                lengths.append(int(((r.get("result") or {}).get("value")) or 0))
            except Exception:
                break
            if settle_pred(lengths):
                break
            time.sleep(0.5)
        r = cdp.call("Runtime.evaluate",
                     {"expression": "document.documentElement.outerHTML",
                      "returnByValue": True}, timeout=15)
        try:
            html = ((r.get("result") or {}).get("value")) or ""
        except Exception:
            html = ""
    except Exception as e:
        dbg(f"helium fetch failed: {e}")
        return None
    finally:
        try:
            cdp.close()
        except Exception:
            pass
        close_tab(base, target.get("id", ""))
    if len(html) < 1000:
        return None
    text, links, title = html_to_markdown(html, url)
    text = select_blocks(text, query, budget, enum_mode)
    if len(text.strip()) < 200:
        return None
    return {"url": url, "text": text, "links": links, "title": title, "browser": "helium"}


def helium_unit() -> list[dict]:
    checks: list[dict] = []

    def ck(name, cond, extra=""):
        checks.append({"name": name, "ok": bool(cond), "extra": "" if cond else str(extra)})

    ck("settle stable triple", settle_pred([10, 300, 300, 300]) is True)
    ck("settle rejects short", settle_pred([50, 50, 50]) is False)
    ck("settle rejects changing", settle_pred([100, 500, 300, 300]) is False)
    ck("settle needs 3 samples", settle_pred([500, 500]) is False)
    ck("cdp off16 unreachable fast", cdp_reachable("http://127.0.0.1:9", timeout=1) is False)
    ck("helium gate defaults off", HELIUM_ON is False or os.environ.get("MYKYAGENT_HELIUM") == "1")
    ck("cdp base default", cdp_base() == os.environ.get("MYKYAGENT_CDP_URL", "http://127.0.0.1:9222").rstrip("/"))
    return checks
