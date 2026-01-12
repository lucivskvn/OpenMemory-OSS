"""
web crawler connector for openmemory
requires: httpx, beautifulsoup4
no auth required for public urls
"""
import asyncio
import logging
from typing import List, Dict, Optional, Set, Any
import os
from urllib.parse import urljoin, urlparse
from .base import BaseConnector, SourceContent, SourceFetchError


logger = logging.getLogger("openmemory.connectors.web_crawler")

class WebCrawlerConnector(BaseConnector):
    """connector for crawling web pages"""

    name = "web_crawler"

    def __init__(
        self, user_id: Optional[str] = None, max_pages: int = 50, max_depth: int = 3
    ):
        super().__init__(user_id)
        self.max_pages = max_pages
        self.max_depth = max_depth
        self.visited: Set[str] = set()
        self.crawled: List[Dict] = []

    async def connect(self, **creds) -> bool:
        """no auth needed for public crawling"""
        self._connected = True
        return True

    async def list_items(self, start_url: Optional[str] = None, follow_links: bool = True, **filters) -> List[Dict]:  # type: ignore[override]
        """
        crawl from starting url and list discovered pages with parallel workers
        """
        if not start_url:
            raise ValueError("start_url is required")

        try:
            import httpx
            from bs4 import BeautifulSoup
        except ImportError:
            raise ImportError("pip install httpx beautifulsoup4")

        self.visited.clear()
        self.crawled.clear()

        base_domain = urlparse(start_url).netloc
        queue = [(start_url, 0)]  # (url, depth)

        semaphore = asyncio.Semaphore(10) # limit concurrent requests

        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            while queue and len(self.crawled) < self.max_pages:
                # Process queue in levels or chunks to allow parallelization?
                # A simple way is to process current level in parallel
                current_batch = queue[:20] # Take a slice of the queue
                queue = queue[20:]

                tasks = []
                for url, depth in current_batch:
                    if url in self.visited: continue
                    if depth > self.max_depth: continue
                    self.visited.add(url)
                    tasks.append(self._crawl_page(client, url, depth, base_domain, follow_links, semaphore))

                if not tasks: break

                results = await asyncio.gather(*tasks)

                for discovered_links in results:
                    if discovered_links:
                        queue.extend(discovered_links)

        return self.crawled

    async def _crawl_page(self, client, url, depth, base_domain, follow_links, semaphore):
        """Internal helper to crawl a single page and find links."""
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin, urlparse

        async with semaphore:
            try:
                resp = await client.get(url, headers={
                    "User-Agent": "OpenMemory-Crawler/1.0 (compatible)"
                })

                if resp.status_code != 200:
                    return []

                content_type = resp.headers.get("content-type", "")
                if "text/html" not in content_type:
                    return []

                soup = BeautifulSoup(resp.text, "html.parser")
                title = soup.title.string if soup.title else url

                self.crawled.append({
                    "id": url,
                    "name": title.strip() if title else url,
                    "type": "webpage",
                    "url": url,
                    "depth": depth
                })

                discovered = []
                if follow_links and depth < self.max_depth:
                    for link in soup.find_all("a", href=True):
                        href = link["href"]  # type: ignore[index]
                        href_str = str(href) if href else ""
                        if not href_str:
                            continue
                        full_url = urljoin(url, href_str)
                        parsed = urlparse(full_url)

                        # Only stay on same domain
                        if parsed.netloc == base_domain:
                            clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                            discovered.append((clean_url, depth + 1))
                return discovered

            except Exception as e:
                logger.warning(f"failed to fetch {url}: {e}")
                return []

    async def fetch_item(self, item_id: str) -> SourceContent:  # type: ignore[override]
        """
        Fetch and extract clean text from a URL using hardened extraction logic.

        Args:
            item_id: The URL to fetch.

        Returns:
            Dict containing the extracted text and metadata.
        """
        # Reuse the hardened extraction logic from ops.extract
        # This ensures consistent XSS protection and robust handling
        from ..ops.extract import extract_url

        try:
            # We already have a valid user_id attached to the connector
            result = await extract_url(item_id, user_id=self.user_id)

            return SourceContent(
                id=item_id,
                name=result["metadata"].get("title", item_id),
                type="webpage",
                text=result["text"],
                data=result["text"],
                metadata={  # type: ignore[arg-type]
                    "source": "web_crawler",
                    "url": item_id,
                    **result["metadata"],
                },
            )
        except Exception as e:
            logger.error(f"Failed to fetch {item_id}: {e}")
            raise SourceFetchError(str(e), self.name, e)
