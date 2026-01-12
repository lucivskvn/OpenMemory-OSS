import pytest
import asyncio
from openmemory.trace import Tracer, traced

@pytest.mark.asyncio
async def test_trace_context_propagation():
    # 1. Start a root span
    with Tracer.start_span("root_op", user_id="test_user_123") as root_span:
        assert root_span.name == "root_op"
        assert root_span.user_id == "test_user_123"
        
        # 2. Call nested async function
        await nested_op()
        
        # 3. Verify current span is root again
        current = Tracer.current_span()
        assert current.id == root_span.id

@traced("nested_op")
async def nested_op():
    # Verify we are in a child span
    span = Tracer.current_span()
    assert span is not None
    assert span.name == "nested_op"
    assert span.user_id == "test_user_123" # Propagated
    assert span.parent_id is not None
    
    # Verify parent linkage
    # We can't easily access the parent object from here without modifying Tracer to expose it,
    # but we can check the trace_id matches
    # trace_id should be consistent
    # We need to capture the parent trace_id to compare? 
    # Actually Span doesn't expose parent object, but it has parent_id.
    pass

@pytest.mark.asyncio
async def test_tracing_decorator():
    result = await decorated_func(user_id="user_abc")
    assert result == "done"

@traced("decorated")
async def decorated_func(**kwargs):
    span = Tracer.current_span()
    assert span.user_id == "user_abc"
    assert span.name == "decorated"
    return "done"
