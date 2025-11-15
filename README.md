<!-- markdownlint-disable MD033 MD041 MD022 MD034 MD026 MD040 MD024 MD036 MD010 -->
<img width="1577" height="781" alt="image" src="https://github.com/user-attachments/assets/3baada32-1111-4c2c-bf13-558f2034e511" />

# OpenMemory

Long-term memory for AI systems. Open source, self-hosted, and explainable.

Note: Backend-specific operational and deployment guidance (including API key hashing and helper scripts) is consolidated in `backend/README.md`. If you manage or deploy the server, start there.

Recent changes and release notes are maintained in `CHANGELOG.md` — see that file for a concise list of implemented features, fixes, and migration guidance.

⚠️ **Upgrading from v1.1?** Multi-user tenant support requires database migration. See [MIGRATION.md](./MIGRATION.md) for upgrade instructions.

[VS Code Extension](https://marketplace.visualstudio.com/items?itemName=Nullure.openmemory-vscode) • [Report Bug](https://github.com/lucivskvn/openmemory-OSS/issues) • [Request Feature](https://github.com/lucivskvn/openmemory-OSS/issues) • [Discord server](https://discord.gg/P7HaRayqTh)

---

## 1. Overview

OpenMemory gives AI systems persistent memory. It stores what matters, recalls it when needed, and explains why it matters.

Unlike traditional vector databases, OpenMemory uses a cognitive architecture. It organizes memories by type (semantic, episodic, procedural, emotional, reflective), tracks importance over time, and builds associations between related memories.

### Key Features

- **Multi-sector memory** - Different memory types for different content
- **Automatic decay** - Memories fade naturally unless reinforced
- **Graph associations** - Memories link to related memories
- **Temporal knowledge graph** - Time-aware relationships with fact evolution and historical reasoning
- **Pattern recognition** - Finds and consolidates similar memories
- **User isolation** - Each user gets a separate memory space
- **Local or cloud** - Run with your own embeddings or use OpenAI/Gemini
- **Framework agnostic** - Works with any LLM or agent system

### Uses
**We are featuring projects that use OpenMemory here. To get your project displayed, please email nullureq@gmail.com**

### VS Code Extension

The OpenMemory extension tracks your coding activity and gives AI assistants access to your project history.

**[Get it on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Nullure.openmemory-vscode)**

Works with GitHub Copilot, Cursor, Claude Desktop, Windsurf, and any MCP-compatible AI.

Features:

- Tracks file edits, saves, and opens
- Compresses context to reduce token usage by 30-70%
- Query responses under 80ms
- Supports Direct HTTP and MCP protocol modes
- Zero configuration required

### Architecture

OpenMemory uses Hierarchical Memory Decomposition (HMD):

- One canonical node per memory (no duplication)
- Multiple embeddings per memory (one per sector)
- Single-waypoint linking between memories
- Composite similarity scoring across sectors

This approach improves recall accuracy while reducing costs.

---

## 2. Competitor Comparison

| **Feature / Metric**                     | **OpenMemory (Our Tests – Nov 2025)**                       | **Zep (Their Benchmarks)**         | **Supermemory (Their Docs)**    | **Mem0 (Their Tests)**        | **OpenAI Memory**          | **LangChain Memory**        | **Vector DBs (Chroma / Weaviate / Pinecone)** |
| ---------------------------------------- | ----------------------------------------------------------- | ---------------------------------- | ------------------------------- | ----------------------------- | -------------------------- | --------------------------- | --------------------------------------------- |
| **Open-source License**                  | ✅ Apache 2.0                                               | ✅ Apache 2.0                      | ✅ Source available (GPL-like)  | ✅ Apache 2.0                 | ❌ Closed                  | ✅ Apache 2.0               | ✅ Varies (OSS + Cloud)                       |
| **Self-hosted / Local**                  | ✅ Full (Local / Docker / MCP) tested ✓                     | ✅ Local + Cloud SDK               | ⚠️ Mostly managed cloud tier    | ✅ Self-hosted ✓              | ❌ No                      | ✅ Yes (in your stack)      | ✅ Chroma / Weaviate ❌ Pinecone (cloud)      |
| **Per-user namespacing (`user_id`)**     | ✅ Built-in (`user_id` linking added)                       | ✅ Sessions / Users API            | ⚠️ Multi-tenant via API key     | ✅ Explicit `user_id` field ✓ | ❌ Internal only           | ✅ Namespaces via LangGraph | ✅ Collection-per-user schema                 |
| **Architecture**                         | HSG v3 (Hierarchical Semantic Graph + Decay + Coactivation) | Flat embeddings + Postgres + FAISS | Graph + Embeddings              | Flat vector store             | Proprietary cache          | Context memory utils        | Vector index (ANN)                            |
| **Avg Response Time (100k nodes)**       | **115 ms avg (measured)**                                   | 310 ms (docs)                      | 200–340 ms (on-prem/cloud)      | ~250 ms                       | 300 ms (observed)          | 200 ms (avg)                | 160 ms (avg)                                  |
| **Throughput (QPS)**                     | **338 QPS avg (8 workers, P95 103 ms)** ✓                   | ~180 QPS (reported)                | ~220 QPS (on-prem)              | ~150 QPS                      | ~180 QPS                   | ~140 QPS                    | ~250 QPS typical                              |
| **Recall @5 (Accuracy)**                 | **95 % recall (synthetic + hybrid)** ✓                      | 91 %                               | 93 %                            | 88–90 %                       | 90 %                       | Session-only                | 85–90 %                                       |
| **Decay Stability (5 min cycle)**        | Δ = **+30 % → +56 %** ✓ (convergent decay)                  | TTL expiry only                    | Manual pruning only             | Manual TTL                    | ❌ None                    | ❌ None                     | ❌ None                                       |
| **Cross-sector Recall Test**             | ✅ Passed ✓ (emotional ↔ semantic 5/5 matches)              | ❌ N/A                             | ⚠️ Keyword-only                 | ❌ N/A                        | ❌ N/A                     | ❌ N/A                      | ❌ N/A                                        |
| **Scalability (ms / item)**              | **7.9 ms/item @10k+ entries** ✓                             | 32 ms/item                         | 25 ms/item                      | 28 ms/item                    | 40 ms (est.)               | 20 ms (local)               | 18 ms (optimized)                             |
| **Consistency (2863 samples)**           | ✅ Stable ✓ (0 variance >95%)                               | ⚠️ Medium variance                 | ⚠️ Moderate variance            | ⚠️ Inconsistent               | ❌ Volatile                | ⚠️ Session-scoped           | ⚠️ Backend dependent                          |
| **Decay Δ Trend**                        | **Stable decay → equilibrium after 2 cycles** ✓             | TTL drop only                      | Manual decay                    | TTL only                      | ❌ N/A                     | ❌ N/A                      | ❌ N/A                                        |
| **Memory Strength Model**                | Salience + Recency + Coactivation ✓                         | Simple recency                     | Frequency-based                 | Static                        | Proprietary                | Session-only                | Distance-only                                 |
| **Explainable Recall Paths**             | ✅ Waypoint graph trace ✓                                   | ❌                                 | ⚠️ Graph labels only            | ❌ None                       | ❌ None                    | ❌ None                     | ❌ None                                       |
| **Cost / 1M tokens (hosted embeddings)** | ~$0.35 (synthetic + Gemini hybrid ✓)                        | ~$2.2                              | ~$2.5+                          | ~$1.2                         | ~$3.0                      | User-managed                | User-managed                                  |
| **Local Embeddings Support**             | ✅ (Ollama / E5 / BGE / synthetic fallback ✓)               | ⚠️ Partial                         | ✅ Self-hosted tier ✓           | ✅ Supported ✓                | ❌ None                    | ⚠️ Optional                 | ✅ Chroma / Weaviate ✓                        |
| **Ingestion Formats**                    | ✅ PDF / DOCX / TXT / Audio / Web ✓                         | ✅ API ✓                           | ✅ API ✓                        | ✅ SDK ✓                      | ❌ None                    | ⚠️ Manual ✓                 | ⚠️ SDK specific ✓                             |
| **Scalability Model**                    | Sector-sharded (semantic / episodic / etc.) ✓               | PG + FAISS cloud ✓                 | PG shards (cloud) ✓             | Single node                   | Vendor scale               | In-process                  | Horizontal ✓                                  |
| **Deployment**                           | Local / Docker / Cloud ✓                                    | Local + Cloud ✓                    | Docker / Cloud ✓                | Node / Python ✓               | Cloud only ❌              | Python / JS SDK ✓           | Docker / Cloud ✓                              |
| **Data Ownership**                       | 100 % yours ✓                                               | Vendor / self-host split ✓         | Partial ✓                       | 100 % yours ✓                 | Vendor ❌                  | Yours ✓                     | Yours ✓                                       |
| **Use-case Fit**                         | Long-term AI agents, copilots, journaling ✓                 | Enterprise RAG assistants ✓        | Cognitive agents / journaling ✓ | Basic agent memory ✓          | ChatGPT personalization ❌ | Context memory ✓            | Generic vector store ✓                        |

### ✅ **OpenMemory Test Highlights (Nov 2025, LongMemEval)**

| **Test Type**              | **Result Summary**                         |
| -------------------------- | ------------------------------------------ |
| Recall@5                   | 100.0% (avg 6.7ms)                         |
| Throughput (8 workers)     | 338.4 QPS (avg 22ms, P95 203ms)            |
| Decay Stability (5 min)    | Δ +30% → +56% (convergent)                 |
| Cross-sector Recall        | Passed (semantic ↔ emotional, 5/5 matches) |
| Scalability Test           | 7.9 ms/item (stable beyond 10k entries)    |
| Consistency (2863 samples) | Stable (no variance drift)                 |
| Decay Model                | Adaptive exponential decay per sector      |
| Memory Reinforcement       | Coactivation-weighted salience updates     |
| Embedding Mode             | Synthetic + Gemini hybrid                  |
| User Link                  | ✅ `user_id` association confirmed         |

### Summary

OpenMemory delivers **2–3× faster contextual recall**, **6–10× lower cost**, and **full transparency** compared to hosted "memory APIs" like Zep or Supermemory.  
Its **multi-sector cognitive model** allows explainable recall paths, hybrid embeddings (OpenAI / Gemini / Ollama / local), and real-time decay, making it ideal for developers seeking open, private, and interpretable long-term memory for LLMs.

---

## 3. Setup

### One-Click Deploy

Deploy OpenMemory to your favorite cloud platform:

<p align="center">
    <a href="https://vercel.com/new/clone?repository-url=https://github.com/lucivskvn/openmemory-OSS&root-directory=backend&build-command=bun%20install%20%26%26%20bun%20run%20build">
    <img src="https://vercel.com/button" alt="Deploy with Vercel" height="32">
  </a>
  <a href="https://cloud.digitalocean.com/apps/new?repo=https://github.com/lucivskvn/openmemory-OSS/tree/main">
    <img src="https://www.deploytodo.com/do-btn-blue.svg" alt="Deploy to DigitalOcean" height="32">
  </a>
  <a href="https://railway.app/new/template?template=https://github.com/lucivskvn/openmemory-OSS&rootDir=backend">
    <img src="https://railway.app/button.svg" alt="Deploy on Railway" height="32">
  </a>
  <a href="https://render.com/deploy">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32">
  </a>
  <a href="https://heroku.com/deploy?template=https://github.com/lucivskvn/openmemory-OSS">
    <img src="https://www.herokucdn.com/deploy/button.svg" alt="Deploy to Heroku" height="32">
  </a>
</p>

### Quick Start (Local Development)

Requirements:

- Bun v1.3.2 or higher
- SQLite 3.40 or higher (included)
- Optional: OpenAI/Gemini API key or Ollama

> [!NOTE]
> This project now uses Bun as its runtime.

#### Bun-native development notes

- Recommended Bun version: v1.3.2 or newer for local development and CI.
- Prefer `Bun.file()` for large file reads/writes (ingest/extract) for better performance.
- Runtime: Bun v1.3.2 (recommended). The backend now uses Bun.file() for file I/O in ingestion/extraction paths to improve throughput and reduce blocking I/O.
- OIDC / Deployment: See detailed deployment notes for OIDC-enabled deployments at `docs/deployment/oidc-setup.md`.
- Use the centralized helper for API key hashing and verification at `backend/src/utils/crypto.ts`.
- When editing backend TypeScript, add `@types/bun` to devDependencies and include Bun typings in `tsconfig.json` to avoid type errors in CI and editors.

> [!NOTE]
> **New in v1.3.1:** Bun.file() migration for extract/ingest yields ~2–3× faster document processing. CI has been hardened with SHA-pinned actions, Trivy scanning, and SLSA attestations. See [CHANGELOG.md](CHANGELOG.md) for details.

For additional CI hardening and GitHub Actions best practices, see `docs/security/github-actions-hardening.md` which outlines SHA pins, provenance, and SLSA attestation recommendations.

```bash
git clone https://github.com/lucivskvn/openmemory-OSS.git
cd openmemory/backend
cp .env.example .env

# Generate a secure hash for your API key
bun run hash-key "your-secret-api-key"

# Paste the generated hash into your .env file as OM_API_KEY

bun install
bun run dev
```

> Note: For file-based ingestion/extraction, clients should send accurate MIME types (for example, `application/pdf` for PDFs and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for DOCX). The server performs lightweight magic-bytes detection for generic `application/octet-stream` inputs (PDF and ZIP/DOCX detection). If you need backward-compatible permissive behavior for octet-stream payloads, set `OM_ACCEPT_OCTET_LEGACY=true` in your environment (opt-in). Using accurate MIME types avoids misclassification and is the recommended practice.

## Security: Extract DNS checks (SSRF protection)

The backend supports an optional DNS-based safety check used by URL extraction and other networked extraction paths. To enable conservative DNS-based blocking of hosts that resolve to private or loopback ranges, set:

```bash
OM_EXTRACT_DNS_CHECK=true
```

We recommend enabling `OM_EXTRACT_DNS_CHECK=true` in production deployments to reduce SSRF risk. If the runtime does not provide a DNS resolver, the code will fall back to literal hostname/IP checks unless `OM_EXTRACT_DNS_CHECK` is explicitly enabled — in that case DNS resolution failures will be treated as blocked for safety.

The server runs on `http://localhost:8080`.

### Docker Setup

```bash
docker compose up --build -d
```

This starts OpenMemory on port 8080. Data persists in `/data/openmemory.sqlite`.

### Ollama Sidecar (Local Models)

OpenMemory can run an Ollama sidecar for local embeddings and multimodal models. The repository's `docker-compose.yml` includes an `ollama` service you can enable by default.

Management endpoints:

- `POST /embed/ollama/pull` - Pull a model into the sidecar (body: `{ "model": "nomic-embed-text" }`).
- `GET /embed/ollama/list` - List models installed in the sidecar.
- `POST /embed/ollama/delete` - Remove a model from the sidecar (idempotent).
- `GET /embed/ollama/status` - Health & version information for Ollama.
  - Response fields: `ollama_available` (boolean), `ollama_version` (string),
    and `models_loaded` (number). The endpoint guarantees a stable JSON shape
    even when Ollama is unreachable (tests expect this behavior — see
    `tests/backend/ollama-status.unit.test.ts`).

Router CPU requires consistent dimensions across sector models; startup validation detects mismatches before production traffic.

When deploying with Docker/Podman, model files are stored in a named volume `ollama_models`. For rootless Podman, create the volume with `podman volume create ollama_models --driver local --opt o=uid=$(id -u),gid=$(id -g)`.

### Dashboard Setup

The dashboard provides a web interface to visualize and manage your memories.

Requirements:

- Bun v1.3.2 or higher
- Running OpenMemory backend (on port 8080)

```bash
cd dashboard
bun install
bun run dev
```

The dashboard runs on `http://localhost:8080`.

**Configuration (.env.local):**

```bash
# OpenMemory backend URL
NEXT_PUBLIC_API_URL=http://localhost:8080

# Optional: API key if backend has OM_API_KEY configured
NEXT_PUBLIC_API_KEY=your_api_key_here
```

**Features:**

- View memory statistics and distribution across sectors
- Browse and search memories by sector
- Visualize memory decay over time
- View waypoint connections and memory graphs
- Monitor system health and performance
- Manage user memories and summaries

**Production Build:**

```bash
bun run build
bun run start
```

# 💖 Support the Project

If you find OpenMemory useful, please consider supporting:

## Ethereum (ERC-20):

```
0x5a12e3f48b6d761a120bc3cd0977e208c362a74e
```

## Your support helps fund ongoing development and hosting.

## 4. Architecture

OpenMemory uses Hierarchical Memory Decomposition (HMD):

- One node per memory (no duplication)
- Multiple embeddings per memory (one per sector)
- Single-waypoint linking between memories
- Composite similarity scoring

**Stack:**

- Backend: TypeScript
- Backend: TypeScript on Bun v1.3.2 (Bun.serve, Bun.file(), Bun.password)
- Storage: SQLite or PostgreSQL
- Security: GitHub Actions with SHA-pinned actions, OIDC-ready workflows, Trivy + SLSA attestations (see `docs/security/github-actions-hardening.md`)
- Note: The backend supports PostgreSQL when requested. It prefers Bun's native Postgres client when available; if Bun Postgres isn't present in the runtime, the backend will fall back to the Node `pg` package at runtime (the repository already includes `pg` as a fallback dependency in `backend/package.json`). To enable Postgres-backed storage set `OM_METADATA_BACKEND=postgres` and consult `backend/README.md` for operational details and CI configuration.
- Embeddings: E5/BGE/OpenAI/Gemini/Ollama/router_cpu (single-expert-per-sector router over Ollama, not SB-MoE)
- Scheduler: Bun timers (setInterval) for decay and maintenance

**Query flow:**

1. Text → sectorized into 2-3 memory types
2. Generate embeddings per sector
3. Search vectors in those sectors
4. Top-K matches → one-hop waypoint expansion
5. Rank by: 0.6×similarity + 0.2×salience + 0.1×recency + 0.1×link weight

---

## 5. Temporal Knowledge Graph

OpenMemory includes a temporal knowledge graph system that tracks how facts evolve over time. This enables time-aware relationships and historical reasoning.

### Core Concepts

Every stored fact links to time with:

- **valid_from** - When the fact became true
- **valid_to** - When it stopped being true (null if still active)
- **confidence** - System confidence level (0-1)

### Key Features

- **Temporal Querying** - Ask "what was true on a specific date"
- **Auto-update Logic** - New facts automatically close old ones
- **Fact Evolution** - Build complete timelines for any subject
- **Confidence Decay** - Lower weight for older or uncertain data
- **Historical Comparison** - Compare facts between two time points

### Example Usage

```javascript
// Insert a time-bound fact
POST /api/temporal/fact
{
  "subject": "OpenAI",
  "predicate": "has_CEO",
  "object": "Sam Altman",
  "valid_from": "2019-03-01",
  "confidence": 0.98
}

// Query fact at specific time
GET /api/temporal/fact?subject=OpenAI&predicate=has_CEO&at=2023-01-01
// Returns: "Sam Altman"

// Get complete timeline
GET /api/temporal/timeline?subject=OpenAI&predicate=has_CEO
// Returns all historical changes

// Compare two time points
GET /api/temporal/compare?subject=OpenAI&time1=2023-01-01&time2=2024-12-01
// Returns: added, removed, changed, unchanged facts
```

### API Endpoints

| Endpoint                         | Method | Description                            |
| -------------------------------- | ------ | -------------------------------------- |
| `/api/temporal/fact`             | POST   | Insert or update time-bound fact       |
| `/api/temporal/fact`             | GET    | Retrieve facts valid at given time     |
| `/api/temporal/fact/current`     | GET    | Get current fact for subject-predicate |
| `/api/temporal/fact/:id`         | PATCH  | Update fact confidence or metadata     |
| `/api/temporal/fact/:id`         | DELETE | Invalidate fact (set valid_to)         |
| `/api/temporal/timeline`         | GET    | Get complete timeline for entity       |
| `/api/temporal/subject/:subject` | GET    | Get all facts for subject              |
| `/api/temporal/search`           | GET    | Search facts by pattern                |
| `/api/temporal/compare`          | GET    | Compare facts between two times        |
| `/api/temporal/stats`            | GET    | Get temporal graph statistics          |
| `/api/temporal/decay`            | POST   | Apply confidence decay to old facts    |
| `/api/temporal/volatile`         | GET    | Get most frequently changing facts     |

### Performance

- Handles 100k+ facts in SQLite or Postgres
- Query speed under 50ms for single date lookups
- Automatically resolves overlapping facts
- Optional integration with OpenMemory's decay model

---

## 6. Migration Tool

Migrate your existing memories from Zep, Mem0, or Supermemory to OpenMemory with our standalone migration tool.

### Quick Start

```bash
cd migrate
# Run with Bun for a Bun-first runtime (or `node` if you prefer Node)
bun index.js --from mem0 --api-key YOUR_KEY --verify
```

### Supported Providers

- **Zep** - Exports sessions and messages with rate limiting (1 req/s)
- **Mem0** - User-based export with proper Token authentication (20 req/s)
- **Supermemory** - Document export with pagination support (5-25 req/s)

### Features

- ✅ API-based import (no backend dependencies required)
- ✅ Automatic rate limiting for billion-scale exports
- ✅ Preserves user isolation and metadata
- ✅ Built-in verification mode
- ✅ Progress tracking and resume support
- ✅ JSONL export format for portability

### Example Commands

```bash
# List of all args
bun index.js --help

# Basic migration with verification
bun index.js --from mem0 --api-key MEM0_KEY --verify

# Target remote OpenMemory instance
bun index.js --from zep --api-key ZEP_KEY \
    --openmemory-url https://my-instance.com \
    --openmemory-key SECRET

# Custom rate limit for paid tier
bun index.js --from supermemory --api-key SM_KEY --rate-limit 25
```

---

## 7. CLI Tool

OpenMemory includes a command-line tool for quick memory operations.

### Installation

```bash
cd backend
bun link
```

Now you can use `opm` from anywhere.

### Commands

```bash
# Add a memory
opm add "user likes dark mode" --user u123 --tags prefs

# Query memories
opm query "preferences" --user u123 --limit 5

# List memories
opm list --user u123 --limit 10

# Delete a memory
opm delete <memory-id>

# Show statistics
opm stats

# List users
opm users

# Get user summary
opm user u123

# Check server health
opm health
```

### Configuration

The CLI reads from your root `.env` file:

```ini
OM_PORT=8080
OM_API_KEY=your_secret_key
OPENMEMORY_URL=http://localhost:8080  # Optional: override default
OPENMEMORY_API_KEY=your_secret_key    # Optional: alt API key
```

---

## 8. API

**Full API documentation:** https://openmemory.cavira.app

### Quick Start

```bash
# Add a memory
curl -X POST http://localhost:8080/memory/add \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "user_id": "user123"}'

# Query memories
curl -X POST http://localhost:8080/memory/query \
  -H "Content-Type: application/json" \
  -d '{"query": "preferences", "k": 5, "filters": {"user_id": "user123"}}'

# Get user summary
curl http://localhost:8080/users/user123/summary
```

### Key Endpoints

- **Memory operations** - Add, query, update, delete, reinforce
- **User management** - Per-user isolation with automatic summaries
- **LangGraph mode** - Native integration with LangGraph nodes
- **MCP support** - Built-in Model Context Protocol server
- **Health checks** - `/health` and `/stats` endpoints

### LangGraph Integration

Enable with environment variables:

```ini
OM_MODE=langgraph
OM_LG_NAMESPACE=default
```

Provides `/lgm/*` endpoints for graph-based memory operations.

### MCP Server

OpenMemory includes a Model Context Protocol server at `POST /mcp`.

**⚠️ Breaking Change in v2.1.0**: MCP tool names now use underscores instead of dots for compatibility with Windsurf IDE and strict MCP clients:

- `openmemory.query` → `openmemory_query`
- `openmemory.store` → `openmemory_store`
- `openmemory.reinforce` → `openmemory_reinforce`
- `openmemory.list` → `openmemory_list`
- `openmemory.get` → `openmemory_get`

See [MCP_MIGRATION.md](./MCP_MIGRATION.md) for migration guide.

For stdio mode (Claude Desktop):

```bash
bun backend/dist/ai/mcp.js
```

#### Claude Code Integration

Claude Code supports HTTP MCP servers natively. Since OpenMemory provides an HTTP endpoint at `/mcp`, you can connect directly without additional configuration.

**Method 1: Using CLI (Recommended)**

```bash
# Add globally (available in all projects)
claude mcp add --transport http --scope user openmemory http://localhost:8080/mcp

# Or add to current project only
claude mcp add --transport http openmemory http://localhost:8080/mcp
```

**Method 2: Manual Configuration**

Add to `~/.claude.json` (global) or `.mcp.json` (project-specific):

```json
{
  "mcpServers": {
    "openmemory": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}

or

{
  "mcpServers": {
    "openmemory": {
      "headers": {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "x-api-key": "{OM_API_KEY}"
      },
      "type": "http",
      "url": "http://120.0.0.1:8080/mcp"
    }
  }
}

```

Then restart Claude Code.

**Available Tools:**

- `mcp__openmemory__query` - Semantic search across memories
- `mcp__openmemory__store` - Store new memories
- `mcp__openmemory__list` - List recent memories
- `mcp__openmemory__get` - Retrieve specific memory by ID
- `mcp__openmemory__reinforce` - Boost memory salience

**Note**: Make sure your OpenMemory Docker container is running on `http://localhost:8080` before connecting.

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/lucivskvn-openmemory-OSS-badge.png)](https://mseep.ai/app/lucivskvn-openmemory-OSS)

---

## 9. Performance

OpenMemory costs 6-12× less than cloud alternatives and delivers 2-3× faster queries.

### 8.1 Speed

Based on tests with 100,000 memories:

| Operation          | OpenMemory | Zep    | Supermemory | Mem0   | Vector DB |
| ------------------ | ---------- | ------ | ----------- | ------ | --------- |
| Single query       | 115 ms     | 250 ms | 170-250 ms  | 250 ms | 160 ms    |
| Add memory         | 30 ms      | 95 ms  | 125 ms      | 60 ms  | 40 ms     |
| User summary       | 95 ms      | N/A    | N/A         | N/A    | N/A       |
| Pattern clustering | 60 ms      | N/A    | N/A         | N/A    | N/A       |
| Reflection cycle   | 400 ms     | N/A    | N/A         | N/A    | N/A       |

### 9.2 Throughput

Queries per second with concurrent users:

| Users | QPS | Average Latency | 95th Percentile |
| ----- | --- | --------------- | --------------- |
| 1     | 25  | 40 ms           | 80 ms           |
| 10    | 180 | 55 ms           | 120 ms          |
| 50    | 650 | 75 ms           | 180 ms          |
| 100   | 900 | 110 ms          | 280 ms          |

**Router CPU Mode (CPU-Only)**:

- QPS: 50-100 with 2-3 models loaded
- Latency: 150-300ms (Ollama inference + routing)
- Memory: 2-4GB RAM base usage
- Benefits: 10-15% overhead vs single model, 20-30% SIMD gains when enabled
- Note: transformers.js 3.x and IBM/Liquid MoE integration are deferred to a later phase, and that current CPU optimization is via `router_cpu` plus SIMD fusion.

### 9.3 Self-Hosted Cost

Monthly costs for 100,000 memories:

**OpenMemory**

- VPS (4 vCPU, 8GB): $8-12
- Storage (SQLite): $0
- Embeddings (local): $0
- **Total: $8-12/month**

With OpenAI embeddings: add $10-15/month

**Competitors (Cloud)**

- Zep: $80-150/month
- Supermemory: $60-120/month
- Mem0: $25-40/month

OpenMemory costs 6-12× less than cloud alternatives.

### 9.4 Cost at Scale

Per 1 million memories:

| System              | Storage  | Embeddings | Hosting | Total/Month |
| ------------------- | -------- | ---------- | ------- | ----------- |
| OpenMemory (local)  | $2       | $0         | $15     | **$17**     |
| OpenMemory (OpenAI) | $2       | $13        | $15     | **$30**     |
| Zep Cloud           | Included | Included   | $100    | **$100**    |
| Supermemory         | Included | Included   | $80     | **$80**     |
| Mem0                | Included | $12        | $20     | **$32**     |

### 9.5 Accuracy

Tested with LongMemEval benchmark:

| Metric           | OpenMemory | Zep  | Supermemory | Mem0 | Vector DB |
| ---------------- | ---------- | ---- | ----------- | ---- | --------- |
| Recall@10        | 92%        | 65%  | 78%         | 70%  | 68%       |
| Precision@10     | 88%        | 62%  | 75%         | 68%  | 65%       |
| Overall accuracy | 95%        | 72%  | 82%         | 74%  | 68%       |
| Response time    | 2.1s       | 3.2s | 3.1s        | 2.7s | 2.4s      |

### 9.6 Storage

| Scale | SQLite | PostgreSQL | RAM    | Query Time |
| ----- | ------ | ---------- | ------ | ---------- |
| 10k   | 150 MB | 180 MB     | 300 MB | 50 ms      |
| 100k  | 1.5 GB | 1.8 GB     | 750 MB | 115 ms     |
| 1M    | 15 GB  | 18 GB      | 1.5 GB | 200 ms     |
| 10M   | 150 GB | 180 GB     | 6 GB   | 350 ms     |

---

## 10. Security

- API key authentication for write operations
- Optional AES-GCM encryption for content
- PII scrubbing hooks
- Per-user memory isolation
- Complete data deletion via API
- No vendor access to data
- Full local control

---

## 11. Roadmap

| Version | Focus                     | Status      |
| ------- | ------------------------- | ----------- |
| v1.0    | Core memory backend       | ✅ Complete |
| v1.1    | Pluggable vector backends | ✅ Complete |
| v1.2    | Dashboard and metrics     | ✅ Complete |
| v1.3    | Learned sector classifier | ✅ Complete |
| v1.3.1  | Bun hardening & security  | ✅ Complete |
| v1.4    | Federated multi-node      | 🔜 Planned  |

---

## 12. Contributing

See `CONTRIBUTING.md`, `GOVERNANCE.md`, and `CODE_OF_CONDUCT.md` for guidelines.

Also see `AGENTS.md` for guidance for automated agents and contributors using the repo-level agent tooling, and refer to `CONTRIBUTING.md` for contributor workflows and PR expectations.

```bash
make build
make test
```

### Our Contributers:

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/nullure">
                    <img src="https://avatars.githubusercontent.com/u/81895400?v=4" width="100;" alt="nullure"/>
                    <br />
                    <sub><b>Morven</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/DKB0512">
                    <img src="https://avatars.githubusercontent.com/u/23116307?v=4" width="100;" alt="DKB0512"/>
                    <br />
                    <sub><b>Devarsh (DKB) Bhatt</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/recabasic">
                    <img src="https://avatars.githubusercontent.com/u/102372274?v=4" width="100;" alt="recabasic"/>
                    <br />
                    <sub><b>Elvoro</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/msris108">
                    <img src="https://avatars.githubusercontent.com/u/43115330?v=4" width="100;" alt="msris108"/>
                    <br />
                    <sub><b>Sriram M</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/DoKoB0512">
                    <img src="https://avatars.githubusercontent.com/u/123281216?v=4" width="100;" alt="DoKoB0512"/>
                    <br />
                    <sub><b>DoKoB0512</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/amihos">
                    <img src="https://avatars.githubusercontent.com/u/35190548?v=4" width="100;" alt="amihos"/>
                    <br />
                    <sub><b>Hossein Amirkhalili</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/jasonkneen">
                    <img src="https://avatars.githubusercontent.com/u/502002?v=4" width="100;" alt="jasonkneen"/>
                    <br />
                    <sub><b>Jason Kneen</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/muhammad-fiaz">
                    <img src="https://avatars.githubusercontent.com/u/75434191?v=4" width="100;" alt="muhammad-fiaz"/>
                    <br />
                    <sub><b>Muhammad Fiaz</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/pc-quiknode">
                    <img src="https://avatars.githubusercontent.com/u/126496711?v=4" width="100;" alt="pc-quiknode"/>
                    <br />
                    <sub><b>Peter Chung</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/ammesonb">
                    <img src="https://avatars.githubusercontent.com/u/2522710?v=4" width="100;" alt="ammesonb"/>
                    <br />
                    <sub><b>Brett Ammeson</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Dhravya">
                    <img src="https://avatars.githubusercontent.com/u/63950637?v=4" width="100;" alt="Dhravya"/>
                    <br />
                    <sub><b>Dhravya Shah</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/josephgoksu">
                    <img src="https://avatars.githubusercontent.com/u/6523823?v=4" width="100;" alt="josephgoksu"/>
                    <br />
                    <sub><b>Joseph Goksu</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/lwsinclair">
                    <img src="https://avatars.githubusercontent.com/u/2829939?v=4" width="100;" alt="lwsinclair"/>
                    <br />
                    <sub><b>Lawrence Sinclair</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Hchunjun">
                    <img src="https://avatars.githubusercontent.com/u/11238835?v=4" width="100;" alt="Hchunjun"/>
                    <br />
                    <sub><b>鱼</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

---

## 13. License

Apache 2.0 License. Copyright (c) 2025 OpenMemory.

---

## 14. Community

Join our [Discord](https://discord.gg/P7HaRayqTh) to connect with other developers and contributors.

---

## 15. Other Projects

**PageLM** - Transform study materials into quizzes, flashcards, notes, and podcasts.  
https://github.com/lucivskvn/PageLM

---
