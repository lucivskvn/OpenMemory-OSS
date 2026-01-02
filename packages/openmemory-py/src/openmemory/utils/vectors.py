import math
import uuid
import time
import json
import struct
import numpy as np
from typing import List, Union, Any

# Ported from backend/src/utils/index.ts

def now() -> int:
    return int(time.time() * 1000)

def rid() -> str:
    return str(uuid.uuid4())

def cos_sim(a: Union[List[float], np.ndarray], b: Union[List[float], np.ndarray]) -> float:
    # generic handle list or numpy
    if isinstance(a, list): a = np.array(a, dtype=np.float32)
    if isinstance(b, list): b = np.array(b, dtype=np.float32)
    
    dot = float(np.dot(a, b))
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    
    d = na * nb
    if d < 1e-9: return 0.0
    return dot / d

def j(x: Any) -> str:
    return json.dumps(x)

def p(x: str) -> Any:
    return json.loads(x)

def vec_to_buf(v: List[float]) -> bytes:
    # float32 array to bytes
    return struct.pack(f"{len(v)}f", *v)

def buf_to_vec(buf: bytes) -> List[float]:
    cnt = len(buf) // 4
    return list(struct.unpack(f"{cnt}f", buf))

def compress_vec_for_storage(vec: List[float], target_dim: int) -> List[float]:
    if len(vec) <= target_dim: return vec
    bucket_sz = len(vec) / target_dim
    compressed = []
    for i in range(target_dim):
        start = math.floor(i * bucket_sz)
        end = math.floor((i + 1) * bucket_sz)
        chunk = vec[start:end]
        compressed.append(sum(chunk) / len(chunk) if chunk else 0.0)
    
    # normalize
    c_arr = np.array(compressed, dtype=np.float32)
    norm = np.linalg.norm(c_arr)
    if norm > 0:
        c_arr /= norm
    return c_arr.tolist()
