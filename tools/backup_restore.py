
import asyncio
import argparse
import json
import gzip
import time
from datetime import datetime
from openmemory.client import Memory  # type: ignore[import-untyped]

# ==================================================================================
# BACKUP & RESTORE TOOL
# ==================================================================================
# Usage:
#   python tools/backup_restore.py backup --file my_backup.json.gz
#   python tools/backup_restore.py restore --file my_backup.json.gz
#
# Formats:
#   JSON-lines compressed with GZIP.
# ==================================================================================

async def do_backup(filename: str):
    mem = Memory()
    print(f"-> Starting backup to {filename}...")
    
    count = 0
    with gzip.open(filename, 'wt', encoding='utf-8') as f:
        # Get all users
        try:
            user_list = await mem.list_users()
        except Exception as e:
            print(f"Warning: Failed to list users: {e}. Defaulting to demo user.")
            user_list = ["anonymous"]

        for uid in user_list:
            print(f"   Backing up user: {uid}")
            offset = 0
            BATCH_SIZE = 100
            
            while True:
                try:
                    curr_hist = await mem.history(user_id=uid, limit=BATCH_SIZE, offset=offset)
                    if not curr_hist:
                        break
                        
                    for item in curr_hist:
                        # Convert MemoryItem to dict for JSON serialization
                        item_dict = item.model_dump() if hasattr(item, 'model_dump') else dict(item)
                        f.write(json.dumps(item_dict) + '\n')
                        count += 1
                    
                    offset += BATCH_SIZE
                    print(f"     Saved {count}...", end='\r')
                except Exception as e:
                    print(f"   Error backing up user {uid} at offset {offset}: {e}")
                    break
            print("") # Newline
            
    print(f"-> Backup complete. {count} memories saved.")

async def do_restore(filename: str):
    mem = Memory()
    print(f"-> Restoring from {filename}...")
    
    count = 0
    with gzip.open(filename, 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            item = json.loads(line)
            
            # Restore
            content = item.get('content')
            uid = item.get('user_id')
            meta = item.get('metadata') or item.get('meta') or {}
            tags = item.get('tags') or []
            
            # Preserve Identity
            mid = item.get('id')
            created_at = item.get('created_at')
            
            if content and uid:
                try:
                    # Use import_memory to preserve ID/Timestamp
                    if hasattr(mem, 'import_memory'):
                        await mem.import_memory(content, user_id=uid, meta=meta, tags=tags, id=mid, created_at=created_at)
                    else:
                        # Fallback for older SDKs (should not reach here with updated codebase)
                        await mem.add(content, user_id=uid, meta=meta, tags=tags)
                    count += 1
                except Exception as e:
                    print(f"   Failed to restore {mid}: {e}")
            
            if count % 10 == 0:
                print(f"   Restored {count}...", end='\r')
                
    print(f"\n-> Restore complete. {count} memories re-ingested.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['backup', 'restore'])
    parser.add_argument('--file', required=True, help="Path to .json.gz file")
    
    args = parser.parse_args()
    
    if args.action == 'backup':
        asyncio.run(do_backup(args.file))
    else:
        asyncio.run(do_restore(args.file))
