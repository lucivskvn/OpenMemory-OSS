
import asyncio
import json
import traceback
import sys
from typing import Any, Optional, Dict, List
try:
    from mcp.server import Server, NotificationOptions
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, TextContent, ImageContent, EmbeddedResource
except ImportError:
    Server = None

from ..main import Memory
from ..core.config import env
from ..temporal_graph.store import insert_fact
from ..temporal_graph.query import query_facts_at_time

import os

mem = Memory()

def _resolve_mcp_tenant(mem_inst: Memory, args: dict) -> tuple[str | None, str | None]:
    bound = getattr(mem_inst, "default_user", None) or os.getenv("OM_TENANT") or os.getenv("OM_USER_ID")
    if not bound or not isinstance(bound, str) or not bound.strip():
        return None, "Error: Unauthenticated MCP session. Tenant identity required."

    bound_tenant = bound.strip()
    uid_arg = args.get("user_id")
    if uid_arg and isinstance(uid_arg, str) and uid_arg.strip():
        trimmed_arg = uid_arg.strip()
        if trimmed_arg != bound_tenant:
            return None, f"Error: tenant_mismatch - requested user_id '{trimmed_arg}' does not match authenticated session tenant '{bound_tenant}'"

    return bound_tenant, None

async def _get_verified_memory(mem_inst: Memory, args: dict) -> tuple[dict | None, str | None, str | None]:
    mid = args.get("id")
    if not mid or not isinstance(mid, str) or not mid.strip():
        return None, None, "Error: id is required"

    tenant, err = _resolve_mcp_tenant(mem_inst, args)
    if err:
        return None, None, err

    m = await mem_inst.get(mid)
    if not m:
        return None, tenant, f"Memory {mid} not found"

    m_dict = dict(m)
    if m_dict.get("user_id") != tenant:
        return None, tenant, f"Memory {mid} not found for user {tenant}"

    return m_dict, tenant, None

async def run_mcp_server():
    if not Server:
        print("Error: 'mcp' package not found. Install it via 'pip install mcp'", file=sys.stderr)
        sys.exit(1)

    server = Server("openmemory-mcp")

    @server.list_tools()
    async def handle_list_tools() -> list[Tool]:
        return [
            Tool(
                name="openmemory_query",
                description="Query OpenMemory for contextual memories (HSG) and/or temporal facts",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Free-form search text"},
                        "type": {"type": "string", "enum": ["contextual", "factual", "unified"], "default": "contextual", "description": "Query type: 'contextual' for HSG semantic search (default), 'factual' for temporal fact queries, 'unified' for both"},
                        "fact_pattern": {
                            "type": "object",
                            "properties": {
                                "subject": {"type": "string", "description": "Subject pattern (entity)"},
                                "predicate": {"type": "string", "description": "Predicate pattern (relationship)"},
                                "object": {"type": "string", "description": "Object pattern (value)"}
                            },
                            "description": "Fact pattern for temporal queries. Used when type is 'factual' or 'unified'"
                        },
                        "at": {"type": "string", "description": "ISO date string for point-in-time queries (default: now)"},
                        "k": {"type": "integer", "default": 10, "description": "Max results for HSG queries"},
                        "user_id": {"type": "string", "description": "Isolate results to specific user"},
                        "sector": {"type": "string", "description": "Restrict to sector (lexical, semantic, etc)"}
                    },
                    "required": ["query"]
                }
            ),
            Tool(
                name="openmemory_store",
                description="Persist new content into OpenMemory (HSG contextual memory and/or temporal facts)",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "Raw memory text to store"},
                        "type": {"type": "string", "enum": ["contextual", "factual", "both"], "default": "contextual", "description": "Storage type: 'contextual' for HSG only (default), 'factual' for temporal facts only, 'both' for both systems"},
                        "facts": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "subject": {"type": "string", "description": "Fact subject (entity)"},
                                    "predicate": {"type": "string", "description": "Fact predicate (relationship)"},
                                    "object": {"type": "string", "description": "Fact object (value)"},
                                    "confidence": {"type": "number", "minimum": 0, "maximum": 1, "description": "Confidence score (0-1, default 1.0)"},
                                    "valid_from": {"type": "string", "description": "ISO date string for fact validity start (default: now)"}
                                },
                                "required": ["subject", "predicate", "object"]
                            },
                            "description": "Array of facts to store. Required when type is 'factual' or 'both'"
                        },
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
                        "user_id": {"type": "string"}
                    },
                    "required": ["id", "user_id"]
                }
            ),
             Tool(
                name="openmemory_delete",
                description="Delete a memory by ID",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "user_id": {"type": "string"}
                    },
                    "required": ["id", "user_id"]
                }
            ),
             Tool(
                name="openmemory_list",
                description="List recent memories",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "default": 20},
                        "user_id": {"type": "string"}
                    }
                }
            )
        ]

    @server.call_tool()
    async def handle_call_tool(name: str, arguments: dict | None) -> list[TextContent | ImageContent | EmbeddedResource]:
        return await handle_mcp_tool_call(name, arguments, mem)

async def handle_mcp_tool_call(name: str, arguments: dict | None, mem_inst: Memory = mem) -> list[TextContent | ImageContent | EmbeddedResource]:
    args = arguments or {}

    try:
        if name == "openmemory_query":
            tenant, err = _resolve_mcp_tenant(mem_inst, args)
            if err:
                return [TextContent(type="text", text=err)]
            q = args.get("query")
            qtype = args.get("type", "contextual")
            limit = args.get("k", 10)
            sector = args.get("sector")
            fact_pattern = args.get("fact_pattern", {})
            at_str = args.get("at")

            import datetime
            at_date = datetime.datetime.fromisoformat(at_str) if at_str else datetime.datetime.now()
            at_ts = int(at_date.timestamp() * 1000)

            results = {"type": qtype, "query": q}

            # contextual (hsg) query
            if qtype in ["contextual", "unified"]:
                filters = {}
                if sector: filters["sector"] = sector
                
                contextual = await mem_inst.search(q, user_id=tenant, limit=limit, **filters)
                results["contextual"] = [{
                    "source": "hsg",
                    "id": m.get("id"),
                    "score": round(m.get("score", 0), 4),
                    "primary_sector": m.get("primary_sector"),
                    "salience": round(m.get("salience", 0), 4),
                    "content": m.get("content")
                } for m in contextual]

            # temporal fact query
            if qtype in ["factual", "unified"]:
                facts = await query_facts_at_time(
                    subject=fact_pattern.get("subject"),
                    predicate=fact_pattern.get("predicate"),
                    obj=fact_pattern.get("object"),
                    at_time=at_ts,
                    min_confidence=0.0,
                    user_id=tenant
                )
                results["factual"] = [{
                    "source": "temporal",
                    "id": f["id"],
                    "subject": f["subject"],
                    "predicate": f["predicate"],
                    "object": f["object"],
                    "valid_from": f["valid_from"],
                    "valid_to": f.get("valid_to"),
                    "confidence": round(f["confidence"], 4),
                    "content": f"{f['subject']} {f['predicate']} {f['object']}"
                } for f in facts]

            # build summary
            if qtype == "contextual":
                count = len(results.get("contextual", []))
                summary = f"Found {count} contextual memories for '{q}'" if count > 0 else "No contextual memories matched."
            elif qtype == "factual":
                count = len(results.get("factual", []))
                summary = f"Found {count} temporal facts" if count > 0 else "No temporal facts matched."
            else:  # unified
                ctx_count = len(results.get("contextual", []))
                fact_count = len(results.get("factual", []))
                summary = f"Found {ctx_count} contextual memories and {fact_count} temporal facts"

            return [
                TextContent(type="text", text=summary),
                TextContent(type="text", text=json.dumps(results, default=str, indent=2))
            ]

        elif name == "openmemory_store":
            tenant, err = _resolve_mcp_tenant(mem_inst, args)
            if err:
                return [TextContent(type="text", text=err)]
            content = args.get("content")
            stype = args.get("type", "contextual")
            tags = args.get("tags", [])
            meta = args.get("metadata", {})
            facts_data = args.get("facts", [])

            # validate facts requirement
            if stype in ["factual", "both"] and not facts_data:
                raise ValueError(f"Facts array is required when type is '{stype}'. Please provide at least one fact.")

            results = {"type": stype}

            # store contextual memory
            if stype in ["contextual", "both"]:
                if tags: meta["tags"] = tags
                res = await mem_inst.add(content, user_id=tenant, meta=meta)
                results["hsg"] = {
                    "id": res.get('root_memory_id') or res.get('id'),
                    "primary_sector": res.get('primary_sector')
                }

            # store temporal facts
            if stype in ["factual", "both"] and facts_data:
                import datetime
                temporal_results = []
                for fact in facts_data:
                    valid_from_str = fact.get("valid_from")
                    valid_from_dt = datetime.datetime.fromisoformat(valid_from_str) if valid_from_str else datetime.datetime.now()
                    valid_from_ts = int(valid_from_dt.timestamp() * 1000)
                    confidence = fact.get("confidence", 1.0)
                    
                    fact_id = await insert_fact(
                        subject=fact["subject"],
                        predicate=fact["predicate"],
                        subject_object=fact["object"],
                        valid_from=valid_from_ts,
                        confidence=confidence,
                        metadata=meta,
                        user_id=tenant
                    )

                    temporal_results.append({
                        "id": fact_id,
                        "subject": fact["subject"],
                        "predicate": fact["predicate"],
                        "object": fact["object"],
                        "valid_from": valid_from_dt.isoformat(),
                        "confidence": confidence
                    })
                results["temporal"] = temporal_results

            # build response message
            if stype == "contextual":
                txt = f"Stored memory {results['hsg']['id']}"
                if tenant:
                    txt += f" [user={tenant}]"
            elif stype == "factual":
                txt = f"Stored {len(results['temporal'])} temporal fact(s)"
                if tenant:
                    txt += f" [user={tenant}]"
            else:  # both
                txt = f"Stored in both systems: HSG memory {results['hsg']['id']} + {len(results['temporal'])} temporal fact(s)"
                if tenant:
                    txt += f" [user={tenant}]"

            return [
                TextContent(type="text", text=txt),
                TextContent(type="text", text=json.dumps(results, default=str, indent=2))
            ]

        elif name == "openmemory_get":
            m_dict, tenant, err = await _get_verified_memory(mem_inst, args)
            if err:
                return [TextContent(type="text", text=err)]
            return [TextContent(type="text", text=json.dumps(m_dict, default=str, indent=2))]

        elif name == "openmemory_delete":
            m_dict, tenant, err = await _get_verified_memory(mem_inst, args)
            if err:
                return [TextContent(type="text", text=err)]

            await mem_inst.delete(m_dict["id"], user_id=tenant)
            return [TextContent(type="text", text=f"Memory {m_dict['id']} deleted")]

        elif name == "openmemory_list":
            tenant, err = _resolve_mcp_tenant(mem_inst, args)
            if err:
                return [TextContent(type="text", text=err)]
            limit = args.get("limit", 20)
            res = mem_inst.history(user_id=tenant, limit=limit)
            return [TextContent(type="text", text=json.dumps([dict(r) for r in res], default=str, indent=2))]

        else:
            raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        return [TextContent(type="text", text=f"Error: {str(e)}")]

    async with stdio_server() as (read, write):
        await server.run(read, write, NotificationOptions(), raise_exceptions=False)
