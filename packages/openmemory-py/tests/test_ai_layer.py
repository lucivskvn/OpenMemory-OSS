"""
Consolidated AI Layer Tests

This module tests MCP tools, LangChain integrations, and CrewAI adapters.
"""
import pytest
import json
from unittest.mock import AsyncMock, Mock, patch, MagicMock
import sys

# Mock mcp.server import if not present
sys.modules["mcp"] = MagicMock()
sys.modules["mcp.server"] = MagicMock()
sys.modules["mcp.types"] = MagicMock()

from openmemory.ai.mcp import handle_call_tool, handle_list_tools
from openmemory.integrations.agents import MemoryRetriever, MemoryHistory, CrewAIMemory
from openmemory.main import Memory

# --- MCP Tool Tests ---

@pytest.mark.asyncio
async def test_mcp_tool_list_parity():
    """Verify MCP tool list contains core and temporal tools."""
    tools = await handle_list_tools()
    names = [t.name for t in tools]
    assert "openmemory_query" in names
    assert "openmemory_temporal_fact_create" in names
    assert len(names) >= 11

@pytest.mark.asyncio
async def test_mcp_query_tool():
    """Verify MCP query tool handles missing user_id and sector correctly."""
    with patch("openmemory.ai.mcp.mem.search", new_callable=AsyncMock) as mock_search:
        mock_search.return_value = [{"id": "m1", "content": "test", "score": 0.9, "primary_sector": "semantic", "sectors": ["semantic"], "salience": 0.8, "last_seen_at": 123, "meta": {}, "path": ""}]
        
        res = await handle_call_tool("openmemory_query", {"query": "test", "k": 5})
        
        assert len(res) == 2
        assert "Found 1 matches" in res[0].text
        mock_search.assert_called_with("test", user_id=None, limit=5)

@pytest.mark.asyncio
async def test_temporal_fact_create():
    """Verify temporal fact creation via MCP."""
    with patch("openmemory.ai.mcp.insert_fact", new_callable=AsyncMock) as mock_insert:
        mock_insert.return_value = "fact-123"
        
        args = {
            "subject": "OpenMemory",
            "predicate": "is",
            "object": "Hardened",
            "valid_from": "2025-01-01T12:00:00Z",
            "user_id": "user1"
        }
        
        res = await handle_call_tool("openmemory_temporal_fact_create", args)
        
        mock_insert.assert_called_once()
        call_kwargs = mock_insert.call_args.kwargs
        assert call_kwargs["user_id"] == "user1"
        assert "Created temporal fact fact-123" in res[0].text

@pytest.mark.asyncio
async def test_temporal_edge_query():
    """Verify temporal edge query via MCP."""
    with patch("openmemory.ai.mcp.query_edges", new_callable=AsyncMock) as mock_query:
        mock_query.return_value = [{"id": "e1", "weight": 0.9}]
        
        args = {
            "source_id": "f1",
            "target_id": "f2",
            "relation_type": "caused",
            "user_id": "user1"
        }
        
        res = await handle_call_tool("openmemory_temporal_edge_query", args)
        
        mock_query.assert_called_once()
        call_kwargs = mock_query.call_args[1]
        assert call_kwargs["source_id"] == "f1"
        assert "Found 1 edges" in res[0].text

# --- LangChain Integration Tests ---

@pytest.mark.asyncio
async def test_langchain_retriever():
    """Verify LangChain MemoryRetriever interacts with SDK correctly."""
    mock_mem = Mock(spec=Memory)
    mock_mem.search = AsyncMock(return_value=[
        Mock(id="m1", content="hello world", score=0.9, primary_sector="semantic", meta={}, salience=0.8)
    ])
    
    retriever = MemoryRetriever(mem=mock_mem, user_id="test_user", k=2)
    docs = retriever._get_relevant_documents("hello")
    
    assert len(docs) == 1
    assert docs[0].page_content == "hello world"
    mock_mem.search.assert_called()

@pytest.mark.asyncio
async def test_langchain_history():
    """Verify LangChain MemoryHistory logic."""
    mock_mem = Mock(spec=Memory)
    mock_mem.history = AsyncMock(return_value=[
        Mock(content="[AI] I am good."),
        Mock(content="[Human] how are you?")
    ])
    mock_mem.add = AsyncMock()
    
    history = MemoryHistory(memory=mock_mem, user_id="test_user")
    msgs = history.messages
    
    assert len(msgs) == 2
    from openmemory.integrations.agents import HumanMessage, AIMessage
    assert isinstance(msgs[0], HumanMessage)
    assert isinstance(msgs[1], AIMessage)

# --- CrewAI Integration Tests ---

@pytest.mark.asyncio
async def test_crewai_adapter():
    """Verify CrewAI adapter uses sync bridge correctly."""
    mock_mem = Mock(spec=Memory)
    mock_mem.add = AsyncMock(return_value={"id": "new-mid"})
    
    adapter = CrewAIMemory(memory=mock_mem, user_id="agent_1")
    adapter.save("important fact", metadata={"source": "thought"})
    
    mock_mem.add.assert_called_with("important fact", user_id="agent_1", meta={"source": "thought"})
