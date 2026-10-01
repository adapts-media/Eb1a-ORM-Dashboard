import sys
import os
import re
import json
import hashlib
import argparse
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright
from date_utils import parse_serp_date, extract_page_date

# Force UTF-8 encoding on Windows stdout & stderr
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(ROOT)
ENV_PATH = os.path.join(BACKEND_ROOT, ".env")

NAV_KEYWORDS = [
    "terms of service", "privacy policy", "careers", "about", "press", "contact",
    "languages", "quora home", "go back", "page not found", "error", "something went wrong",
    "searched everywhere", "wait a moment", "copyright", "just a moment", "security service",
    "protect against malicious bots", "verifies you are not a bot", "cloudflare", "login", "sign in", "sign up"
]

def parse_args():
    parser = argparse.ArgumentParser(description="Manual Quora Scraper (100% Real Live Data)")
    parser.add_argument("--keyword", type=str, default="eb1a", help="Search keyword")
    parser.add_argument("--url", type=str, default="", help="Custom Quora search or question URL")
    parser.add_argument("--limit", type=int, default=100, help="Max items to inspect")
    return parser.parse_args()

def load_serper_key() -> str:
    key = os.environ.get("SERPER_API_KEY", "")
    if key:
        return key
    if os.path.exists(ENV_PATH):
        try:
            with open(ENV_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("SERPER_API_KEY="):
                        return line.split("=", 1)[1].strip('"').strip("'")
        except Exception:
            pass
    return ""

def make_stable_id(prefix: str, text: str) -> str:
    """Generate a 100% deterministic hash ID across process runs."""
    h = hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]
    return f"{prefix}_{h}"

def is_valid_quora_text(text: str) -> bool:
    """Strict check to enforce English text and reject nav/error footers & Arabic script."""
    if not text or len(text.strip()) < 5:
        return False
    if re.search(r'[\u0600-\u06FF]', text):
        return False
    if not re.search(r'[a-zA-Z]', text):
        return False
    lower = text.lower()
    for kw in NAV_KEYWORDS:
        if kw in lower:
            return False
    return True

def extract_keyword_from_url(url: str) -> str:
    """Extract search keyword if given a search URL like /search?q=eb1aexperts.com"""
    try:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        if "q" in params and params["q"]:
            return params["q"][0]
    except Exception:
        pass
    return ""

def fetch_serper_quora_items(keyword: str, limit: int) -> list:
    serper_key = load_serper_key()
    if not serper_key:
        sys.stderr.write("SERPER_API_KEY not configured for Quora search.\n")
        return []

    clean_kw = keyword.strip() or "eb1a"
    search_queries = [
        f'site:quora.com "{clean_kw}"',
        f'site:quora.com {clean_kw}',
        f'quora "{clean_kw}"'
    ]

    items = []
    seen_urls = set()

    for query in search_queries:
        if len(items) >= limit:
            break

        try:
            url = "https://google.serper.dev/search"
            payload = json.dumps({"q": query}).encode("utf-8")
            headers = {
                "X-API-KEY": serper_key,
                "Content-Type": "application/json",
            }
            req = urllib.request.Request(url, data=payload, headers=headers)

            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                organics = data.get("organic", [])

                for org in organics:
                    link = org.get("link", "").split("?")[0].strip()
                    title = org.get("title", "").strip()
                    snippet = org.get("snippet", "").strip()

                    if not link or link in seen_urls:
                        continue
                    if "quora.com" not in link and "quora" not in title.lower():
                        continue

                    # Filter out nav pages / TOS / login
                    if any(path in link.lower() for path in ["/about", "/careers", "/contact", "/tos", "/privacy", "/login", "/signup"]):
                        continue
                    if not is_valid_quora_text(title) and not is_valid_quora_text(snippet):
                        continue

                    seen_urls.add(link)
                    p_id = make_stable_id("quora_post", link)

                    clean_title = re.sub(r"\s*-\s*Quora$", "", title, flags=re.IGNORECASE).strip()
                    full_text = f"{clean_title}\n\n{snippet}" if clean_title and snippet and clean_title not in snippet else (snippet or clean_title)

                    pub_date = parse_serp_date(org.get("date"), snippet)

                    post_item = {
                        "type": "post",
                        "id": p_id,
                        "platform": "quora",
                        "text": full_text,
                        "title": clean_title or snippet[:100],
                        "url": link,
                        "author": "Quora Contributor",
                        "authorUrl": None,
                        "publishedAt": pub_date,
                        "likes": 0,
                        "shares": 0,
                        "commentsCount": 1 if snippet else 0,
                        "comments": []
                    }

                    if snippet and len(snippet) > 20:
                        c_id = make_stable_id("quora_comment", f"{p_id}::{snippet}")
                        post_item["comments"].append({
                            "type": "comment",
                            "id": c_id,
                            "postId": p_id,
                            "text": snippet,
                            "url": link,
                            "author": "Quora Answer",
                            "publishedAt": pub_date,
                            "likes": 0,
                        })

                    items.append(post_item)
        except Exception as err:
            sys.stderr.write(f"Serper Quora search warning for '{query}': {err}\n")

    return items

def launch_browser(p):
    args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
    ]
    try:
        return p.chromium.launch(headless=True, args=args)
    except Exception:
        try:
            return p.firefox.launch(headless=True)
        except Exception:
            return p.chromium.launch(headless=True)

# Space/topic/profile pages are feeds listing many unrelated questions — scraping
# them like a single question page is what caused other posts' text to be
# misread as "comments" on whichever post happened to load first.
FEED_PATH_PREFIXES = ("/space/", "/topic/", "/profile/", "/q/")

# Matches the relative/absolute date text Quora renders next to an answer
# ("3 years ago", "Updated Tuesday", "Jan 5, 2024"). Deliberately the same
# shapes parse_serp_date() already understands.
DATE_TEXT_RE = re.compile(
    r'\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago'
    r'|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}'
    r'|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}',
    re.I
)

# Each answer block's own text, scraped alongside only its own nearby date text
# (searched 1-2 DOM hops up, not the whole page) so one answer's date can't
# bleed into another's. No class names are hardcoded here on purpose: Quora's
# generated class names change often, and guessing wrong was the root cause of
# the original bug. A block with no identifiable date text simply gets None —
# never a fabricated date.
EXTRACT_BLOCKS_JS = """() => {
    const title = document.title ? document.title.replace('- Quora', '').replace('Quora', '').trim() : '';
    const blocks = [];
    const nodes = Array.from(document.querySelectorAll('.q-text, [class*="q-text"], p'));
    for (const el of nodes) {
        const text = (el.innerText || '').trim();
        if (text.length < 25) continue;
        let dateText = '';
        let scope = el.parentElement;
        for (let hop = 0; hop < 2 && scope; hop++) {
            const scopeText = scope.innerText || '';
            const rest = scopeText.split(text).join('').trim();
            if (rest && rest.length > 0 && rest.length < 400) {
                dateText = rest;
                break;
            }
            scope = scope.parentElement;
        }
        blocks.push({ text, dateText });
    }
    return { title, blocks };
}"""


def is_feed_url(url: str) -> bool:
    path = urllib.parse.urlparse(url).path.lower()
    return any(path.startswith(prefix) for prefix in FEED_PATH_PREFIXES)


def scroll_until_stable(page, max_rounds: int = 8, pause_ms: int = 1200) -> None:
    """Keep scrolling while the page keeps growing, to trigger Quora's
    lazy-loaded answer stream instead of reading whatever happened to render
    after one short scroll."""
    last_height = 0
    for _ in range(max_rounds):
        page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
        page.wait_for_timeout(pause_ms)
        height = page.evaluate("document.body.scrollHeight")
        if height <= last_height:
            break
        last_height = height


def extract_feed_question_links(page, limit: int) -> list:
    """Pull individual question links out of a Space/topic feed page, so each
    gets scraped as its own post instead of the feed page being treated as one."""
    hrefs = page.evaluate("Array.from(document.querySelectorAll('a[href]')).map(a => a.href)")
    links = []
    seen = set()
    for href in hrefs or []:
        link = href.split("?")[0].strip()
        if not link or link in seen or "quora.com" not in link:
            continue
        if is_feed_url(link):
            continue
        path = urllib.parse.urlparse(link).path.lower()
        if any(p in path for p in ["/about", "/careers", "/contact", "/tos", "/privacy", "/login", "/signup"]):
            continue
        segs = [s for s in path.split("/") if s]
        # A question slug is one long dashed segment, e.g. /What-is-EB1A -
        # short segments here are nav links (/jobs, /help, etc), not questions.
        if len(segs) != 1 or len(segs[0]) < 8:
            continue
        seen.add(link)
        links.append(link)
        if len(links) >= limit:
            break
    return links


def scrape_single_quora_question(page, target_url: str):
    """Scrape one question page: the question as the post, its real answers as
    comments, with a best-effort date per answer. Returns None if the page
    didn't load real content (e.g. hit a login wall or 404)."""
    page.goto(target_url, wait_until="domcontentloaded", timeout=25000)
    page.wait_for_timeout(2000)
    scroll_until_stable(page)

    page_date = extract_page_date(page)
    extracted = page.evaluate(EXTRACT_BLOCKS_JS)
    title = extracted.get("title") or ""
    blocks = [b for b in extracted.get("blocks", []) if is_valid_quora_text(b.get("text", ""))]

    if not title or not is_valid_quora_text(title) or not blocks:
        return None

    p_id = make_stable_id("quora_post_url", target_url)
    p_text = f"{title}\n\n{blocks[0]['text']}"

    post_item = {
        "type": "post",
        "id": p_id,
        "platform": "quora",
        "text": p_text,
        "title": title,
        "url": target_url,
        "author": "Quora Contributor",
        "authorUrl": None,
        "publishedAt": page_date,
        "likes": 0,
        "shares": 0,
        "commentsCount": max(0, len(blocks) - 1),
        "comments": []
    }

    for idx, block in enumerate(blocks[1:30]):
        c_txt = block["text"]
        date_match = DATE_TEXT_RE.search(block.get("dateText") or "")
        c_date = parse_serp_date(date_match.group(0)) if date_match else None
        c_id = make_stable_id("quora_comment_url", f"{p_id}::{c_txt}")
        post_item["comments"].append({
            "type": "comment",
            "id": c_id,
            "postId": p_id,
            "text": c_txt,
            "url": target_url,
            "author": f"Quora Contributor {idx+1}",
            "publishedAt": c_date,
            "likes": 0
        })

    return post_item


def scrape_direct_quora_url(target_url: str, feed_limit: int = 8) -> list:
    items = []
    if any(path in target_url.lower() for path in ["/about", "/careers", "/contact", "/tos", "/privacy", "/login"]):
        return []

    try:
        with sync_playwright() as p:
            browser = launch_browser(p)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                locale="en-US"
            )
            page = context.new_page()

            if is_feed_url(target_url):
                page.goto(target_url, wait_until="domcontentloaded", timeout=25000)
                page.wait_for_timeout(2000)
                scroll_until_stable(page, max_rounds=6, pause_ms=1000)
                question_links = extract_feed_question_links(page, limit=feed_limit)
                for link in question_links:
                    try:
                        item = scrape_single_quora_question(page, link)
                    except Exception as err:
                        sys.stderr.write(f"Quora feed item scrape warning for '{link}': {err}\n")
                        continue
                    if item:
                        items.append(item)
            else:
                item = scrape_single_quora_question(page, target_url)
                if item:
                    items.append(item)

            browser.close()
    except Exception as err:
        sys.stderr.write(f"Direct Quora URL scrape error: {err}\n")

    return items

def main():
    args = parse_args()
    keyword = args.keyword.strip()
    target_url = args.url.strip() if args.url else ""

    url_keyword = extract_keyword_from_url(target_url) if target_url else ""
    effective_keyword = url_keyword or keyword or "eb1a"

    items = []

    # Case 1: Direct specific Quora question/space URL (NOT a search URL)
    if target_url and "quora.com" in target_url and "/search" not in target_url:
        items = scrape_direct_quora_url(target_url)

    # Case 2: Keyword search or search URL — query Serper API for 100% real live Quora results
    if not items and effective_keyword:
        items = fetch_serper_quora_items(effective_keyword, limit=args.limit)

    # Output strictly real items JSON (empty list if 0 real items found)
    print(json.dumps(items, ensure_ascii=False))

if __name__ == "__main__":
    main()
