"""
notion connector for openmemory
requires: notion-client
env vars: NOTION_API_KEY
"""
from typing import List, Dict, Optional, Any
import os
import logging
from .base import BaseConnector, SourceItem, SourceContent, SourceAuthError

logger = logging.getLogger("openmemory.connectors.notion")

class NotionConnector(BaseConnector):
    """connector for notion pages and databases"""

    name = "notion"

    def __init__(self, user_id: Optional[str] = None):
        super().__init__(user_id)
        self.client = None

    async def _connect(self, **creds) -> bool:  # type: ignore[misc]
        """authenticate with notion api using AsyncClient"""
        try:
            from notion_client import AsyncClient  # type: ignore[import]
        except ImportError:
            raise ImportError("pip install notion-client")

        api_key = creds.get("api_key") or os.environ.get("NOTION_API_KEY")

        if not api_key:
            raise ValueError("no notion api key provided")

        self.client = AsyncClient(auth=api_key)
        self._connected = True
        return True

    async def _list_items(self, **filters) -> List[SourceItem]:
        """list pages from notion"""
        database_id = filters.get("database_id")

        if not self.client:
            raise SourceAuthError("Not connected", self.name)

        results = []  # type: ignore[unreachable]

        if database_id:
            has_more = True
            start_cursor = None

            while has_more:
                if not self.client or not hasattr(self.client, "databases"):
                    break

                resp = await self.client.databases.query(  # type: ignore[union-attr]
                    database_id=database_id, start_cursor=start_cursor
                )

                for page in resp.get("results", []):
                    title = self._extract_title(page)

                    results.append(SourceItem(
                        id=page["id"],
                        name=title or "Untitled",
                        type="page",
                        path=f"page/{page['id']}",
                        size=0,
                        metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                            "url": page.get("url", ""),
                            "last_edited": page.get("last_edited_time")
                        }
                    ))

                has_more = resp.get("has_more", False)
                start_cursor = resp.get("next_cursor")
        else:
            resp = await self.client.search(filter={"property": "object", "value": "page"})

            for page in resp.get("results", []):
                title = self._extract_title(page)

                results.append(SourceItem(
                    id=page["id"],
                    name=title or "Untitled",
                    type="page",
                    path=f"page/{page['id']}",
                    size=0,
                    metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                        "url": page.get("url", ""),
                        "last_edited": page.get("last_edited_time")
                    }
                ))

        return results

    def _extract_title(self, page: Dict) -> str:
        props = page.get("properties", {})
        for prop in props.values():
            if prop.get("type") == "title":
                titles = prop.get("title", [])
                if titles:
                    return titles[0].get("plain_text", "")
        return ""

    async def _fetch_item(self, item_id: str) -> SourceContent:
        """
        Fetch page content including all nested blocks as text.

        Args:
            item_id: The ID of the Notion page to fetch.

        Returns:
            SourceContent containing full page text.
        """
        if not self.client:
            raise SourceAuthError("Not connected", self.name)

        # get page metadata
        page = await self.client.pages.retrieve(page_id=item_id)
        title = self._extract_title(page)

        # recursively get all blocks
        blocks = await self._get_all_blocks_recursive(item_id)

        text_parts = [f"# {title}"] if title else []
        for block in blocks:
            txt = self._block_to_text(block)
            if txt.strip():
                text_parts.append(txt)

        text = "\n\n".join(text_parts)

        return SourceContent(
            id=item_id,
            name=title or "Untitled",
            type="notion_page",
            text=text,
            data=text,
            metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                "source": "notion",
                "page_id": item_id,
                "url": page.get("url", ""),
                "block_count": len(blocks)
            }
        )

    async def _get_all_blocks_recursive(self, parent_id: str, depth: int = 0) -> List[Dict]:
        """Fetch all blocks for a given parent, including children recursively."""
        if not self.client:
            raise SourceAuthError("Not connected", self.name)
        if depth > 10: return [] # Limit depth to prevent infinite recursion or extreme latency

        blocks = []
        has_more = True
        start_cursor = None

        while has_more:
            resp = await self.client.blocks.children.list(
                block_id=parent_id,
                start_cursor=start_cursor
            )
            results = resp.get("results", [])
            for block in results:
                blocks.append(block)
                if (block or {}).get("has_children"):  # type: ignore[union-attr]
                    children = await self._get_all_blocks_recursive(
                        block.get("id", ""), depth + 1
                    )
                    blocks.extend(children)

            has_more = resp.get("has_more", False)
            start_cursor = resp.get("next_cursor")
            if len(blocks) > 1000: break # Higher safety limit for recursive

        return blocks

    def _block_to_text(self, block: Dict) -> str:
        """Convert a single Notion block to a text string."""
        texts = []
        block_type = block.get("type", "")

        if block_type in ["paragraph", "heading_1", "heading_2", "heading_3",
                          "bulleted_list_item", "numbered_list_item", "quote", "callout"]:
            rich_text = block.get(block_type, {}).get("rich_text", [])
            for rt in rich_text:
                texts.append(rt.get("plain_text", ""))

        elif block_type == "code":
            rich_text = block.get("code", {}).get("rich_text", [])
            for rt in rich_text:
                texts.append(rt.get("plain_text", ""))

        elif block_type == "to_do":
            checked = block.get("to_do", {}).get("checked", False)
            rich_text = block.get("to_do", {}).get("rich_text", [])
            prefix = "[x] " if checked else "[ ] "
            for rt in rich_text:
                texts.append(prefix + rt.get("plain_text", ""))

        elif block_type == "toggle":
            rich_text = block.get("toggle", {}).get("rich_text", [])
            for rt in rich_text:
                texts.append(rt.get("plain_text", ""))

        return "".join(texts)
