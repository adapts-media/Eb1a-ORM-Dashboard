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

# Force UTF-8 output on Windows stdout & stderr
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(ROOT)
ENV_PATH = os.path.join(BACKEND_ROOT, ".env")

AUTH_WALL_PATTERNS = [
    "login", "sign in", "sign up", "join linkedin", "user agreement",
    "privacy policy", "cookie policy", "check your spam folder",
    "sign in to your linkedin account", "agree & join", "authwall",
    "welcome back", "enter your email", "remember me", "forgot password"
]

def parse_args():
    parser = argparse.ArgumentParser(description="Manual LinkedIn Scraper (100% Live & Real Data)")
    parser.add_argument("--keyword", type=str, default="eb1a", help="Search keyword or brand name")
    parser.add_argument("--url", type=str, default="", help="Custom LinkedIn post or article URL")
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

def is_auth_or_login_text(text: str) -> bool:
    """Check if the text comes from a LinkedIn login / sign-in auth wall."""
    if not text or len(text.strip()) < 5:
        return True
    lower = text.lower()
    for pattern in AUTH_WALL_PATTERNS:
        if pattern in lower:
            return True
    return False

def extract_author_name(title: str, url: str) -> str:
    if title:
        m = re.search(r"^(.+?)(?:'s Post| posted on the topic| on LinkedIn| - LinkedIn)", title, re.IGNORECASE)
        if m and len(m.group(1).strip()) > 1:
            name = m.group(1).strip()
            if not is_auth_or_login_text(name):
                return name
        clean_title = re.sub(r"\s*-\s*LinkedIn$", "", title, flags=re.IGNORECASE).strip()
        if len(clean_title) > 0 and len(clean_title) < 40 and not is_auth_or_login_text(clean_title):
            return clean_title

    if url:
        m_slug = re.search(r"linkedin\.com/(?:posts|pulse|in|company)/([a-zA-Z0-9-]+)", url)
        if m_slug:
            raw_slug = m_slug.group(1).split("_")[0].replace("-", " ").title()
            if len(raw_slug) > 2 and not is_auth_or_login_text(raw_slug):
                return raw_slug
    return "LinkedIn Professional"

def extract_keyword_from_url(url: str) -> str:
    """Extract search keyword if given a search URL like /search/results/content/?keywords=eb1aexperts.com"""
    try:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        if "keywords" in params and params["keywords"]:
            return params["keywords"][0]
    except Exception:
        pass
    return ""

# Each query is paired with a Google recency window (tbs). Without one, every
# run re-reads Google's all-time top 10 for the query, which is the same set of
# already-stored posts hour after hour, so newly published posts never surface
# (confirmed live: the all-time brand query returned mostly year-old posts, while
# the past-month query returned 10 posts the database didn't have).
#   qdr:d  past 24h  - catches each new post within its first day
#   qdr:w  past week - covers a short outage and posts the day filter ranked out
#   qdr:m  past month - for /pulse/ articles, which are published less often
SEARCH_PLAN = [
    ('site:linkedin.com/posts/ "{kw}"', "qdr:d"),
    ('site:linkedin.com/posts/ "{kw}"', "qdr:w"),
    ('site:linkedin.com/pulse/ "{kw}"', "qdr:m"),
    ('site:linkedin.com "{kw}"', "qdr:w"),
]

_ACTIVITY_ID_RE = re.compile(r"activity-(\d{15,20})")


def activity_id_to_date(url: str):
    """Publish time encoded in a LinkedIn post URL's activity id (id >> 22 = epoch ms).

    Serper omits its date field on time-filtered results, which would leave
    every new post as "Unknown date". Checked against 210 stored posts: 172 match
    the stored date within a day (the rest were the imprecise side).
    """
    m = _ACTIVITY_ID_RE.search(url or "")
    if not m:
        return None
    try:
        dt = datetime.fromtimestamp((int(m.group(1)) >> 22) / 1000, timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    if dt.year < 2010 or dt > datetime.now(timezone.utc) + timedelta(days=1):
        return None
    return dt.isoformat()


def fetch_serper_linkedin_posts(keyword: str, limit: int) -> list:
    serper_key = load_serper_key()
    if not serper_key:
        sys.stderr.write("SERPER_API_KEY not configured or found.\n")
        return []

    clean_kw = keyword.strip() or "eb1a"

    items = []
    seen_urls = set()

    for query_template, recency in SEARCH_PLAN:
        if len(items) >= limit:
            break

        query = query_template.format(kw=clean_kw)
        try:
            url = "https://google.serper.dev/search"
            payload = json.dumps({"q": query, "tbs": recency}).encode("utf-8")
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

                    # Filter out non-LinkedIn links or login/signup/authwall links
                    if "linkedin.com" not in link:
                        continue
                    if any(path in link.lower() for path in ["/login", "/signup", "/authwall", "/checkpoint"]):
                        continue
                    if is_auth_or_login_text(title) or is_auth_or_login_text(snippet):
                        continue

                    seen_urls.add(link)
                    p_id = make_stable_id("linkedin_post", link)
                    author_name = extract_author_name(title, link)

                    full_text = f"{title}\n\n{snippet}" if title and snippet and title not in snippet else (snippet or title)

                    items.append({
                        "type": "post",
                        "id": p_id,
                        "platform": "linkedin",
                        "text": full_text,
                        "title": title or snippet[:100],
                        "url": link,
                        "author": author_name,
                        "authorUrl": link if "/in/" in link or "/company/" in link else None,
                        "publishedAt": activity_id_to_date(link) or parse_serp_date(org.get("date"), snippet),
                        "likes": 0,
                        "shares": 0,
                        "commentsCount": 0,
                        "comments": []
                    })
        except Exception as err:
            sys.stderr.write(f"Serper search query '{query}' warning: {err}\n")

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

def scrape_direct_linkedin_url(target_url: str) -> list:
    items = []
    if any(auth_path in target_url.lower() for auth_path in ["/login", "/signup", "/authwall", "/checkpoint"]):
        return []

    try:
        with sync_playwright() as p:
            browser = launch_browser(p)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                locale="en-US",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()

            page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2500)
            page.evaluate("window.scrollBy(0, 1000)")
            page.wait_for_timeout(1500)

            extracted = page.evaluate("""() => {
                const title = document.title ? document.title.replace('- LinkedIn', '').replace('LinkedIn', '').trim() : '';
                const paragraphs = Array.from(document.querySelectorAll('p, div.feed-shared-update-v2__description, article span, div.break-words'))
                    .map(el => el.innerText ? el.innerText.trim() : '')
                    .filter(txt => txt.length > 20);
                return { title, paragraphs };
            }""")

            page_date = extract_page_date(page)
            title = extracted.get("title") or ""
            paragraphs = extracted.get("paragraphs") or []

            if is_auth_or_login_text(title) or (paragraphs and is_auth_or_login_text(paragraphs[0])):
                browser.close()
                return []

            valid_paragraphs = [p for p in paragraphs if not is_auth_or_login_text(p)]
            if not valid_paragraphs and is_auth_or_login_text(title):
                browser.close()
                return []

            p_id = make_stable_id("linkedin_post_url", target_url)
            author = extract_author_name(title, target_url)
            p_text = f"{title}\n\n{valid_paragraphs[0]}" if valid_paragraphs else title

            post_item = {
                "type": "post",
                "id": p_id,
                "platform": "linkedin",
                "text": p_text,
                "title": title or "LinkedIn Post",
                "url": target_url,
                "author": author,
                "authorUrl": None,
                "publishedAt": page_date,
                "likes": 0,
                "shares": 0,
                "commentsCount": max(0, len(valid_paragraphs) - 1),
                "comments": []
            }

            for idx, c_txt in enumerate(valid_paragraphs[1:10]):
                c_id = make_stable_id("linkedin_comment_url", f"{p_id}::{c_txt}")
                post_item["comments"].append({
                    "type": "comment",
                    "id": c_id,
                    "postId": p_id,
                    "text": c_txt,
                    "url": target_url,
                    "author": f"LinkedIn User {idx+1}",
                    # Individual comment dates aren't available here.
                    "publishedAt": None,
                    "likes": 0
                })

            items.append(post_item)
            browser.close()
    except Exception as err:
        sys.stderr.write(f"Direct LinkedIn URL scrape error: {err}\n")

    return items

def main():
    args = parse_args()
    keyword = args.keyword.strip()
    target_url = args.url.strip() if args.url else ""

    url_keyword = extract_keyword_from_url(target_url) if target_url else ""
    effective_keyword = url_keyword or keyword or "eb1a"

    items = []

    # Case 1: If target_url is a specific post/pulse/company link (NOT a search URL or login link), try direct Playwright scrape
    if target_url and "linkedin.com" in target_url and "/search/" not in target_url and not any(k in target_url.lower() for k in ["/login", "/signup", "/authwall"]):
        items = scrape_direct_linkedin_url(target_url)

    # Case 2: Fetch real live posts indexed via Serper API (prioritizing /posts/)
    if not items and effective_keyword:
        items = fetch_serper_linkedin_posts(effective_keyword, limit=args.limit)

    # Output strictly clean real items JSON
    print(json.dumps(items, ensure_ascii=False))

if __name__ == "__main__":
    main()
