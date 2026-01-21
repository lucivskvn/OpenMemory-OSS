import logging
from typing import List, Any, Optional, TYPE_CHECKING

logger = logging.getLogger(__name__)
try:
    from langchain_core.chat_history import BaseChatMessageHistory  # type: ignore[import]
    from langchain_core.messages import BaseMessage, HumanMessage, AIMessage  # type: ignore[import]
    from langchain_core.retrievers import BaseRetriever  # type: ignore[import]
    from langchain_core.documents import Document  # type: ignore[import]
    from langchain_core.callbacks import CallbackManagerForRetrieverRun  # type: ignore[import]
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    # Optional dependencies
    class DummyMessage:
        def __init__(self, content=None, page_content=None, metadata=None, **kwargs):
            self.content = content or page_content
            self.page_content = self.content
            self.metadata = metadata or {}

    class BaseChatMessageHistory:  # type: ignore[no-redef]
        def add_message(self, message: Any) -> None: pass
        def clear(self) -> None: pass
        @property
        def messages(self) -> List[Any]: return []

    class BaseRetriever:  # type: ignore[no-redef]
        async def aget_relevant_documents(self, query: str) -> List[Any]: return []
        def get_relevant_documents(self, query: str) -> List[Any]: return []

    BaseMessage = DummyMessage
    HumanMessage = DummyMessage
    AIMessage = DummyMessage
    Document = DummyMessage
    CallbackManagerForRetrieverRun = object

from ..main import Memory
from ..utils.async_bridge import run_sync

class OpenMemoryChatMessageHistory(BaseChatMessageHistory):  # type: ignore[misc]
    def __init__(self, memory: Any, user_id: str, session_id: str = "default"):
        self.mem = memory
        self.user_id = user_id
        self.session_id = session_id

    @property
    def messages(self) -> List[Any]:  # type: ignore[override]
        # Retrieve recent history from memory tagged with session_id if possible
        # Using run_sync to bridge async DB call to sync property
        try:
            history = run_sync(self.mem.history(self.user_id))
            msgs = []
            for h in history:
                c = h.content
                if c.startswith("User:"):
                    msgs.append(HumanMessage(content=c[5:].strip()))
                elif c.startswith("Assistant:"):
                    msgs.append(AIMessage(content=c[10:].strip()))
                else:
                    msgs.append(HumanMessage(content=c))
            return msgs
        except Exception as e:
            logger.warning("OpenMemoryChatMessageHistory.messages failed: %s", e)
            return []

    async def aget_messages(self) -> List[Any]:  # type: ignore[override]
        # Custom Async method for retrieval
        history = run_sync(self.mem.history(self.user_id))
        # Convert to BaseMessage
        msgs = []
        for h in history:
            # MemoryItem uses attribute access
            c = h.content
            if c.startswith("User:"):
                msgs.append(HumanMessage(content=c[5:].strip()))
            elif c.startswith("Assistant:"):
                msgs.append(AIMessage(content=c[10:].strip()))
            else:
                msgs.append(HumanMessage(content=c))
        return msgs

    def add_message(self, message: Any) -> None:  # type: ignore[override]
        role = "User" if isinstance(message, HumanMessage) else "Assistant"
        # Use run_sync to ensure persistence
        try:
            run_sync(self.mem.add(f"{role}: {message.content}", user_id=self.user_id))
        except Exception as e:
            logger.warning("OpenMemoryChatMessageHistory.add_message failed: %s", e)

    def clear(self) -> None:
        # We cannot easily clear *just* this session's memory without tags.
        # Assuming clear = reset user memory? Dangerous.
        # Let's leave as pass but document why.
        pass


from pydantic import ConfigDict

class OpenMemoryRetriever(BaseRetriever):  # type: ignore
    model_config = ConfigDict(arbitrary_types_allowed=True)
    memory: Any
    user_id: str
    k: int = 5

    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> List[Document]:  # type: ignore
        try:
            results = run_sync(self.memory.search(query, user_id=self.user_id, limit=self.k))
        except Exception as e:
            logger.warning("OpenMemoryRetriever._get_relevant_documents failed: %s", e)
            results = []

        docs = []
        for r in results:
            docs.append(Document(page_content=r.content, metadata=r.model_dump()))
        return docs

    async def _aget_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> List[Document]:  # type: ignore
        results = await self.memory.search(query, user_id=self.user_id, limit=self.k)
        docs = []
        for r in results:
            docs.append(Document(page_content=r.content, metadata=r.model_dump()))
        return docs


class OpenMemoryVectorStore:
    """VectorStore implementation for OpenMemory."""

    def __init__(self, memory: Any, user_id: str):
        self.memory = memory
        self.user_id = user_id

    def add_texts(
        self, texts: List[str], metadatas: Optional[List[dict]] = None, **kwargs
    ) -> List[str]:
        # Basic implementation mapping to memory.add
        ids = []
        for i, text in enumerate(texts):
            meta = None
            if metadatas and i < len(metadatas):
                meta = metadatas[i] or {}
            res = run_sync(self.memory.add(text, user_id=self.user_id, metadata=meta))
            ids.append(res.id)
        return ids

    def similarity_search(self, query: str, k: int = 4, **kwargs) -> "List[Document]":
        results = run_sync(self.memory.search(query, user_id=self.user_id, limit=k))
        return [
            Document(page_content=r.content, metadata=r.model_dump()) for r in results
        ]

    @classmethod
    def from_texts(
        cls,
        texts: List[str],
        embedding: Any,
        metadatas: Optional[List[dict]] = None,
        **kwargs,
    ):
        mem = kwargs.get("memory")
        if not mem:
            raise ValueError("memory instance required in kwargs")
        user_id = kwargs.get("user_id", "default")
        vs = cls(mem, user_id)
        vs.add_texts(texts, metadatas)
        return vs
