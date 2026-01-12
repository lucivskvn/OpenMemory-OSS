import asyncio
import threading
from typing import TypeVar, Coroutine, Any

T = TypeVar("T")

def run_sync(coro: Coroutine[Any, Any, T]) -> T:
    """
    Safely run an async coroutine from a synchronous context.
    
    This helper handles:
    1. Existing event loops (using thread-based approach to avoid deadlock).
    2. No event loop (using `asyncio.run`).
    
    Args:
        coro: The coroutine to execute.
        
    Returns:
        The result of the coroutine.
    """
    # Check if there's already a running event loop
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We are inside a running loop - cannot use run_until_complete
        # Spawn a separate thread to run the coroutine in a new loop
        result: Any = None
        exception: BaseException | None = None

        def runner() -> None:
            nonlocal result, exception
            try:
                result = asyncio.run(coro)
            except Exception as e:
                exception = e

        t = threading.Thread(target=runner)
        t.start()
        t.join()

        if exception:
            raise exception
        return result
    else:
        # No running loop - use asyncio.run directly
        return asyncio.run(coro)
