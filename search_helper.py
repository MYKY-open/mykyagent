#!/usr/bin/env python3
# /// script
# dependencies = [
#     "ddgs>=7.0.0",
#     "beautifulsoup4>=4.12.0",
#     "requests>=2.31.0",
# ]
# ///
import sys
import json
import requests
from bs4 import BeautifulSoup
from ddgs import DDGS

def search(query):
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=8))
            return [{"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")} for r in raw]
    except Exception as e:
        return [{"error": str(e)}]

def fetch(url):
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=25)
        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Extract direct download/file links first, prioritizing binary/archive links
        important_links = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if any(k in href.lower() for k in [".jar", "piston-data", ".tar", ".zip", ".gz", ".sh", "releases/download", "/download"]):
                important_links.append(f"- [{text}]({href})")
        important_links = list(dict.fromkeys(important_links))[:25]

        # Decompose non-content tags
        for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "svg"]):
            tag.decompose()

        # Format markdown tables
        for table in soup.find_all("table"):
            rows = []
            for tr in table.find_all("tr"):
                cells = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
                if cells:
                    rows.append("| " + " | ".join(cells) + " |")
            if rows:
                first_tr = table.find("tr")
                col_count = len(first_tr.find_all(["th", "td"])) if first_tr else 1
                sep = "| " + " | ".join(["---"] * col_count) + " |"
                table_md = "\n\n" + rows[0] + "\n" + sep + "\n" + "\n".join(rows[1:]) + "\n\n"
                table.replace_with(table_md)

        # Format code blocks so markdown retains code structure
        for pre in soup.find_all("pre"):
            code_text = pre.get_text()
            pre.replace_with(f"\n\n```\n{code_text}\n```\n\n")

        # Format headings
        for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
            htext = h.get_text(strip=True)
            if htext:
                level = int(h.name[1])
                h.replace_with(f"\n\n{'#' * level} {htext}\n\n")

        # Format list items
        for li in soup.find_all("li"):
            litext = li.get_text(strip=True)
            if litext:
                li.replace_with(f"\n- {litext}")

        # Format links
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if text and ("http" in href or href.endswith(".jar") or "download" in href):
                a.replace_with(f"[{text}]({href}) ")

        text = "\n".join([s for s in soup.stripped_strings if s])
        if len(text) > 50000:
            text = text[:50000] + "\n\n... [Content truncated at 50,000 characters]"

        if important_links:
            text = "Direct Download Links:\n" + "\n".join(important_links) + "\n\nContent:\n" + text

        return {"url": url, "text": text}
    except Exception as e:
        return {"url": url, "error": str(e)}

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: search_helper.py <search|fetch> <arg>"}))
        return
    mode = sys.argv[1]
    arg = sys.argv[2]
    if mode == "search":
        print(json.dumps(search(arg)))
    elif mode == "fetch":
        print(json.dumps(fetch(arg)))
    else:
        print(json.dumps({"error": f"Unknown mode: {mode}"}))

if __name__ == "__main__":
    main()
