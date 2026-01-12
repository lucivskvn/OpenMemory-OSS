# openmemory javascript sdk

> **real long-term memory for ai agents. not rag. not a vector db. self-hosted.**

[![npm version](https://img.shields.io/npm/v/openmemory-js.svg)](https://www.npmjs.com/package/openmemory-js)
[![license](https://img.shields.io/github/license/CaviraOSS/OpenMemory)](https://github.com/CaviraOSS/OpenMemory/blob/main/LICENSE)
[![discord](https://img.shields.io/discord/1300368230320697404?label=Discord)](https://discord.gg/P7HaRayqTh)

openmemory is a **cognitive memory engine** for llms and agents.

- 🧠 real long-term memory (not just embeddings in a table)
- 💾 self-hosted, local-first (sqlite / postgres)
- 🧩 integrations: mcp, claude desktop, cursor, windsurf
- 📥 sources: github, notion, google drive, onedrive, web crawler
- 🔍 explainable traces (see *why* something was recalled)

your model stays stateless. **your app stops being amnesiac.**

---

## system requirements

- **Runtime**: [Bun](https://bun.sh) v1.1+ (Recommended) or Node.js v20+
- **Database**: SQLite (built-in) or PostgreSQL (optional w/ pgvector)
- **Hardware**: Nvidia GPU (Optional) via Docker Toolkit for accelerated inference.

## Usage Patterns

OpenMemory can be used in two ways:
1. **Embedded / Local**: Import directly into your Node/Bun app. No server required.
2. **Client / Remote**: Connect to a running OpenMemory server via HTTP.

### 1. Embedded (Local)
Best for CLIs, local tools, or single-instance backends.

```typescript
import { Memory } from "openmemory-js";

// Initialize local engine (uses SQLite by default)
const mem = new Memory({ user_id: "u1" });

// Add a memory
await mem.add("user prefers dark mode", {
    tags: ["ui", "preference"],
    metadata: { source: "settings_page" }
});

// Search
const results = await mem.search("what is the user preference?");
console.log(results[0].content);
```

### 2. Client SDK (Remote)
Best for distributed apps, web frontends, or microservices connecting to a shared OpenMemory server.

```typescript
import { MemoryClient } from "openmemory-js";

// Connect to server (defaults to http://localhost:8080)
const client = new MemoryClient({
    baseUrl: "http://localhost:8080",
    apiKey: "your-api-key"
});

// Real-time Event Stream
client.listen((event) => {
    if (event.type === 'memory_added') {
        console.log(`New Memory: ${event.data.content}`);
    }
});

// Add Memory via API
await client.add("project deadline is friday");
```

---

## 🔒 security & encryption

openmemory supports **AES-256-GCM encryption at rest** for sensitive data.

```bash
export OM_ENCRYPTION_ENABLED=true
export OM_ENCRYPTION_KEY=your-32-char-secret-key-must-be-long-enough-123
```

On startup, OpenMemory performs a **Key Verification** check to ensure your key is valid and encryption roundtrips (encrypt -> decrypt) are successful. If this check fails, the server will warn you.

when enabled, all memory content is encrypted before storage and decrypted only upon retrieval. vector embeddings remain unencrypted for searchability but contain no raw text.

### 🔑 Authentication & RBAC

Secure your memory server with granular access control:

```bash
# Admin Key (Full Access: memory:*, admin:*)
OM_ADMIN_KEY=your-super-secret-admin-key

# Standard API Key (Read/Write Memory)
OM_API_KEY=your-app-key
```

- **Admin Key**: Grants `admin:all` scope. Can manage system settings and view audit logs.
- **API Key**: Grants `memory:read` and `memory:write` scopes. Ideal for client applications.

> [!NOTE]
> **Admin Masquerade**: If you authenticate with an **Admin Key**, you can perform actions on behalf of other users by passing `userId` in the options of any method (e.g. `client.add(..., { userId: 'other' })`).

> [!IMPORTANT]
> **Production Safety**: When running in `NODE_ENV=production`, `OM_API_KEY` or `OM_ADMIN_KEY` **MUST** be set. The server will refuse to start without them to prevent insecure deployments.

### 🕵️ Audit Logging

All write operations (POST, PUT, DELETE) are automatically logged as Immutable Facts in the **Temporal Graph**.
You can query usage history using the temporal API:

```typescript
// Who deleted memory X?
const history = await mem.temporal.history("memory:uuid-123");
```

## 📥 sources (connectors)

ingest data from external sources directly into memory:

```typescript
const github = await mem.source("github")
await github.connect({ token: "ghp_..." })
await github.ingest_all({ repo: "owner/repo" })
```

available sources: `github`, `notion`, `google_drive`, `google_sheets`, `google_slides`, `onedrive`, `web_crawler`

---

## features

✅ **local-first** - runs entirely on your machine, zero external dependencies  
✅ **multi-sector memory** - episodic, semantic, procedural, emotional, reflective  
✅ **temporal knowledge graph** - time-aware facts with validity periods  
✅ **memory decay** - adaptive forgetting with sector-specific rates  
✅ **waypoint graph** - associative recall paths for better retrieval  
✅ **explainable traces** - see exactly why memories were recalled  
✅ **hardware aware** - auto-detects Nvidia GPUs in Docker for 10x faster inference  
✅ **zero config** - works out of the box with sensible defaults  

---

## cognitive sectors

openmemory automatically classifies content into 5 cognitive sectors:

| sector | description | examples | decay rate |
|--------|-------------|----------|------------|
| **episodic** | time-bound events & experiences | "yesterday i attended a conference" | medium |
| **semantic** | timeless facts & knowledge | "paris is the capital of france" | very low |
| **procedural** | skills, procedures, how-tos | "to deploy: build, test, push" | low |
| **emotional** | feelings, sentiment, mood | "i'm excited about this project!" | high |
| **reflective** | meta-cognition, insights | "i learn best through practice" | very low |

---

## configuration

### environment variables

```bash
# database
OM_DB_PATH=./data/om.db              # sqlite file path (default: ./data/openmemory.sqlite)
OM_DB_URL=sqlite://:memory:          # or use in-memory db

# embeddings
OM_EMBEDDINGS=ollama                 # synthetic | openai | gemini | ollama
OM_OLLAMA_URL=http://localhost:11434
OM_OLLAMA_MODEL=llama3.2             # Default: Llama 3.2 (3B)

# openai
OPENAI_API_KEY=sk-...
OM_OPENAI_MODEL=text-embedding-3-small

# gemini
GEMINI_API_KEY=AIza...

# performance tier
OM_TIER=deep                         # fast | smart | deep | hybrid
OM_VEC_DIM=768                       # vector dimension (must match model)

# metadata backend (optional)
OM_METADATA_BACKEND=postgres         # sqlite (default) | postgres
OM_PG_HOST=localhost
OM_PG_PORT=5432
OM_PG_DB=openmemory
OM_PG_USER=postgres
OM_PG_PASSWORD=...

# vector backend (optional)
OM_VECTOR_BACKEND=valkey             # default uses metadata backend
OM_VALKEY_URL=redis://localhost:6379
```

### programmatic usage

```typescript
import { Memory } from 'openmemory-js';

const mem = new Memory('user-123');  // optional user_id

// add memories
await mem.add(
    "user prefers dark mode",
    {
        tags: ["preference", "ui"],
        created_at: Date.now()
    }
);

// search
const results = await mem.search("user settings", {
    user_id: "user-123",
    limit: 10,
    sectors: ["semantic", "procedural"]
});

// get by id
const memory = await mem.get("uuid-here");

// wipe all data (useful for testing)
await mem.wipe();
```

---

## performance tiers

- `fast` - synthetic embeddings (no api calls), instant
- `smart` - hybrid semantic + synthetic for balanced speed/accuracy
- `deep` - pure semantic embeddings for maximum accuracy
- `hybrid` - adaptive based on query complexity

---

## mcp server

openmemory-js includes an mcp server for integration with claude desktop, cursor, windsurf, and other mcp clients:

```bash
npx openmemory-js serve --port 3000
```

### claude desktop / cursor / windsurf

```json
{
  "mcpServers": {
    "openmemory": {
      "command": "npx",
      "args": ["openmemory-js", "serve"]
    }
  }
}

### Intelligent Sectoring
OpenMemory now uses a **Learned Classifier** to automatically organize memories.
- **Auto-Sectoring**: If you don't specify a sector, the system predicts one based on your history.
- **Manual Training**: Use `opm train <userId>` to force a re-training session.

### CLI
The `opm` CLI tool manages your OpenMemory instance.

```bash
# Add a memory
opm add "I need to buy groceries" --user_id=alice

# Check System Health
opm doctor

# Train Classifier
opm train alice

# Wipe all data
opm wipe
```

available mcp tools:

- `openmemory_query` - search memories
- `openmemory_store` - add new memories
- `openmemory_list` - list all memories
- `openmemory_get` - get memory by id
- `openmemory_reinforce` - reinforce a memory
- `openmemory_ide_context` - get relevant context for code files
- `openmemory_ide_patterns` - get detected coding patterns

### ⚡ Real-time Stream (SSE)
Connect to the real-time event stream to receive live updates (new memories, suggested patterns). 
The `MemoryClient` provides a strictly typed `listen()` method.

```typescript
import { MemoryClient } from 'openmemory-js';

const client = new MemoryClient();

client.listen((event) => {
    switch (event.type) {
        case 'memory_added':
            console.log(`New Memory: ${event.data.content} (${event.data.id})`);
            break;
        case 'ide_suggestion':
            console.log(`Suggestion: ${event.data.topPattern.description}`);
            console.log(`Confidence: ${event.data.topPattern.salience}`);
            break;
        case 'ide_session_update':
            console.log(`Session ${event.data.sessionId}: ${event.data.status}`);
            break;
    }
}, { subscribe: 'all' }); // Optional: 'all' for Firehose (Admin only), or 'userId' to watch specific user.
```

**Event Types:**
- `memory_added`: Triggered when new content is stored.
- `memory_updated`: Triggered when content matches an existing memory and updates it.
- `ide_suggestion`: Triggered when the AI detects a relevant pattern for the current context.
- `ide_session_update`: Triggered when an IDE session starts or ends.

See `examples/ide_plugin_demo.ts` for a full working implementation.

---

## examples

```typescript
// multi-user support
const mem = new Memory();
await mem.add("alice likes python", { user_id: "alice" });
await mem.add("bob likes rust", { user_id: "bob" });

const alicePrefs = await mem.search("what does alice like?", { user_id: "alice" });
// returns python results only

// temporal filtering
const recent = await mem.search("user activity", {
    startTime: Date.now() - 86400000,  // last 24 hours
    endTime: Date.now()
});

// sector-specific queries
const facts = await mem.search("company info", { sectors: ["semantic"] });
const howtos = await mem.search("deployment", { sectors: ["procedural"] });
```

---

## api reference

### `new Memory(user_id?: string)`

create a new memory instance with optional default user_id.

### `async add(content: string, options?: MemoryOptions): Promise<MemoryItem>`

store a new memory.

**parameters:**
- `content` - text content to store
- `options` - optional object:
  - `user_id` - override default user
  - `tags` - array of tag strings
  - `[key: string]` - any other custom metadata

### `async search(query: string, options?: SearchOptions): Promise<MemoryItem[]>`

search for relevant memories.

**parameters:**
- `query` - search text
- `options`:
  - `user_id` - filter by user
  - `limit` - max results (default: 10)
  - `sectors` - array of sectors to search (e.g., `["episodic", "semantic"]`)

### `async ingest(options: IngestOptions): Promise<void>`

ingest documents or raw text.

```typescript
```typescript
await mem.ingest({
  contentType: "txt",
  data: "full document text...",
  metadata: { filename: "notes.txt" }
})
```

### `async update(id: string, content?: string, tags?: string[], meta?: object)`

update an existing memory.

### `async reinforce(id: string, boost?: number)`

reinforce a memory's salience (importance) manually.

### `async delete(id: string)`

delete a specific memory.

### `async delete_all(user_id?: string)`

**danger**: delete all memories for a specific user. required for privacy/cleanup.

### `async wipe()`

**deprecated**: destroys the ENTIRE database. use only for testing.

### `get temporal`

Access temporal graph features:
- `add(subject, predicate, object, opts)`
- `get(subject, predicate)`
- `search(pattern, opts)`
- `history(subject)`
- `updateFact(id, updates)`: modify confidence or metadata
- `updateEdge(id, updates)`: modify weight or metadata
- `invalidateFact(id)`: close a fact's validity period
- `invalidateEdge(id)`: close an edge's validity period
- `compare(subject, time1, time2)`: see specific changes between timestamps
- `timeline(subject)`: full chronological event list
427: 
### `get compression`

Access optimization features:
- `compress(text, algo)`: "semantic" (default), "syntactic", or "aggressive"
- `batch(texts, algo)`: compress multiple strings
- `analyze(text)`: compare all compression algorithms
- `stats()`: get global savings statistics

---

### `async registerUser(userId: string, scope?: "admin" | "user")` (Admin Only)

Manage users and authentication keys (requires `admin:all` scope).

```typescript
// Register a new user
const { apiKey } = await client.registerUser("new-user", "user");

// List all API keys
const keys = await client.listApiKeys();

// Revoke a key
await client.revokeApiKey("om_123...");

// Data Portability (Backup/Restore)
const blob = await client.exportData(); // NDJSON Stream
await client.importDatabase(blob);     // Restore (renamed from importData)

/**
 * System Health & Limits
 * - Dashboard: Visit /dashboard
 * - CLI: opm ingest-av (100MB limit)
 * - Health: opm doctor
 */
```

### `LangGraph Integration`

Native support for LangGraph memory nodes.

```typescript
// Store a graph node state
await client.lgStore("agent_conversation", "User asked for python helper", {
    graphId: "thread_123"
});

// Reflect on graph state
const reflection = await client.lgReflect("agent_conversation", "thread_123", {
    depth: "deep"
});
```

### `IDE Integration`

Integrate with code editors/IDEs.

```typescript
// Start an IDE session
await client.startIdeSession({
    projectName: "my-project", 
    ideName: "vscode"
});

// Send an event (e.g., file save, compile)
await client.sendIdeEvent({
    sessionId: "session-123",
    eventType: "save",
    filePath: "/path/to/script.ts",
    metadata: { project: "my-project" }
});

// Get context for the current file
const context = await client.getIdeContext("cursor position or query", {
    filePath: "/path/to/script.ts"
});
```

---

## license

Apache 2.0

---

## links

- [main repository](https://github.com/CaviraOSS/OpenMemory)
- [python sdk](https://pypi.org/project/openmemory-py/)
- [vs code extension](https://marketplace.visualstudio.com/items?itemName=Nullure.openmemory-vscode)
- [documentation](https://openmemory.cavira.app/docs/sdks/javascript)
- [discord](https://discord.gg/P7HaRayqTh)
