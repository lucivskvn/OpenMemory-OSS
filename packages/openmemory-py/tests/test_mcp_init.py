
import sys
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

def test_mcp_import_does_not_connect_db():
    # Remove module if already imported
    if "openmemory.ai.mcp" in sys.modules:
        del sys.modules["openmemory.ai.mcp"]
    if "openmemory.main" in sys.modules:
        del sys.modules["openmemory.main"]

    with patch("openmemory.core.db.db.connect") as mock_connect:
        from openmemory.ai import mcp  # type: ignore[import-untyped]
        
        # Should NOT have called connect
        mock_connect.assert_not_called()
        
        # Verify handle_call_tool signature
        import inspect
        sig = inspect.signature(mcp.handle_call_tool)
        assert "mem_inst" in sig.parameters

@pytest.mark.asyncio
async def test_run_mcp_server_initializes_memory():
    # We can't easily run the full server loop, but we can inspect the closure or 
    # mock Memory and see if it gets instantiated.
    
    with patch("openmemory.ai.mcp.Memory") as mock_mem_cls, \
         patch("openmemory.ai.mcp.Server") as mock_server_cls, \
         patch("openmemory.ai.mcp.start_reflection"), \
         patch("openmemory.ai.mcp.start_maintenance"), \
         patch("openmemory.ai.mcp.MCP_AVAILABLE", True), \
         patch("openmemory.ai.mcp.NotificationOptions", MagicMock()), \
         patch("openmemory.ai.mcp.stdio_server") as mock_stdio:
         
        # Make server.run awaitable
        mock_server_cls.return_value.run = AsyncMock()
         
        # Mock stdio_server context
        mock_context = AsyncMock()
        mock_context.__aenter__.return_value = (MagicMock(), MagicMock())
        mock_context.__aexit__.return_value = None
        mock_stdio.return_value = mock_context
        
        from openmemory.ai.mcp import run_mcp_server  # type: ignore[import-untyped]
        
        # Run the server function (it's async? No, 'def run_mcp_server' is sync in existing code? Let's check)
        # Ah, run_mcp_server definition in viewed code: "async def run_mcp_server():" at line 451.
        
        await run_mcp_server()
        
        # Memory should be instantiated
        mock_mem_cls.assert_called_once()
