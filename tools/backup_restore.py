
import asyncio
import argparse
import json
import gzip
import time
from datetime import datetime
from openmemory.client import Memory

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
            user_list = mem.list_users()
        except Exception as e:
            print(f"Warning: Failed to list users: {e}. Defaulting to demo user.")
            user_list = ["anonymous"]

        for uid in user_list:
            print(f"   Backing up user: {uid}")
            # history is sync in current SDK
            try:
                curr_hist = mem.history(user_id=uid, limit=1000)
                for item in curr_hist:
                    # Convert types for JSON serialization if needed
                    # item is already a dict from mem.history()
                    f.write(json.dumps(item) + '\n')
                    count += 1
            except Exception as e:
                print(f"   Error backing up user {uid}: {e}")
            
    print(f"-> Backup complete. {count} memories saved.")
            
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
            meta = item.get('metadata') or {}
            tags = item.get('tags') or []
            
            if content and uid:
                await mem.add(content, user_id=uid, meta=meta, tags=tags)
                count += 1
            
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
