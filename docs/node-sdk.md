# JavaScript SDK Reference

The `openmemory-js` package provides a TypeScript/JavaScript interface.

## Installation

```bash
bun add openmemory-js
```

## Usage

```typescript
import { Memory } from 'openmemory-js';

const mem = new Memory();
```

### API

#### `mem.add(content, options)`

Stores a memory.

- `content` (string): The text to memorize.
- `options.userId` (string): The owner of the memory.
- `options.tags` (string[]): Optional tags.

```javascript
await mem.add("User likes spicy food", { 
  userId: "user_1", 
  tags: ["food", "preference"] 
});
```

#### `mem.search(query, options)`

Retrieves relevant context.

- `query` (string): The question or topic.
- `options.userId` (string): Required.
- `options.limit` (number): Max results (default 5).

```javascript
const results = await mem.search("What food to order?", { userId: "user_1" });
console.log(results[0].content); 
// "User likes spicy food"
```

#### `mem.get(id)`

Retrieve a memory by its unique ID. Returns a `Memory` object or `undefined`.

#### `mem.delete(id)`

Permanently deletes a memory by its ID.

#### `mem.list(limit?, offset?)`

List all memories for the current user (if `userId` was set in constructor) or all memories in the system.

#### `mem.listUsers()`

Returns an array of all unique user IDs present in the memory store.

#### `mem.importMemory(content, options)`

**Admin/Tooling only.** Import a memory with forced ID and timestamp.

- `content` (string)
- `options`: Same as `add` plus:
  - `id` (string): Force specific UUID.
  - `createdAt` (number): Force creation timestamp.

```javascript
await mem.importMemory("Historic event", {
  userId: "admin",
  id: "uuid-123",
  createdAt: 1600000000000
});
```

#### `mem.deleteAll(userId?)`

Deletes ALL memories for a specific user. Use with caution.

### `MemoryClient` (HTTP)

Use this when connecting to a remote OpenMemory server (e.g. Docker, Railway).

```typescript
import { MemoryClient } from 'openmemory-js';

const client = new MemoryClient({
  baseUrl: "http://localhost:8080",
  token: "my-secret-key"
});

await client.add("Remote memory");
const isHealthy = await client.health();
```

#### Methods

- `add`, `search`, `get`, `update`, `delete`, `list`, `listUsers`
- `ingestUrl(url, options)`: Ingest content from a URL.
  - `options.config.userAgent`: Custom User-Agent string.

```typescript
await client.ingestUrl("https://example.com", { 
  config: { userAgent: "MyBot/1.0" } 
});
```

- `importMemory(content, options)`: Admin import with forced ID.

- `ingest(contentType, data, options)`: Ingest raw documents.
- `reinforce(id, boost)`: Provide feedback on memory relevance.
- `health()`: Check server status.

### Temporal Graph API

Accessed via `mem.temporal` namespace.

```typescript
// Add a fact
await mem.temporal.add("User", "likes", "Spicy Code");

// Add an edge
await mem.temporal.addEdge(factId1, factId2, "caused_by", { weight: 0.9 });

// Search
const facts = await mem.temporal.search("Spicy%");
```

- `mem.temporal.add(sub, pred, obj, opts)`
- `mem.temporal.get(sub, pred)`
- `mem.temporal.search(pattern, opts)`
- `mem.temporal.history(subject)`
- `mem.temporal.addEdge(src, tgt, rel, opts)`
- `mem.temporal.getEdges(src, tgt, rel)`

### Dashboard & Admin API

- `getStats()`: System-wide statistics.

- `getActivity(limit)`: Recent operations log.
- `getTopMemories(limit)`: High-salience memories.
- `getSectorTimeline(hours)`: Memory distribution over time.
- `getMaintenanceStats(hours)`: Decay and reflection metrics.

## Server Mode

The Node package also contains the API server.

```bash
# Start the server on port 8080
bunx openmemory-js serve
# or
bunx opm serve
```
