import asyncio
import time
import uuid
import json
import logging
from typing import List, Dict, Any, Optional
from ..core.db import q, db
from ..core.learned_classifier import LearnedClassifier
from ..core.config import env
from ..utils.vectors import buf_to_vec
from ..memory.reflect import run_reflection
from ..memory.decay import apply_decay

logger = logging.getLogger("maintenance")

# Concurrent training limit
TRAINING_SEMAPHORE = asyncio.Semaphore(3)

async def trigger_maintenance(task: str):
    """
    Trigger a maintenance task (reflect, decay) in the background.
    Safe for local mode (asyncio.create_task).
    """
    async def _safe_run():
        try:
            if task == "reflect":
                await run_reflection()
            elif task == "decay":
                await apply_decay()
            else:
                logger.warning(f"[maintenance] Unknown task triggered: {task}")
        except Exception as e:
            logger.error(f"[maintenance] Background task {task} failed: {e}")

    # Fire and forget
    asyncio.create_task(_safe_run())

async def log_maintenance(op: str, details: Dict[str, Any], status: str = "success", error: Optional[str] = None):
    """Log a maintenance operation to the database."""
    try:
        t = q.tables
        now = int(time.time() * 1000)
        if error:
            details["error"] = error
        await db.async_execute(
            f"INSERT INTO {t['maint_logs']}(id, type, status, ts, details) VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), op, status, now, json.dumps(details, default=str))
        )
        await db.async_commit()
    except Exception as e:
        logger.error(f"[maintenance] Failed to write to maint_logs: {e}")

async def train_user_classifier(user_id: str, epochs: int = 20) -> Optional[Dict[str, Any]]:
    """
    Trains/Updates the sector classifier model for a specific user.
    """
    if env.verbose: logger.info(f"[maintenance] Training classifier for user: {user_id}")

    # 1. Fetch training data
    data = await q.get_training_data(user_id, limit=10000)
    
    if len(data) < 10:
        if env.verbose: logger.info(f"[maintenance] Not enough data to train classifier for {user_id} ({len(data)} samples)")
        return None

    # 2. Format data for training
    training_samples = [
        {
            "vector": buf_to_vec(d["mean_vec"]),
            "label": d["primary_sector"]
        }
        for d in data
    ]

    # 3. Get existing model
    existing = await q.get_classifier_model(user_id)
    existing_model = None
    if existing:
        try:
            existing_model = {
                "user_id": user_id,
                "weights": json.loads(existing["weights"]),
                "biases": json.loads(existing["biases"]),
                "version": existing["version"],
                "updated_at": existing["updated_at"]
            }
        except Exception as e:
            logger.error(f"[maintenance] Error parsing existing model for {user_id}: {e}")

    # 4. Train the model
    new_model = LearnedClassifier.train(training_samples, existing_model, lr=0.01, epochs=epochs)

    # 5. Save the model back to DB
    await q.ins_classifier_model(
        user_id,
        json.dumps(new_model["weights"]),
        json.dumps(new_model["biases"]),
        new_model["version"],
        new_model["updated_at"]
    )

    if env.verbose: logger.info(f"[maintenance] Successfully trained and saved model for {user_id}. Samples: {len(data)}")
    return new_model

async def optimize_database():
    """Performs database maintenance: VACUUM/REINDEX (SQLite) or ANALYZE (Postgres)."""
    logger.info("[maintenance] Starting database optimization...")
    try:
        if db.is_pg:
            # Postgres: Update statistics
            await db.async_execute("ANALYZE")
        else:
            # SQLite: Reclaim space
            await db.async_execute("VACUUM")
        logger.info("[maintenance] Database optimization complete")
    except Exception as e:
        logger.error(f"[maintenance] Database optimization failed: {e}")

async def cleanup_stats(days: int = 30):
    """Prunes old entries from the stats table."""
    limit_ts = int((time.time() - (days * 86400)) * 1000)
    logger.info(f"[maintenance] Cleaning up stats older than {days} days...")
    try:
        t = q.tables
        async with db.transaction():
            await db.async_execute(f"DELETE FROM {t['stats']} WHERE ts < ?", (limit_ts,))
        logger.info(f"[maintenance] Stats cleanup complete.")
    except Exception as e:
        logger.error(f"[maintenance] Stats cleanup failed: {e}")

async def cleanup_orphans():
    """Removes records from secondary tables that refer to non-existent memories."""
    logger.info("[maintenance] Starting orphan cleanup...")
    t = q.tables
    try:
        async with db.transaction():
            # 1. Clean vectors
            v_ids = await db.async_execute(f"DELETE FROM {t['vectors']} WHERE id NOT IN (SELECT id FROM {t['memories']})")
            # 2. Clean waypoints
            w_ids = await db.async_execute(f"DELETE FROM {t['waypoints']} WHERE src_id NOT IN (SELECT id FROM {t['memories']}) OR dst_id NOT IN (SELECT id FROM {t['memories']})")
            
            # v_ids and w_ids are cursors in SQLite, rowcount matters
            v_cnt = v_ids.rowcount if hasattr(v_ids, "rowcount") else 0
            w_cnt = w_ids.rowcount if hasattr(w_ids, "rowcount") else 0
            
            await log_maintenance("cleanup_orphans", {"vectors_removed": v_cnt, "waypoints_removed": w_cnt})
            logger.info(f"[maintenance] Orphan cleanup complete. Removed {v_cnt} vectors and {w_cnt} waypoints.")
    except Exception as e:
        logger.error(f"[maintenance] Orphan cleanup failed: {e}")
        await log_maintenance("cleanup_orphans", {}, status="error", error=str(e))

async def maintenance_retrain_all():
    """Routine retraining for all active users using concurrent semaphore."""
    start_ts = int(time.time() * 1000)
    users = await q.get_active_users()
    if env.verbose: logger.info(f"[maintenance] Starting routine retraining for {len(users)} users")
    
    async def training_task(user_id):
        async with TRAINING_SEMAPHORE:
            try:
                await train_user_classifier(user_id)
            except Exception as e:
                logger.error(f"[maintenance] Failed to train classifier for user {user_id}: {e}")

    tasks = []
    for row in users:
        user_id = row.get("user_id")
        if not user_id: continue
        tasks.append(training_task(user_id))
    
    if tasks:
        await asyncio.gather(*tasks)
    
    # Also run DB optimization and cleanup as part of house-keeping
    await cleanup_orphans()
    await optimize_database()
    await cleanup_stats(days=env.stats_retention_days or 30)

    # Log end of cycle
    dur = (time.time() * 1000) - start_ts
    await log_maintenance("retrain_all", {"user_count": len(users), "duration_ms": dur})

# --- Loop Control ---

_maint_task = None

async def maintenance_loop():
    # Maintenance runs infrequently (e.g. every hour or day?)
    # env.maintenance_interval_hours default 24?
    interval = (env.maintenance_interval_hours or 24) * 3600
    while True:
        try:
             await maintenance_retrain_all()
        except Exception as e:
             logger.error(f"[maintenance] Loop error: {e}")
        await asyncio.sleep(interval)

def start_maintenance():
    global _maint_task
    if _maint_task: return
    _maint_task = asyncio.create_task(maintenance_loop())
    logger.info(f"[maintenance] Started: every {env.maintenance_interval_hours or 24}h")

def stop_maintenance():
    global _maint_task
    if _maint_task:
        _maint_task.cancel()
        _maint_task = None
