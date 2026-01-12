# OpenMemory VS Code Extension

The OpenMemory VS Code Extension bridges your IDE with your personal memory backend, enabling seamless context retrieval, automatic activity tracking, and intelligent coding assistance.

## Features

### 1. Automatic Context Tracking
The extension silently observes your coding activity to build a semantic understanding of your work.
- **File Events**: Tracks `open`, `save`, `close`, and `edit` events.
- **Vector Embeddings**: Content is chunked and embedded (via the backend) into `procedural` or `semantic` sectors.
- **Session Management**: Each coding session is tracked with a unique ID, allowing you to recall what you worked on yesterday or last week.

### 2. Intelligent Context Retrieval
- **Query Context**: Right-click or use the command palette to search for relevant memories based on your current file content or selection.
- **Micro-Cache**: Frequently accessed context is cached locally for millisecond-latency retrieval.
- **MCP Integration**: If enabled, the extension can use the Model Context Protocol to talk directly to local LLMs (Claude, Cursor, etc.).

### 3. Dashboard Integration
- **Webview Dashboard**: A built-in dashboard (Cmd+Shift+P > `OpenMemory: Dashboard`) allows you to:
    - Visualize the **Temporal Knowledge Graph**.
    - Watch the **Activity Feed** in real-time.
    - Manually reinforce critical memories.
    - View system statistics (Throughput, Uptime, Memory Count).

## Configuration

| Setting | Default | Description |
| :--- | :--- | :--- |
| `openmemory.enabled` | `true` | Master switch for the extension. |
| `openmemory.backendUrl` | `http://localhost:8080` | URL of your OpenMemory server (Python or Node). |
| `openmemory.apiKey` | `""` | API Key for authentication (matches backend `.env`). |
| `openmemory.useMCP` | `false` | Enable MCP protocol support (experimental). |

## Commands

- `OpenMemory: Query Context`: Search memories relevant to current selection.
- `OpenMemory: Add Selection to Memory`: Explicitly save the selected code snippet.
- `OpenMemory: Quick Note`: Jot down a thought or idea directly into the memory stream.
- `OpenMemory: Dashboard`: Open the visual dashboard.
- `OpenMemory: Toggle Tracking`: Pause/Resume automatic event logging.
- `OpenMemory: View Patterns`: Analyze coding patterns detected in the current session.

## Architecture

The extension communicates with the OpenMemory Backend via a standardized REST API (parity supported in both Python and JS backends).

```mermaid
graph LR
    VSCode[VS Code Extension] -->|Events/Context| IDE[IDE Router (/api/ide)]
    IDE -->|HSG| Memory[Memory Store]
    IDE -->|Graph| Temporal[Temporal Graph]
    VSCode -->|Webview| Dashboard[Dashboard UI]
    Dashboard -->|Stats| Server[Server Core]
```

### Security

- **Nonces**: Webviews use cryptographic nonces (`crypto.randomBytes`) for strict Content Security Policy (CSP).
- **Encryption**: All memories are encrypted at rest by the backend (AES-256-GCM).
- **Isolation**: Queries are scoped to the authenticated `user_id`.
