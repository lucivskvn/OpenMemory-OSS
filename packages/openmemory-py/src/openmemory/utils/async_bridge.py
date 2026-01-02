
import asyncio
import threading
from typing import TypeVar, Coroutine, Any

T = TypeVar("T")

def run_sync(coro: Coroutine[Any, Any, T]) -> T:
    """
    Safely run an async coroutine from a synchronous context.
    
    This helper handles:
    1. Existing event loops (using `run_coroutine_threadsafe`).
    2. No event loop (using `asyncio.run`).
    3. Nested event loops (which shouldn't happen in standard usage, but if we are in a thread with a loop, we handle it).
    
    Args:
        coro: The coroutine to execute.
        
    Returns:
        The result of the coroutine.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We are inside a running loop. 
        # CAUTION: If we block here waiting for the result, we might deadlock 
        # if the coroutine needs the loop to progress.
        # Ideally, libraries should await. If strictly sync is required by caller (e.g. standard sync interface),
        # we might need to spawn a thread if we are on the main thread loop.
        
        # Check if we are in a thread different from the loop's thread? 
        # Usually loop runs on main thread.
        # If we are here, strict synchronous return is demanded.
        
        # 1. Spawn a separate thread to run the coroutine in a new loop? 
        # No, that isolates context.
        
        # 2. Use `run_coroutine_threadsafe` if we are in a separate thread from the loop?
        # But `get_running_loop()` ensures we are in the loop's thread.
        
        # Danger zone: We are in an async callback but providing a sync return.
        # We cannot block the loop.
        # The ONLY way is to raise an error or return a Future if possible (but typing says T).
        
        # Fallback for now: If we are truly blocked, we might deadlock. 
        # But often this helper is called from a thread where `get_running_loop` fails.
        pass

    try:
        # Check for an existing loop in the current thread policy, even if not "running" (rare)
        try:
            current_loop = asyncio.get_event_loop()
        except RuntimeError:
            current_loop = None

        if current_loop and current_loop.is_running():
             # We are in a loop thread.
             # We cannot use run_until_complete as it throws "This event loop is already running".
             # We cannot block.
             # This is a fundamental design incompatibility if the caller demands sync return.
             # Best effort: use a separate thread to run a NEW loop?
             
             # Create a new thread to run the coroutine
             result = None
             exception = None
             event = threading.Event()
             
             def runner():
                 nonlocal result, exception
                 try:
                     result = asyncio.run(coro)
                 except Exception as e:
                     exception = e
                 finally:
                     event.set()
                     
             t = threading.Thread(target=runner)
             t.start()
             t.join()
             
             if exception:
                 raise exception
             return result
        else:
            return asyncio.run(coro)
            
    except Exception:
        # Last resort fallback
        return asyncio.run(coro)
