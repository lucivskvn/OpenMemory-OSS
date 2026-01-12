import time
import json
import asyncio
import logging
from typing import Dict, Any, List
from ..core.db import q, db
from ..core.config import env
from ..ai.adapters import get_adapter

# Port of backend/src/memory/user_summary.ts

logger = logging.getLogger("user_summary")

def gen_user_summary(mems: List[Dict]) -> str:
    if not mems: return "User profile initializing... (No memories recorded yet)"
    
    projects = set()
    languages = set()
    files = set()
    saves = 0
    events = 0
    
    for m in mems:
        # sqlite3.Row doesn't have .get()
        d = dict(m)
        if d.get("meta"):
            try:
                meta = json.loads(m["meta"]) if isinstance(m["meta"], str) else m["meta"]
                if not isinstance(meta, dict): meta = {}
                if meta.get("ide_project_name"): projects.add(meta["ide_project_name"])
                if meta.get("language"): languages.add(meta["language"])
                if meta.get("ide_file_path"): 
                    files.add(meta["ide_file_path"].replace("\\", "/").split("/")[-1])
                if meta.get("ide_event_type") == "save": saves += 1
            except Exception:
                pass
        events += 1
        
    proj_str = ", ".join(projects) if projects else "Unknown Project"
    lang_str = ", ".join(languages) if languages else "General"
    recent_files = ", ".join(list(files)[:3]) if files else "various files"
    
    created_at = mems[0]["created_at"]
    last_active = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(created_at/1000)) if created_at else "Recently"
    
    return f"Active in {proj_str} using {lang_str}. Focused on {recent_files}. ({len(mems)} memories, {saves} saves). Last active: {last_active}."

async def gen_user_summary_async(user_id: str) -> str:
    # q.all_mem_by_user.all(user_id, 100, 0)
    # Reimplement query
    t = q.tables
    rows = await db.async_fetchall(f"SELECT * FROM {t['memories']} WHERE user_id=? ORDER BY created_at DESC LIMIT 100 OFFSET 0", (user_id,))
    
    if env.tier == "smart" or (env.openai_key or env.gemini_key):
        return await gen_user_summary_smart(rows, user_id)
        
    return gen_user_summary(rows)

async def gen_user_summary_smart(mems: List[Dict], user_id: str) -> str:
    if not mems: return "User profile initializing..."
    
    # Simple extraction for context
    context = []
    for m in mems[:50]: # Limit to 50 for context window
        try:
             # Just use partial content to save tokens
             c_snip = m["content"][:200]
             meta = m.get("meta") or "{}"
             context.append(f"- [{m['primary_sector']}] {c_snip} (Meta: {meta})")
        except Exception:
            pass
        
    prompt = f"""You are analyzing the memory stream of user '{user_id}'.
Based on the following {len(context)} recent memory fragments, generate a concise, high-level professional profile summary.
Focus on:
1. Current active projects and technologies.
2. key goals or problems being solved.
3. User's preferred working style or patterns.

Keep it under 100 words.

Memories:
{chr(10).join(context)}
"""
    try:
        adapter = await get_adapter(user_id)
        model = env.model or "gpt-4o"
        summary = await adapter.chat([{"role": "user", "content": prompt}], model=model)
        return summary.strip()
    except Exception as e:
        logger.error(f"[USER_SUMMARY] Smart summary failed: {e}")
        return gen_user_summary(mems)

async def update_user_summary(user_id: str):
    try:
        summary = await gen_user_summary_async(user_id)
        now = int(time.time()*1000)
        
        existing = await q.get_user(user_id)
        if not existing:
             await q.ins_user(user_id, summary, 0, now, now)
        else:
             await q.upd_user_summary(user_id, summary, now)
        await db.async_commit()
    except Exception as e:
        logger.error(f"[USER_SUMMARY] Error for {user_id}: {e}")

async def auto_update_user_summaries():
    users = await q.get_active_users()
    uids = [u["user_id"] for u in users if u["user_id"]]
    
    updated = 0
    for u in uids:
        await update_user_summary(u)
        updated += 1
    return {"updated": updated}

_timer_task = None

async def user_summary_loop():
    interval = (env.user_summary_interval or 30) * 60
    while True:
        try:
            await auto_update_user_summaries()
        except Exception as e:
            logger.error(f"[USER_SUMMARY] Loop error: {e}")
        await asyncio.sleep(interval)

def start_user_summary_reflection():
    global _timer_task
    if _timer_task: return
    _timer_task = asyncio.create_task(user_summary_loop())
    
def stop_user_summary_reflection():
    global _timer_task
    if _timer_task:
        _timer_task.cancel()
        _timer_task = None
