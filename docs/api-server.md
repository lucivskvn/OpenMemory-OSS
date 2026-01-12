# API Server Reference

OpenMemory exposes a high-performance REST API for integration with IDEs, Agents, and Dashboards.

**Base URL**: `http://localhost:8080` (default)
**Auth**: Header `x-api-key: <YOUR_API_KEY>`

## Core Memory Routes

### `POST /memory/add`
Ingests a new memory, automatically classifying and embedding it.
```json
{
  "content": "Refactored the login module to use OAuth2",
  "userId": "user_123", /* optional if single-tenant */
  "tags": ["refactor", "auth"],
  "metadata": { "file": "login.ts" }
}
```

### `POST /memory/query`
Hybrid semantic search with filtering.
```json
{
  "query": "authentication changes",
  "userId": "user_123",
  "limit": 5,
  "filters": { "sector": "procedural" }
}
```

### `GET /memory/all`
Lists memories with pagination and filtering.
- **Query Params**: `l` (limit), `u` (offset), `sector`, `userId`

### `GET /memory/:id`
Retrieves a memory, automatically decrypting content.

### `PATCH /memory/:id`
Updates a memory's confidence or metadata.
```json
{
  "confidence": 0.9,
  "metadata": { "status": "verified" }
}
```

### `DELETE /memory/:id`
Permanently deletes a memory.

### `POST /memory/ingest`
Ingests raw documents or special content types.
```json
{
    "contentType": "pdf",
    "data": "base64_string...",
    "metadata": { "filename": "spec.pdf" },
    "config": { "secSz": 1000 },
    "userId": "user_123"
}
```

### `POST /memory/ingest/url`
Extracts and ingests content from a URL.
```json
{
    "url": "https://example.com",
    "metadata": { "source": "web" },
    "userId": "user_123"
}
```

## IDE Integration Routes (`/api/ide`)

Designed for VS Code / JetBrains plugins.

- `POST /api/ide/events`: Log structured file events (open, save, edit) for implicit memory formation.
- `POST /api/ide/context`: Retrieve relevant coding context based on a query or file path.
- `POST /api/ide/session/start`: Initialize a coding session.
- `POST /api/ide/session/end`: Conclude a session and generate a summary.

## Dashboard Routes (`/dashboard`)

Powered by the OpenMemory Dashboard.

- `GET /dashboard/stats`: System-wide throughput, latency, and memory counts.
- `GET /dashboard/activity`: Real-time feed of memory operations (decay, consolidation, reflection).
- `GET /dashboard/top-memories`: High-salience memory retrieval.
- `GET /dashboard/health`: Liveness probe.

## Temporal Graph (`/api/temporal`)

- `GET /api/temporal/fact?subject=Alice`: Query facts.
- `GET /api/temporal/search?pattern=%&type=all&limit=100`: Query the knowledge graph.
    - `type`: `subject`, `predicate`, `object`, or `all` (default: `all`)
- `POST /api/temporal/fact`: Insert a new fact manually.
```json
{
    "subject": "User",
    "predicate": "has_role",
    "object": "Admin",
    "validFrom": "2024-01-01T00:00:00Z",
    "confidence": 1.0,
    "userId": "user_123"
}
```
- `POST /api/temporal/edge`: Insert a relationship edge.
```json
{
    "sourceId": "550e8400-e29b-41d4-a716-446655440000",
    "targetId": "770e8400-e29b-41d4-a716-446655440000",
    "relationType": "causes",
    "weight": 0.8
}
```

## Running the Server

### Python
```bash
python -m openmemory.main serve --port 8080
```

### Bun
```bash
bun start:server
```

### Docker
```bash
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... ghcr.io/caviraoss/openmemory:latest
```
