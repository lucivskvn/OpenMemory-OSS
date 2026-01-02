"""
web crawler connector for openmemory
requires: httpx, beautifulsoup4
no auth required for public urls
"""
import asyncio
import logging
from typing import List, Dict, Optional, Set
import os
from urllib.parse import urljoin, urlparse
from .base import base_connector


logger = logging.getLogger("openmemory.connectors.web_crawler")

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
    
    async def list_items(self, start_url: str = None, follow_links: bool = True, **filters) -> List[Dict]:
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
                        href = link["href"]
                        full_url = urljoin(url, href)
                        parsed = urlparse(full_url)
                        
                        # Only stay on same domain
                        if parsed.netloc == base_domain:
                            clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                            discovered.append((clean_url, depth + 1))
                return discovered
                
            except Exception as e:
                logger.warning(f"failed to fetch {url}: {e}")
                return []
    
    async def fetch_item(self, item_id: str) -> Dict[str, Any]:
        """
        Fetch and extract clean text from a URL.
        
        Args:
            item_id: The URL to fetch.
            
        Returns:
            Dict containing the extracted text and metadata.
        """
        try:
            import httpx
            from bs4 import BeautifulSoup
        except ImportError:
            raise ImportError("pip install httpx beautifulsoup4")
        
        async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
            resp = await client.get(item_id, headers={
                "User-Agent": "OpenMemory-Crawler/1.0 (compatible)"
            })
            resp.raise_for_status()
            
            soup = BeautifulSoup(resp.text, "html.parser")
            
            # remove junk elements
            for element in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
                element.decompose()
            
            # get title
            title = soup.title.string if soup.title else item_id
            
            # Priority selectors for main content
            main = (
                soup.find("main") or 
                soup.find("article") or 
                soup.find("div", class_=re.compile(r"content|article|post|main", re.I)) or
                soup.find("body")
            )
            
            if main:
                text = main.get_text(separator="\n", strip=True)
            else:
                text = soup.get_text(separator="\n", strip=True)
            
            # Final cleanup of excessive newlines
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
        
        return {
            "id": item_id,
            "name": title.strip() if title else item_id,
            "type": "webpage",
            "text": text,
            "data": text,
            "meta": {
                "source": "web_crawler",
                "url": item_id,
                "char_count": len(text)
            }
        }
