import logging
from typing import Any, List, Dict
import asyncio
from ..main import Memory
from ..utils.async_bridge import run_sync

logger = logging.getLogger(__name__)

# -- CrewAI Adapter --
class CrewAIMemory:
    """
    Adapter for CrewAI's memory system.
    Usage:
    crew = Crew(..., memory=True, memory_config={"provider": CrewAIMemory(mem_instance)})
    """
    def __init__(self, memory: Memory, user_id: str = "crew_agent"):
        self.mem = memory
        self.user_id = user_id
        
    def save(self, value: Any, metadata: Dict[str, Any] | None = None) -> None:
        if isinstance(value, str):
            try:
                run_sync(self.mem.add(value, user_id=self.user_id, metadata=metadata or {}))
            except Exception as e:
                logger.warning("CrewAIMemory.save failed: %s", e)
            
    def search(self, query: str, limit: int = 3) -> List[Any]:
        try:
            results = run_sync(self.mem.search(query, user_id=self.user_id, limit=limit))
        except Exception as e:
            logger.warning("CrewAIMemory.search failed: %s", e)
            results = []

        return [r.content for r in results[:limit]]

# -- LangChain Compatibility --

try:
    from langchain_core.retrievers import BaseRetriever  # type: ignore[import]
    from langchain_core.documents import Document  # type: ignore[import]
    from langchain_core.callbacks import CallbackManagerForRetrieverRun  # type: ignore[import]
    from langchain_core.chat_history import BaseChatMessageHistory  # type: ignore[import]
    from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage  # type: ignore[import]
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    class BaseRetriever:  # type: ignore[no-redef]
        def __init__(self, **kwargs):
            for k, v in kwargs.items(): setattr(self, k, v)
        async def aget_relevant_documents(self, query: str) -> List[Any]: return []
        def get_relevant_documents(self, query: str) -> List[Any]: return []

    class Document:  # type: ignore[no-redef]
        def __init__(self, **kwargs):
            for k, v in kwargs.items(): setattr(self, k, v)

    class BaseChatMessageHistory:  # type: ignore[no-redef]
        def add_message(self, message: Any) -> None: pass
        def clear(self) -> None: pass
        @property
        def messages(self) -> List[Any]: return []

    class BaseMessage:  # type: ignore[no-redef]
        pass

    class HumanMessage:  # type: ignore[no-redef]
        def __init__(self, content: str = ""): self.content = content

    class AIMessage:  # type: ignore[no-redef]
        def __init__(self, content: str = ""): self.content = content

    class SystemMessage:  # type: ignore[no-redef]
        def __init__(self, content: str = ""): self.content = content

    CallbackManagerForRetrieverRun = Any


class MemoryRetriever(BaseRetriever):  # type: ignore[misc]
    """
    LangChain compatible retriever for OpenMemory.
    """
    mem: Memory
    user_id: str = "anonymous"
    k: int = 4

    async def aget_relevant_documents(self, query: str) -> List[Any]:  # type: ignore[override]
        results = await self.mem.search(query, user_id=self.user_id, limit=self.k)
        docs = []
        for r in results:
            docs.append(
                Document(  # type: ignore[call-arg]
                    page_content=r.content,
                    metadata={
                        "id": r.id,
                        "score": r.score,
                        "primary_sector": r.primary_sector,
                        **r.metadata,
                    },
                )
            )
        return docs

    def _get_relevant_documents(self, query: str, *, run_manager: Any = None) -> List[Any]:
        """Sync retrieval using run_sync bridge."""
        return run_sync(self.aget_relevant_documents(query))


class MemoryHistory(BaseChatMessageHistory):  # type: ignore[misc]
    """
    LangChain compatible chat history for OpenMemory.
    """
    def __init__(self, memory: Memory, user_id: str):
        self.mem = memory
        self.user_id = user_id

    @property
    def messages(self) -> List[Any]:  # type: ignore[override]
        try:
            rows = run_sync(self.mem.history(user_id=self.user_id, limit=20))
            return self._format_messages(rows)
        except Exception as e:
            logger.warning("MemoryHistory.messages failed: %s", e)
            return []

    async def aget_messages(self) -> List[Any]:
        rows = await self.mem.history(user_id=self.user_id, limit=20)
        return self._format_messages(rows)

    def _format_messages(self, rows: List[Any]) -> List[Any]:
        msgs = []
        for r in reversed(rows): # history is usually desc, we want asc for LC
            content = r.content
            # Basic heuristic for role
            if "[System]" in content: msgs.append(SystemMessage(content=content))
            elif "[AI]" in content: msgs.append(AIMessage(content=content))
            else: msgs.append(HumanMessage(content=content))
        return msgs

    def add_message(self, message: Any) -> None:  # type: ignore[override]
        role = "Human"
        if isinstance(message, AIMessage): role = "AI"
        elif isinstance(message, SystemMessage): role = "System"
        
        content_text = getattr(message, 'content', str(message))
        content = f"[{role}] {content_text}"
        run_sync(self.mem.add(content, user_id=self.user_id))

    def clear(self) -> None:
        """Not implemented: OpenMemory history is persistent by design."""
        pass

# -- LangGraph Node --
def memory_node(state: Dict, memory: Memory, user_key: str = "user_id", input_key: str = "messages"):
    """
    LangGraph node to automatically persist state to memory.
    
    Args:
        state: The current graph state.
        memory: OpenMemory instance.
        user_key: Key in state containing user_id.
        input_key: Key in state containing messages list.
    """
    messages = state.get(input_key, [])
    user_id = state.get(user_key, "anonymous")
    
    if messages:
        last_msg = messages[-1]
        content = getattr(last_msg, "content", str(last_msg))
        # This is a LangGraph node, usually called in an async graph, but if not:
        try:
            run_sync(memory.add(content, user_id=user_id))
        except Exception as e:
            logger.warning("memory_node failed to persist: %s", e)
        
    return state
