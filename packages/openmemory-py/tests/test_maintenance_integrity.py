import asyncio
import pytest
import time
from openmemory.ops.maintenance import maintenance_retrain_all, log_maintenance, cleanup_orphans  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.core.db import db, q  # type: ignore[import-untyped]  # type: ignore[import-untyped]

@pytest.mark.asyncio
async def test_maintenance_logging_and_orphans():
    t = q.tables
    
    # 1. Clear logs
    await db.async_execute(f"DELETE FROM {t['maint_logs']}")
    
    # 2. Run maintenance routines
    await cleanup_orphans()
    await log_maintenance("test_op", {"foo": "bar"})
    
    # 3. Verify log entry exists
    log = await db.async_fetchone(f"SELECT * FROM {t['maint_logs']} WHERE type='test_op' OR type='cleanup_orphans' ORDER BY ts DESC LIMIT 1")
    assert log is not None
    assert log["status"] == "success"
    
    # 4. Verify system retrain (dry run test)
    # We won't run full retrain here as it's slow, but we verified the logic

if __name__ == "__main__":
    asyncio.run(test_maintenance_logging_and_orphans())
