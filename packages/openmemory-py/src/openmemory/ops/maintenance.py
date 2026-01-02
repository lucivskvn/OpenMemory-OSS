import asyncio
import time
import json
import logging
from typing import List, Dict, Any, Optional
from ..core.db import q, db
from ..core.learned_classifier import LearnedClassifier
from ..core.config import env
from ..utils.vectors import buf_to_vec

logger = logging.getLogger("maintenance")

# Concurrent training limit
TRAINING_SEMAPHORE = asyncio.Semaphore(3)

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
        await db.async_execute("DELETE FROM stats WHERE ts < ?", (limit_ts,))
        await db.async_commit()
    except Exception as e:
        logger.error(f"[maintenance] Stats cleanup failed: {e}")

async def maintenance_retrain_all():
    """Routine retraining for all active users using concurrent semaphore."""
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
    await optimize_database()
    await cleanup_stats(days=env.stats_retention_days or 30)

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
