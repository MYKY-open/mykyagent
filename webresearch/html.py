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

"""MykyAgent webresearch.html — split from search_helper.py (verbatim moves)."""

from .config import HARD_TEXT_CAP

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
