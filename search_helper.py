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
            raw = list(ddgs.text(query, max_results=4))
            return [{"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")} for r in raw]
    except Exception as e:
        return [{"error": str(e)}]

def fetch(url):
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=10)
        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Extract direct download/file links first, prioritizing binary/jar links
        jar_links = []
        other_links = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if ".jar" in href.lower() or "piston-data" in href.lower():
                jar_links.append(f"- [{text}]({href})")
            elif any(k in href.lower() for k in [".tar", ".zip", ".sh", "download", "/server"]):
                other_links.append(f"- [{text}]({href})")
        important_links = list(dict.fromkeys(jar_links + other_links))[:8]

        for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside"]):
            tag.decompose()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(strip=True)
            if text and ("http" in href or href.endswith(".jar") or "download" in href):
                a.replace_with(f"[{text}]({href}) ")
        text = " ".join(soup.stripped_strings)
        if len(text) > 3000:
            text = text[:3000] + "... [truncated]"

        if important_links:
            unique_links = list(dict.fromkeys(important_links))[:8]
            text = "Direct Download Links:\n" + "\n".join(unique_links) + "\n\nContent:\n" + text

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
