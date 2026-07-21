"""
web crawler connector for openmemory
requires: httpx, beautifulsoup4
no auth required for public urls
"""
from typing import List, Dict, Optional, Set, Any
import os
import asyncio
from urllib.parse import urljoin, urlparse
from .base import base_connector


class web_crawler_connector(base_connector):
    """connector for crawling web pages"""

    name = "web_crawler"

    def __init__(self, user_id: str = None, max_pages: int = 50, max_depth: int = 3):
        super().__init__(user_id)
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.visited: Set[str] = set()
        self.crawled: List[Dict] = []

    async def connect(self, **creds) -> bool:
        """no auth needed for public crawling"""
        self._connected = True
        return True

    async def list_items(
        self, start_url: str = None, follow_links: bool = True, **filters
    ) -> List[Dict]:
        """
        crawl from starting url and list discovered pages

        args:
            start_url: url to start crawling from
            follow_links: whether to follow internal links
        """
        if not start_url:
            raise ValueError("start_url is required")

        self.visited.clear()
        self.crawled.clear()

        base_domain = urlparse(start_url).netloc
        to_visit = [(start_url, 0)]

        while to_visit and len(self.crawled) < self.max_pages:
            url, depth = to_visit.pop(0)

            if url in self.visited or depth > self.max_depth:
                continue

            self.visited.add(url)

            await self._process_crawl_url(
                url=url,
                depth=depth,
                base_domain=base_domain,
                follow_links=follow_links,
                to_visit=to_visit,
            )

        return self.crawled

    async def _process_crawl_url(
        self,
        url: str,
        depth: int,
        base_domain: str,
        follow_links: bool,
        to_visit: List[Any],
    ) -> None:
        from bs4 import BeautifulSoup
        from ..utils.fetch import fetch_with_ssrf_protection

        try:
            resp = await fetch_with_ssrf_protection(
                url,
                headers={
                    "User-Agent": "OpenMemory-Crawler/1.0 (compatible)"
                },
                timeout=30.0,
            )

            if resp.status_code != 200:
                return

            content_type = resp.headers.get("content-type", "")
            if "text/html" not in content_type:
                return

            soup = await asyncio.to_thread(BeautifulSoup, resp.text, "html.parser")
            title = soup.title.string if soup.title else url

            self.crawled.append(
                {
                    "id": url,
                    "name": title.strip() if title else url,
                    "type": "webpage",
                    "url": url,
                    "depth": depth,
                }
            )
            if follow_links and depth < self.max_depth:
                self._extract_links_from_soup(soup, url, base_domain, depth, to_visit)

        except Exception as e:
            print(f"[crawler] failed to fetch {url}: {e}")

    def _extract_links_from_soup(
        self, soup: Any, url: str, base_domain: str, depth: int, to_visit: List[Any]
    ) -> None:
        for link in soup.find_all("a", href=True):
            try:
                href = link["href"]
                full_url = urljoin(url, href)
                parsed = urlparse(full_url)
                if parsed.netloc == base_domain:
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                    if clean_url not in self.visited:
                        to_visit.append((clean_url, depth + 1))
            except Exception as e:
                print(f"[crawler] failed to extract link from {url}: {e}")

    async def fetch_item(self, item_id: str) -> Dict:
        """
        fetch and extract text from a url

        item_id is the url to fetch
        """
        try:
            from bs4 import BeautifulSoup
        except ImportError:
            raise ImportError("pip install beautifulsoup4")

        from ..utils.fetch import fetch_with_ssrf_protection

        resp = await fetch_with_ssrf_protection(
            item_id,
            headers={"User-Agent": "OpenMemory-Crawler/1.0 (compatible)"},
            timeout=30.0,
        )
        resp.raise_for_status()

        soup = await asyncio.to_thread(BeautifulSoup, resp.text, "html.parser")
        for element in soup(["script", "style", "nav", "footer", "header"]):
            element.decompose()
        title = soup.title.string if soup.title else item_id
        main = soup.find("main") or soup.find("article") or soup.find("body")

        if main:
            text = main.get_text(separator="\n", strip=True)
        else:
            text = soup.get_text(separator="\n", strip=True)
        lines = [line.strip() for line in text.split("\n") if line.strip()]
        text = "\n".join(lines)

        return {
            "id": item_id,
            "name": title.strip() if title else item_id,
            "type": "webpage",
            "text": text,
            "data": text,
            "meta": {
                "source": "web_crawler",
                "url": item_id,
                "char_count": len(text),
            },
        }
