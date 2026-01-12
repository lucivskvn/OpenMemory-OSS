# Python SDK Reference

The `openmemory` package provides a pythonic interface to the OpenMemory system.

## Core Classes

### `Memory`

The main entry point.

```python
from openmemory.client import Memory

mem = Memory()
```

#### Methods

*   `add(content: str, user_id: str = "default", metadata: dict = None) -> dict`
    *   Stores a new memory.
    *   **Returns**: The created memory object (including ID).

*   `search(query: str, user_id: str, limit: int = 5) -> list[dict]`
    *   Retrieves relevant memories based on semantic similarity + recency.
    *   **Returns**: List of memory objects, sorted by score.

*   `delete(memory_id: str, user_id: str = None) -> bool`
    *   Removes a memory by ID. Checks ownership if `user_id` is provided.

*   `history(user_id: str, limit: int = 20, offset: int = 0) -> list[dict]`
    *   Returns the temporal chain of interactions for a user.

*   `import_memory(content: str, user_id: str, id: str = None, created_at: int = None, meta: dict = None, tags: list = None) -> dict`
    *   **Admin/Tooling**: Import a memory with explicit ID and Timestamp preservation.
    *   Bypasses deduplication if explicit `id` is provided. Suitable for backups and migration.

*   `list_users() -> list[str]`
    *   Returns a list of all active user IDs in the store.

### `MemoryClient`

The HTTP client for connecting to a remote OpenMemory server (e.g., Docker or Railway).
Fully async and mirrors the `Memory` API.

```python
from openmemory.client import MemoryClient

client = MemoryClient(base_url="http://localhost:8080", token="...")
await client.add("remote memory")
results = await client.search("query")
```

#### Methods

*   **Core**: `add`, `get`, `update`, `delete`, `search`, `list`, `list_users`, `import_memory`
*   **Ingestion**: 
    *   `ingest(content_type, data, user_id, metadata)`
    *   `ingest_url(url, user_id, metadata)`
*   **Temporal Graph**:
    *   `add_fact(subject, predicate, object, valid_from, confidence)`
    *   `add_edge(source_id, target_id, relation_type, weight)`
    *   `search_facts(pattern, type="all")`
*   **System**: `health()`


### `OpenAIWrapper`

A helper to automatically inject long-term memory into OpenAI API calls.

```python
from openmemory.openai_handler import OpenAIWrapper
from openai import OpenAI

client = OpenAIWrapper(OpenAI(), memory_instance)

# Use as normal - context is auto-injected system prompt
resp = client.chat.completions.create(...)
```

## Integrations

### LangChain

```python
from openmemory.integrations.langchain import OpenMemoryChatMessageHistory

history = OpenMemoryChatMessageHistory(user_id="u1")
history.add_user_message("Hi!")
```
