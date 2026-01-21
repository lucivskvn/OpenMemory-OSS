
import { MemoryClient } from "../client";
import { Memory } from "../core/memory";
import { LocalAdapter, RemoteAdapter, CliMemoryInterface } from "./adapter";
import { CliFlags } from "./types";

let client: CliMemoryInterface | null = null;

export async function ensureClient(flags: CliFlags): Promise<CliMemoryInterface> {
  if (client) return client;

  const host = flags.host || Bun.env.OM_HOST;

  if (host) {
    // Remote Mode
    const token = Bun.env.OM_API_KEY || "";
    const c = new MemoryClient({ baseUrl: host, token });

    // Quick health check
    try {
      const ok = await c.health();
      if (!ok) console.warn("\x1b[33mWarning: Remote host reported unhealthy.\x1b[0m");
    } catch (e) {
      console.warn(`\x1b[33mWarning: Could not connect to ${host}. Operations might fail.\x1b[0m`);
    }

    client = new RemoteAdapter(c);
  } else {
    // Local Mode
    // Initialize Core Memory
    const mem = new Memory(flags.userId);
    client = new LocalAdapter(mem);
  }
  return client;
}

export function printHelp() {
  console.log(`
\x1b[1;35mOpenMemory (opm) CLI\x1b[0m
Usage: opm <command> [args] [--host <url>] [--user-id <id>]

Core Commands:
  \x1b[33madd\x1b[0m <text>          Add memory
  \x1b[33msearch\x1b[0m <query>      Search memories
  \x1b[33mdelete\x1b[0m <id>         Delete memory
  \x1b[33mupdate\x1b[0m <id> <text>  Update memory
  \x1b[33mstats\x1b[0m               System stats
  \x1b[33mlogs\x1b[0m [--limit n]     View maintenance logs
  \x1b[33mdoctor\x1b[0m              Health check
  \x1b[33mingest-url\x1b[0m <url>    Ingest webpage
  \x1b[33mingest\x1b[0m <source>     Ingest source (github, notion, etc)

Temporal Commands:
  \x1b[33madd-fact\x1b[0m <s> <p> <o>
  \x1b[33msearch-facts\x1b[0m <pattern>
  \x1b[33mtimeline\x1b[0m <s>
  \x1b[33mcompare\x1b[0m <s> [t1] [t2]

Maintenance (Local Only):
  \x1b[33mmigrate\x1b[0m             Run DB migrations
  \x1b[33mstart\x1b[0m               Start API Server
  \x1b[33mmcp start\x1b[0m           Start MCP Server (Stdio)
  \x1b[33msetup\x1b[0m <token>       Init Admin Key
  \x1b[33mwipe\x1b[0m                Wipe DB

Flags:
  --host <url>       Remote server (Standard: http://localhost:8080)
  --user-id <id>     Target User
  --limit <n>        Max results
`);
}
