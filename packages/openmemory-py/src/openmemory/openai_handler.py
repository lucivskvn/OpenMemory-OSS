from typing import Any, List, Dict, Optional, Union, Callable, Awaitable
import logging
import asyncio
import json

logger = logging.getLogger("openmemory.client")

class OpenAIRegistrar:
    def __init__(self, memory_instance):
        self.mem = memory_instance

    def register(self, client: Any, user_id: Optional[str] = None):
        try:
            original_create = client.chat.completions.create
        except AttributeError:
            return client

        memory = self.mem
        is_async = hasattr(client, "_is_async") and client._is_async

        if is_async:
            async def wrapped_create(*args, **kwargs):
                messages = [m.copy() for m in kwargs.get("messages", [])]
                uid = user_id or memory.default_user
                if messages and uid:
                    try:
                        last_msg = messages[-1]
                        if last_msg.get("role") == "user":
                            query = last_msg.get("content")
                            if isinstance(query, str):
                                context = await memory.search(query, user_id=uid, limit=3)
                                if context:
                                    ctx_text = "\n".join([f"- {m['content']}" for m in context])
                                    instr = f"\n\n[CONTEXT FROM MEMORY]\n{ctx_text}\n[END CONTEXT]"

                                    # Inject into the last user message if possible, or system message
                                    if messages[-1].get("role") == "user":
                                        messages[-1]["content"] += instr
                                    elif messages[0].get("role") == "system":
                                        messages[0]["content"] += instr
                                    else:
                                        messages.insert(0, {"role": "system", "content": f"Use the following memory context where relevant:{instr}"})
                                    kwargs["messages"] = messages
                    except Exception as e:
                        logger.exception(f"failed to retrieve memory: {e}")

                response = await original_create(*args, **kwargs)
                try:
                    query = messages[-1].get("content") if messages else ""
                    answer = response.choices[0].message.content
                    asyncio.create_task(memory.add(f"user: {query}\nassistant: {answer}", user_id=uid))
                except Exception as e:
                    logger.warning(f"failed to store interaction: {e}")
                return response

            wrapper = wrapped_create
        else:
            def wrapped_create_sync(*args, **kwargs):
                messages = [m.copy() for m in kwargs.get("messages", [])]
                uid = user_id or memory.default_user
                if messages and uid:
                    try:
                        last_msg = messages[-1]
                        if last_msg.get("role") == "user":
                            query = last_msg.get("content")
                            if isinstance(query, str):
                                try:
                                    loop = None
                                    try:
                                        loop = asyncio.get_event_loop()
                                    except RuntimeError:
                                        # No loop in this thread
                                        pass

                                    if loop and loop.is_running():
                                        context = asyncio.run_coroutine_threadsafe(memory.search(query, user_id=uid, limit=3), loop).result()
                                    else:
                                        # Create a temporary loop if needed, or use a bridge
                                        context = asyncio.run(memory.search(query, user_id=uid, limit=3))

                                    if context:
                                        ctx_text = "\n".join([f"- {m['content']}" for m in context])
                                        instr = f"\n\n[CONTEXT FROM MEMORY]\n{ctx_text}\n[END CONTEXT]"
                                        if messages[-1].get("role") == "user":
                                            messages[-1]["content"] += instr
                                        elif messages[0].get("role") == "system":
                                            messages[0]["content"] += instr
                                        else:
                                            messages.insert(0, {"role": "system", "content": f"Use the following memory context where relevant:{instr}"})
                                        kwargs["messages"] = messages
                                except Exception as e:
                                    logger.debug(f"Sync context retrieval failed: {e}")
                    except Exception:
                        pass

                response = original_create(*args, **kwargs)
                try:
                    query = messages[-1].get("content") if messages else ""
                    answer = response.choices[0].message.content

                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            asyncio.run_coroutine_threadsafe(memory.add(f"user: {query}\nassistant: {answer}", user_id=uid), loop)
                        else:
                            asyncio.run(memory.add(f"user: {query}\nassistant: {answer}", user_id=uid))
                    except Exception:
                        asyncio.run(memory.add(f"user: {query}\nassistant: {answer}", user_id=uid))
                except Exception:
                    pass
                return response

            wrapper = wrapped_create_sync

        # Assign the correct wrapper based on sync/async client
        client.chat.completions.create = wrapper
        return client
