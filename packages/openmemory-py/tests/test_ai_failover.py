import pytest
from unittest.mock import AsyncMock, MagicMock
from openmemory.ai.adapters import FailoverAdapter
from openmemory.ai.exceptions import AIProviderError

@pytest.mark.asyncio
async def test_failover_logic_chat():
    # 1. Primary adapter fails
    primary = MagicMock()
    primary.chat = AsyncMock(side_effect=AIProviderError("Failed", "mock-a"))
    
    # 2. Secondary adapter succeeds
    secondary = MagicMock()
    secondary.chat = AsyncMock(return_value="Success from B")
    
    failover = FailoverAdapter([primary, secondary])
    
    res = await failover.chat([{"role": "user", "content": "hello"}])
    
    assert res == "Success from B"
    assert primary.chat.called
    assert secondary.chat.called

@pytest.mark.asyncio
async def test_failover_logic_embed_batch():
    primary = MagicMock()
    primary.embed_batch = AsyncMock(side_effect=Exception("Crash"))
    
    secondary = MagicMock()
    secondary.embed_batch = AsyncMock(return_value=[[0.1, 0.2]])
    
    failover = FailoverAdapter([primary, secondary])
    
    res = await failover.embed_batch(["hello"])
    
    assert res == [[0.1, 0.2]]
    assert primary.embed_batch.called
    assert secondary.embed_batch.called

@pytest.mark.asyncio
async def test_all_fail():
    primary = MagicMock()
    primary.chat = AsyncMock(side_effect=AIProviderError("Error A", "provider-a"))
    
    secondary = MagicMock()
    secondary.chat = AsyncMock(side_effect=AIProviderError("Error B", "provider-b"))
    
    failover = FailoverAdapter([primary, secondary])
    
    with pytest.raises(AIProviderError) as excinfo:
        await failover.chat([{"role": "user", "content": "hi"}])
    
    assert "provider-b" in str(excinfo.value)

if __name__ == "__main__":
    import asyncio
    async def run():
        await test_failover_logic_chat()
        await test_failover_logic_embed_batch()
        await test_all_fail()
        print("Failover tests passed!")
    asyncio.run(run())
