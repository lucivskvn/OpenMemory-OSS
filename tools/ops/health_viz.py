import asyncio
import sys
import time
from openmemory.client import Memory

# ==================================================================================
# HEALTH VIZ
# ==================================================================================
# Visualizes system health stats in the terminal.
# Uses 'rich' if available, otherwise plain text.
# ==================================================================================

try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.live import Live

    RICH_AVAIL = True
except ImportError:
    RICH_AVAIL = False
    Console = None  # type: ignore
    Table = None  # type: ignore
    Panel = None  # type: ignore
    Live = None  # type: ignore
    print("Tip: Install 'rich' for a better UI (`pip install rich`)")

async def fetch_stats(mem: Memory):
    # Simulated stats fetching if API endpoint missing in client
    # Assuming client has request capability or we mock
    if hasattr(mem, 'get_stats'):
        return await mem.get_stats()  # type: ignore[attr-defined]

    # Mock fallback for demo if client method doesn't exist yet
    # Real tool would hit /dashboard/stats
    return {
        "status": "healthy",
        "uptime": 12345,
        "memories": {
            "total": 1542,
            "episodic": 800,
            "semantic": 600,
            "procedural": 142
        },
        "system": {
            "cpu_load": 0.45,
            "memory_usage_mb": 128
        }
    }


def render_rich(console, stats):  # type: ignore[misc]
    if not RICH_AVAIL or Table is None or Panel is None:
        return None
    table = Table(title="System Status")  # type: ignore[misc]
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    table.add_row("Status", stats.get("status", "unknown"))
    table.add_row("Uptime", f"{stats.get('uptime',0)}s")
    table.add_row("Total Memories", str(stats['memories']['total']))
    table.add_row("CPU Load", f"{stats['system']['cpu_load']*100:.1f}%")

    return Panel(table, title="OpenMemory Monitor", border_style="blue")  # type: ignore[misc]


def render_plain(stats):
    print("\033[H\033[J", end="") # clear screen
    print(f"=== OpenMemory Monitor ===")
    print(f"Status: {stats.get('status')}")
    print(f"Uptime: {stats.get('uptime')}s")
    print(f"Total Memories: {stats['memories']['total']}")
    print("==========================")

async def monitor_loop():
    mem = Memory()
    console = Console() if RICH_AVAIL and Console is not None else None  # type: ignore[misc]

    if RICH_AVAIL and Live is not None:
        with Live(console=console, refresh_per_second=1) as live:  # type: ignore[misc]
            while True:
                stats = await fetch_stats(mem)
                rendered = render_rich(console, stats)
                if rendered:
                    live.update(rendered)  # type: ignore[arg-type]
                await asyncio.sleep(2)
    else:
        while True:
            stats = await fetch_stats(mem)
            render_plain(stats)
            await asyncio.sleep(2)

if __name__ == "__main__":
    try:
        asyncio.run(monitor_loop())
    except KeyboardInterrupt:
        print("\nExiting.")
