import asyncio
import json
import logging
import sys
from typing import Any, Optional, Dict, List, cast

logger = logging.getLogger(__name__)

# Try imports
try:
    from mcp.server import Server, NotificationOptions  # type: ignore[import]
    from mcp.server.stdio import stdio_server  # type: ignore[import]
    from mcp.types import Tool, TextContent, ImageContent, EmbeddedResource  # type: ignore[import]

    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False
    Server = None  # type: ignore[assignment]
    NotificationOptions = None  # type: ignore[assignment]
    stdio_server = None  # type: ignore[assignment]

    class Tool:  # type: ignore[no-redef]
        name: str = ""
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class TextContent:  # type: ignore[no-redef]
        text: str = ""
        def __init__(self, **kwargs): 
            self.__dict__.update(kwargs)

    class ImageContent: pass
    class EmbeddedResource: pass

from ..main import Memory
from ..core.config import env
from datetime import datetime
from ..temporal_graph.store import insert_fact, insert_edge
from ..temporal_graph.query import query_facts_at_time, query_edges, search_facts
from ..temporal_graph.timeline import get_subject_timeline

from .graph import store_node_mem, get_graph_ctx, LgmStoreReq, LgmContextReq
from .ide import get_ide_context, get_ide_patterns

# Initialize memory instance removed to prevent side-effects


from ..memory.reflect import start_reflection
from ..memory.user_summary import start_user_summary_reflection
from ..memory.decay import start_decay
from ..ops.maintenance import start_maintenance

async def handle_list_tools() -> list[Tool]:
    tools = [
        Tool(
            name="openmemory_query",
            description="Run a semantic retrieval against OpenMemory",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Free-form search text"},
                    "k": {"type": "integer", "default": 10, "description": "Max results"},
                    "user_id": {"type": "string", "description": "User context"},
                    "sector": {"type": "string", "description": "Restrict to sector (lexical, semantic, etc)"},
                    "min_salience": {"type": "number", "description": "Minimum salience threshold"}
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="openmemory_store",
            description="Persist new content into OpenMemory",
            inputSchema={
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Memory content"},
                    "user_id": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "metadata": {"type": "object"}
                },
                "required": ["content"]
            }
        ),
         Tool(
            name="openmemory_get",
            description="Fetch a single memory by ID",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "include_vectors": {"type": "boolean", "default": False, "description": "Include vector data"},
                    "user_id": {"type": "string", "description": "Verify user ownership"}
                },
                "required": ["id"]
            }
        ),
         Tool(
            name="openmemory_list",
            description="List recent memories",
            inputSchema={
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 20},
                    "sector": {"type": "string", "description": "Filter by sector"},
                    "user_id": {"type": "string"}
                }
            }
        ),
        Tool(
            name="openmemory_reinforce",
            description="Boost salience for an existing memory",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Memory identifier to reinforce"},
                    "boost": {"type": "number", "default": 0.1, "minimum": 0.01, "maximum": 1.0, "description": "Salience boost amount"},
                    "user_id": {"type": "string", "description": "Verify user ownership"}
                },
                "required": ["id"]
            }
        )
    ]
    
    # Ingestion Tools
    tools.append(
        Tool(
            name="openmemory_ingest_url",
            description="Ingest content from a URL",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to ingest"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "user_id": {"type": "string"}
                },
                "required": ["url"]
            }
        )
    )
    
    # Temporal Tools
    tools.extend([
        Tool(
            name="openmemory_temporal_fact_create",
            description="Create a temporal fact in the knowledge graph",
            inputSchema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "Subject entity"},
                    "predicate": {"type": "string", "description": "Relationship type"},
                    "object": {"type": "string", "description": "Object entity"},
                    "valid_from": {"type": "string", "description": "ISO date for when fact became true"},
                    "confidence": {"type": "number", "default": 1.0},
                    "user_id": {"type": "string"},
                    "metadata": {"type": "object"}
                },
                "required": ["subject", "predicate", "object"]
            }
        ),
        Tool(
            name="openmemory_temporal_fact_query",
            description="Query facts active at a specific time",
            inputSchema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {"type": "string"},
                    "object": {"type": "string"},
                    "at": {"type": "string", "description": "ISO date to query state at"},
                    "user_id": {"type": "string"}
                }
            }
        ),
        Tool(
            name="openmemory_temporal_timeline",
            description="Get the timeline of changes for a subject",
            inputSchema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "user_id": {"type": "string"}
                },
                "required": ["subject"]
            }
        ),
        Tool(
            name="openmemory_temporal_edge_create",
            description="Create an edge between two temporal facts",
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "relation_type": {"type": "string"},
                    "weight": {"type": "number", "default": 1.0},
                    "user_id": {"type": "string"}
                },
                "required": ["source_id", "target_id", "relation_type"]
            }
        ),
        Tool(
            name="openmemory_temporal_edge_query",
            description="Query edges between facts",
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "relation_type": {"type": "string"},
                    "user_id": {"type": "string"}
                }
            }
        ),
        Tool(
            name="openmemory_temporal_fact_search",
            description="Search for facts by keyword",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "default": 10},
                    "user_id": {"type": "string"}
                },
                "required": ["query"]
            }
        )
    ])
    
    # Graph & IDE Tools
    tools.extend([
        Tool(
            name="openmemory_store_node_mem",
            description="Store memory for a specific LangGraph node",
            inputSchema={
                "type": "object",
                "properties": {
                    "node": {"type": "string", "description": "Node name (plan, reflect, etc)"},
                    "content": {"type": "string"},
                    "namespace": {"type": "string"},
                    "graph_id": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "reflective": {"type": "boolean"},
                    "user_id": {"type": "string"}
                },
                "required": ["node", "content", "namespace"]
            }
        ),
        Tool(
            name="openmemory_get_graph_context",
            description="Retrieve context for a LangGraph thread",
            inputSchema={
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "default": "default"},
                    "graph_id": {"type": "string"},
                    "limit": {"type": "integer"},
                    "user_id": {"type": "string"}
                },
                "required": ["namespace"]
            }
        ),
        Tool(
            name="openmemory_ide_context",
            description="Retrieve context relevant to IDE state",
            inputSchema={
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "line": {"type": "integer"},
                    "content": {"type": "string"},
                    "user_id": {"type": "string"}
                },
                "required": ["file", "line", "content"]
            }
        ),
        Tool(
            name="openmemory_ide_patterns",
            description="Retrieve active patterns for IDE files",
            inputSchema={
                "type": "object",
                "properties": {
                    "active_files": {"type": "array", "items": {"type": "string"}},
                    "user_id": {"type": "string"}
                },
                "required": ["active_files"]
            }
        )
    ])
    
    return tools

async def handle_call_tool(name: str, arguments: dict | None, mem_inst: Memory) -> list[TextContent | ImageContent | EmbeddedResource]:
    args = arguments or {}

    try:
        if name == "openmemory_query":
            q = args.get("query")
            if not isinstance(q, str) or not q:
                return [TextContent(type="text", text="Missing query text")]  # type: ignore[arg-type]
            limit = args.get("k", 10)
            uid = args.get("user_id")
            sector = args.get("sector")
            min_salience = args.get("min_salience")

            filters = {}
            if sector: filters["sector"] = sector
            if min_salience is not None: filters["minSalience"] = min_salience

            results = await mem_inst.search(q, user_id=uid, limit=limit, **filters)

            summary = f"Found {len(results)} matches for '{q}'"
            json_res = json.dumps(results, default=str, indent=2)

            return [
                TextContent(type="text", text=summary),
                TextContent(type="text", text=json_res)
            ]

        elif name == "openmemory_store":
            content = args.get("content")
            if not isinstance(content, str) or not content:
                return [TextContent(type="text", text="Missing content to store")]  # type: ignore[arg-type]
            uid = args.get("user_id")
            tags = args.get("tags", [])
            meta = args.get("metadata", {})

            # Pass tags separately as expected by mem.add
            res = await mem_inst.add(content, user_id=uid, metadata=meta, tags=tags)
            return [
                TextContent(type="text", text=f"Stored memory {res.get('root_memory_id') or res.get('id')}"),
                TextContent(type="text", text=json.dumps(res, default=str, indent=2))
            ]

        elif name == "openmemory_get":
            mid = args.get("id")
            if not isinstance(mid, str) or not mid:
                return [TextContent(type="text", text="Missing memory id")]
            uid = args.get("user_id")
            # Now using the strengthened SDK get() which checks ownership
            m = await mem_inst.get(mid, user_id=uid)
            if not m:
                return [TextContent(type="text", text=f"Memory {mid} not found or access denied")]

            target = dict(m)
            if not args.get("include_vectors"):
                # Remove vector fields if not requested to reduce noise
                keys = list(target.keys())
                for k in keys:
                    if "embedding" in k or "vector" in k:
                        target.pop(k, None)

            return [TextContent(type="text", text=json.dumps(target, default=str, indent=2))]

        elif name == "openmemory_list":
            limit = args.get("limit", 20)
            uid = args.get("user_id")
            sector = args.get("sector")

            # We need to support sector filter in memory.history or do manual filtering
            # history() calls all_mem_by_user.
            # If sector is provided, we might need to filter manually or add support in SDK.
            # For now, manual filter.
            res = await mem_inst.history(user_id=uid, limit=limit * 2 if sector else limit)
            if sector:
                res = [r for r in res if r.get("primary_sector") == sector]
                res = res[:limit]

            return [TextContent(type="text", text=json.dumps([dict(r) for r in res], default=str, indent=2))]

        elif name == "openmemory_reinforce":
            from ..memory.hsg import reinforce_memory
            mid = args.get("id")
            if not isinstance(mid, str) or not mid:
                return [TextContent(type="text", text="Missing memory id to reinforce")]
            boost = args.get("boost", 0.1)
            uid = args.get("user_id")

            if uid:
                # Direct DB check since reinforce_memory doesn't check owner yet (it's low level)
                # But we can verify existence first
                existing = await mem_inst.get(mid, user_id=uid)
                if not existing:
                    return [TextContent(type="text", text=f"Memory {mid} not found or access denied")]

            await reinforce_memory(mid, boost)
            return [TextContent(type="text", text=f"Reinforced memory {mid} by {boost}")]

        elif name == "openmemory_ingest_url":
            from ..ops.ingest import ingest_url
            url = args.get("url")
            if not isinstance(url, str) or not url:
                return [TextContent(type="text", text="Missing url")]
            tags = args.get("tags", [])
            uid = args.get("user_id")

            res = await ingest_url(url, tags=tags, user_id=uid)
            return [
                TextContent(type="text", text=f"Ingested URL: {url}"),
                TextContent(type="text", text=json.dumps(res, default=str, indent=2))
            ]

        # -- Temporal Tools --

        elif name == "openmemory_temporal_fact_create":
            subject = args.get("subject")
            predicate = args.get("predicate")
            obj = args.get("object")
            if not all(isinstance(x, str) and x for x in [subject, predicate, obj]):
                return [
                    TextContent(
                        type="text", text="subject, predicate, and object are required"
                    )
                ]
            subject = cast(str, subject)
            predicate = cast(str, predicate)
            obj = cast(str, obj)
            valid_from = args.get("valid_from")
            confidence = args.get("confidence", 1.0)
            uid = args.get("user_id")
            meta = args.get("metadata")

            ts = None
            if valid_from:
                try:
                    ts = int(datetime.fromisoformat(valid_from.replace('Z', '+00:00')).timestamp() * 1000)
                except Exception:
                    pass

            fid = await insert_fact(subject, predicate, obj, valid_from=ts, confidence=confidence, metadata=meta, user_id=uid)
            return [TextContent(type="text", text=f"Created temporal fact {fid}: {subject} {predicate} {obj}")]

        elif name == "openmemory_temporal_fact_query":
            subject = args.get("subject")
            predicate = args.get("predicate")
            obj = args.get("object")
            at = args.get("at")
            uid = args.get("user_id")

            ts = None
            if at:
                try:
                    ts = int(datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp() * 1000)
                except Exception:
                    pass

            facts = await query_facts_at_time(subject, predicate, obj, at=ts, user_id=uid)
            return [
                TextContent(type="text", text=f"Found {len(facts)} facts"),
                TextContent(type="text", text=json.dumps(facts, default=str, indent=2))
            ]

        elif name == "openmemory_temporal_timeline":
            subject = args.get("subject")
            uid = args.get("user_id")

            subject = cast(str, subject)
            timeline = await get_subject_timeline(subject, user_id=uid)
            return [
                TextContent(type="text", text=f"Timeline for {subject}"),
                TextContent(type="text", text=json.dumps(timeline, default=str, indent=2))
            ]

        elif name == "openmemory_temporal_edge_create":
            src = args.get("source_id")
            dst = args.get("target_id")
            rel = args.get("relation_type")
            if not all(isinstance(x, str) and x for x in [src, dst, rel]):
                return [
                    TextContent(
                        type="text",
                        text="source_id, target_id, and relation_type are required",
                    )
                ]
            src = cast(str, src)
            dst = cast(str, dst)
            rel = cast(str, rel)
            wt = args.get("weight", 1.0)
            uid = args.get("user_id")

            eid = await insert_edge(src, dst, rel, weight=wt, user_id=uid)
            return [TextContent(type="text", text=f"Created temporal edge {eid}")]

        elif name == "openmemory_temporal_edge_query":
            src = args.get("source_id")
            dst = args.get("target_id")
            rel = args.get("relation_type")
            uid = args.get("user_id")

            edges = await query_edges(source_id=src, target_id=dst, relation_type=rel, user_id=uid)
            return [
                TextContent(type="text", text=f"Found {len(edges)} edges"),
                TextContent(type="text", text=json.dumps(edges, default=str, indent=2))
            ]

        elif name == "openmemory_temporal_fact_search":
            q_str = args.get("query")
            if not isinstance(q_str, str) or not q_str:
                return [TextContent(type="text", text="Missing query string")]
            limit = args.get("limit", 10)
            uid = args.get("user_id")

            facts = await search_facts(q_str, limit=limit, user_id=uid)
            return [
                TextContent(type="text", text=f"Found {len(facts)} facts matching '{q_str}'"),
                TextContent(type="text", text=json.dumps(facts, default=str, indent=2))
            ]

        elif name == "openmemory_store_node_mem":
            req = LgmStoreReq(
                node=cast(str, args.get("node")),
                content=cast(str, args.get("content")),
                namespace=cast(str, args.get("namespace")),
                graph_id=args.get("graph_id"),
                tags=args.get("tags"),
                reflective=args.get("reflective"),
                user_id=args.get("user_id")
            )
            res = await store_node_mem(req)
            return [
                TextContent(type="text", text=f"Stored memory for node '{req.node}' in namespace '{req.namespace}'"),
                TextContent(type="text", text=json.dumps(res.dict(), default=str, indent=2))
            ]

        elif name == "openmemory_get_graph_context":
            req = LgmContextReq(
                namespace=cast(str, args.get("namespace") or "default"),
                graph_id=args.get("graph_id"),
                limit=args.get("limit"),
                user_id=args.get("user_id")
            )
            ctx = await get_graph_ctx(req)
            return [
                TextContent(type="text", text=ctx.context or "No context found."),
                TextContent(type="text", text=json.dumps([n.dict() for n in ctx.nodes], default=str, indent=2))
            ]

        elif name == "openmemory_ide_context":
            file_p = cast(str, args.get("file"))
            line = cast(int, args.get("line")) # Unused in simple implementation?
            content = cast(str, args.get("content"))
            uid = args.get("user_id")
            
            # Using content as query if not specific logic
            # Simulating query logic from router: "search relevant"
            
            ctx = await get_ide_context(
                query=content[:100], # heuristic query
                limit=5,
                file_path=file_p,
                user_id=uid,
                client=mem_inst
            )
            return [
                 TextContent(type="text", text=f"IDE Context for {file_p}:{line}"),
                 TextContent(type="text", text=json.dumps(ctx, default=str, indent=2))
            ]

        elif name == "openmemory_ide_patterns":
            active_files = args.get("active_files", [])
            uid = args.get("user_id")
            
            # Simulate session ID from first file or generic?
            # ide.py expects session_id. 
            # We don't have a session ID in this tool call args (unlike router).
            # JS implementation logic: getIdePatterns(activeFiles) -> searches generic patterns + filters by inferred session?
            # JS: patterns = await getIdePatterns({ activeFiles, userId })
            # Python ide.py signature: get_ide_patterns(session_id, ...)
            # We need to adjust Python ide.py or pass a dummy/inferred session logic.
            # Let's verify JS logic again. 
            # JS: getIdePatterns logic uses activeFiles to search relevant patterns.
            # Python ide.py I wrote relied on session_id for filtering.
            # I should update Python ide.py to be more like JS (flexible) or just pass "default" for now.
            
            # Pass active_files to get_ide_patterns to finding relevant context
            pats = await get_ide_patterns(
                session_id=None, 
                active_files=active_files,
                user_id=uid, 
                client=mem_inst
            )
            return [
                TextContent(type="text", text=f"IDE Patterns for {len(active_files)} files:"),
                TextContent(type="text", text=json.dumps(pats, default=str, indent=2))
            ]

        else:
            raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        logger.exception("MCP tool call failed: %s", name)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

async def run_mcp_server():
    if not Server:
        print("Error: 'mcp' package not found. Install it via 'pip install mcp'", file=sys.stderr)
        sys.exit(1)

    # Start background cognitive loops once at startup
    start_reflection()
    start_user_summary_reflection()
    start_decay()
    start_maintenance()

    server = Server("openmemory-mcp")
    
    # Initialize Memory locally
    mem = Memory()

    @server.list_tools()  # type: ignore[arg-type]
    async def list_tools_wrapper():
        return await handle_list_tools()

    @server.call_tool()  # type: ignore[arg-type]
    async def call_tool_wrapper(name: str, arguments: dict | None):
        return await handle_call_tool(name, arguments, mem)

    @server.list_resources()  # type: ignore[arg-type]
    async def handle_list_resources():
        """List available resources."""
        return [
            {
                "uri": "openmemory://config",
                "name": "openmemory-config",
                "mimeType": "application/json",
                "description": "Runtime configuration snapshot for the OpenMemory MCP server"
            }
        ]

    @server.read_resource()  # type: ignore[arg-type]
    async def handle_read_resource(uri: str):
        """Read a specific resource."""
        if uri == "openmemory://config":
            # Basic stats (limited to default user session for security)
            from ..core.db import db
            try:
                t = q.tables
                # We can't easily get 'user_id' from MCP context here without more plumbing,
                # but we can at least avoid leaking the WHOLE DB.
                # For now, let's just return empty or generic info if not scoped.
                # In most MCP setups, the 'mem' instance is user-specific.
                stats = await db.async_fetchall(f"SELECT primary_sector as sector, count(*) as count FROM {t['memories']} WHERE user_id IS NULL OR user_id='anonymous' GROUP BY primary_sector")
            except Exception:
                stats = []

            pay = {
                "mode": env.mode,
                "stats": stats,
                "server": {"version": "2.3.0", "engine": "python"},
                "available_tools": [t.name for t in await handle_list_tools()],  # type: ignore[union-attr]
            }
            return json.dumps(pay, indent=2)
        raise ValueError(f"Resource not found: {uri}")

    if not MCP_AVAILABLE:
        raise RuntimeError(
            "MCP dependencies not installed. Install with: pip install mcp"
        )

    async with stdio_server() as (read, write):  # type: ignore[union-attr]
        await server.run(read, write, NotificationOptions(), raise_exceptions=False)  # type: ignore[union-attr,arg-type]
