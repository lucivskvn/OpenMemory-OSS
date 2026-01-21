import json
import time
from typing import Optional, Dict, Any
from .db import db, q
from .security import get_encryption

async def get_persisted_config(user_id: str, type_key: str) -> Dict[str, Any]:
    """
    Retrieve and decrypt persisted configuration.
    """
    t = q.tables
    row = await db.async_fetchone(
        f"SELECT config FROM {t['source_configs']} WHERE user_id=? AND type=?",
        (user_id, type_key)
    )
    
    if not row:
        return {}
        
    config_str = row["config"]
    if not config_str:
        return {}

    # Decryption handled here? JS version does:
    # "const { getEncryption } = require('./security'); ... decrypt(config)"
    # Let's check if the field is encrypted. 
    # Usually config blobs are encrypted at rest.
    
    enc = get_encryption()
    try:
        # Try to decrypt if it looks encrypted (or always try)
        # JS implementation assumes encrypted.
        decrypted = enc.decrypt(config_str)
        return json.loads(decrypted)
    except Exception:
        # Fallback if plain text (legacy) or decryption fails
        try:
            return json.loads(config_str)
        except:
            return {}

async def set_persisted_config(user_id: str, type_key: str, config: Dict[str, Any]):
    """
    Encrypt and store configuration.
    """
    t = q.tables
    enc = get_encryption()
    
    json_str = json.dumps(config)
    encrypted = enc.encrypt(json_str)
    
    ts = int(time.time() * 1000)
    
    # Upsert logic
    # SQLite: INSERT OR REPLACE or ON CONFLICT
    # PG: ON CONFLICT DO UPDATE
    
    sql = f"""
    INSERT INTO {t['source_configs']} (user_id, type, config, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, type) DO UPDATE SET
    config=excluded.config, updated_at=excluded.updated_at
    """
    
    await db.async_execute(sql, (user_id, type_key, encrypted, ts))
    await db.async_commit()
