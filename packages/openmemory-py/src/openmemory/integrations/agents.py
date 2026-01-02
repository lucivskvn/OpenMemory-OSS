from typing import Any, List, Dict
import asyncio
from ..main import Memory
from ..utils.async_bridge import run_sync

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
        
    def save(self, value: Any, metadata: Dict[str, Any] = None) -> None:
        if isinstance(value, str):
            try:
                run_sync(self.mem.add(value, user_id=self.user_id, meta=metadata))
            except Exception as e:
                # Log but safeguard execution flow
                pass
            
    def search(self, query: str, limit: int = 3) -> List[Any]:
        try:
            results = run_sync(self.mem.search(query, user_id=self.user_id, limit=limit))
        except Exception:
            results = []
            
        return [r.content for r in results[:limit]]

# -- LangChain Compatibility --

try:
    from langchain_core.retrievers import BaseRetriever
    from langchain_core.documents import Document
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from langchain_core.chat_history import BaseChatMessageHistory
    from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage
except ImportError:
    class BaseRetriever:
        def __init__(self, **kwargs):
            for k, v in kwargs.items(): setattr(self, k, v)
    class Document:
        def __init__(self, **kwargs):
            for k, v in kwargs.items(): setattr(self, k, v)
    class BaseChatMessageHistory: pass
    class BaseMessage: pass
    class HumanMessage:
        def __init__(self, content): self.content = content
    class AIMessage:
        def __init__(self, content): self.content = content
    class SystemMessage:
        def __init__(self, content): self.content = content
    CallbackManagerForRetrieverRun = Any

class MemoryRetriever(BaseRetriever):
    """
    LangChain compatible retriever for OpenMemory.
    """
    mem: Memory
    user_id: str = "anonymous"
    k: int = 4
    
    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun = None
    ) -> List[Document]:
        results = run_sync(self.mem.search(query, user_id=self.user_id, limit=self.k))
        docs = []
        for r in results:
            docs.append(Document(
                page_content=r.content,
                metadata={
                    "id": r.id,
                    "score": r.score,
                    "primary_sector": r.primary_sector,
                    **r.meta
                }
            ))
        return docs

class MemoryHistory(BaseChatMessageHistory):
    """
    LangChain compatible chat history for OpenMemory.
    """
    def __init__(self, memory: Memory, user_id: str):
        self.mem = memory
        self.user_id = user_id

    @property
    def messages(self) -> List[BaseMessage]:
        rows = run_sync(self.mem.history(user_id=self.user_id, limit=20))
        msgs = []
        for r in reversed(rows): # history is usually desc, we want asc for LC
            content = r.content
            # Basic heuristic for role
            if "[System]" in content: msgs.append(SystemMessage(content=content))
            elif "[AI]" in content: msgs.append(AIMessage(content=content))
            else: msgs.append(HumanMessage(content=content))
        return msgs

    def add_message(self, message: BaseMessage) -> None:
        role = "Human"
        if isinstance(message, AIMessage): role = "AI"
        elif isinstance(message, SystemMessage): role = "System"
        
        content = f"[{role}] {message.content}"
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
        except Exception:
            pass
        
    return state
