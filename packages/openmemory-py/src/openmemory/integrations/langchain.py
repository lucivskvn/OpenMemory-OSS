from typing import List, Any, Optional
try:
    from langchain_core.chat_history import BaseChatMessageHistory
    from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
    from langchain_core.retrievers import BaseRetriever
    from langchain_core.documents import Document
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
except ImportError:
    # Optional dependencies
    class DummyMessage:
        def __init__(self, content=None, page_content=None, **kwargs):
            self.content = content or page_content
            self.page_content = self.content
    
    BaseChatMessageHistory = object
    BaseRetriever = object
    BaseMessage = DummyMessage
    HumanMessage = DummyMessage
    AIMessage = DummyMessage
    Document = DummyMessage
    CallbackManagerForRetrieverRun = object

from ..main import Memory
from ..utils.async_bridge import run_sync

class OpenMemoryChatMessageHistory(BaseChatMessageHistory):
    def __init__(self, memory: Memory, user_id: str, session_id: str = "default"):
        self.mem = memory
        self.user_id = user_id
        self.session_id = session_id
        
    @property
    def messages(self) -> List[BaseMessage]:
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
             print(f"DEBUG LANGCHAIN ERROR: {e}")
             import traceback
             traceback.print_exc()
             return []

    async def aget_messages(self) -> List[BaseMessage]:
        # Custom Async method for retrieval
        history = await self.mem.history(self.user_id)
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

    def add_message(self, message: BaseMessage) -> None:
        role = "User" if isinstance(message, HumanMessage) else "Assistant"
        # Use run_sync to ensure persistence
        try:
            run_sync(self.mem.add(f"{role}: {message.content}", user_id=self.user_id))
        except Exception:
            pass

    def clear(self) -> None:
        # We cannot easily clear *just* this session's memory without tags.
        # Assuming clear = reset user memory? Dangerous.
        # Let's leave as pass but document why.
        pass

class OpenMemoryRetriever(BaseRetriever):
    memory: Memory
    user_id: str
    k: int = 5
    
    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> List[Document]:
        try:
            results = run_sync(self.memory.search(query, user_id=self.user_id, limit=self.k))
        except Exception:
            results = []
            
        docs = []
        for r in results:
            docs.append(Document(page_content=r.content, metadata=r.model_dump()))
        return docs
        
    async def _aget_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> List[Document]:
        results = await self.memory.search(query, user_id=self.user_id, limit=self.k)
        docs = []
        for r in results:
            docs.append(Document(page_content=r.content, metadata=r.model_dump()))
        return docs
