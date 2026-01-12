"""
OpenMemory Python Client Parity Verification.
This script demonstrates the usage of the OpenMemory Python SDK MemoryClient.
"""
import asyncio
import sys
import argparse
from openmemory.client import MemoryClient

async def main():
    parser = argparse.ArgumentParser(description="OpenMemory Parity Check")
    parser.add_argument("--url", default="http://localhost:8080", help="OpenMemory Server URL")
    args = parser.parse_args()

    client = MemoryClient(base_url=args.url)
    
    print(f"Connecting to {args.url}...")
    if not await client.health():
        print("[X] Server not available or unhealthy.")
        print("Please ensure OpenMemory server is running (e.g. docker compose up)")
        await client.close()
        return

    print("[OK] Server online.")

    # 1. Add Memory
    print("\n[1] Adding Memory...")
    content = "OpenMemory Python SDK Parity Check"
    try:
        mem = await client.add(content, tags=["test", "parity"], meta={"source": "example"})
        print(f"[OK] Created Memory: {mem.get('id')} | Salience: {mem.get('salience', 'N/A')}")
    except Exception as e:
        print(f"[X] Failed to add: {e}")
        await client.close()
        return

    # 2. Search
    print("\n[2] Searching...")
    try:
        results = await client.search("parity")
        print(f"[OK] Found {len(results)} results")
        if results:
            print(f"   Top result: {results[0].get('content')}")
    except Exception as e:
        print(f"[X] Failed to search: {e}")

    # 3. Get
    if 'mem' in locals():
        print("\n[3] Retrieving Memory...")
        try:
            fetched = await client.get(mem['id'])
            if fetched:
                print(f"[OK] Retrieved: {fetched.get('id')}")
            else:
                print("[X] Memory not found")
        except Exception as e:
            print(f"[X] Failed to get: {e}")

    await client.close()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
