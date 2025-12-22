try:
    import numpy as np
except ImportError:
    np = None
import time
from openmemory.core.db import q
from openmemory.memory.embed import embed_multi_sector, buffer_to_vector, vector_to_buffer

sector_configs = {
    "episodic": {"decay_lambda": 0.005},
    "semantic": {"decay_lambda": 0.001},
    "procedural": {"decay_lambda": 0.002},
    "emotional": {"decay_lambda": 0.01},
    "reflective": {"decay_lambda": 0.001}
}

def classify_content(content, metadata=None):
    # Simple keyword-based classification for now, mirroring JS logic if it was simple
    # or just defaulting to episodic/semantic
    content_lower = content.lower()
    primary = "episodic"
    additional = []

    if "how to" in content_lower or "step" in content_lower:
        primary = "procedural"
    elif "feel" in content_lower or "happy" in content_lower or "sad" in content_lower:
        primary = "emotional"
    elif "define" in content_lower or "what is" in content_lower:
        primary = "semantic"
    
    # Add others based on tags if present in metadata
    if metadata and "tags" in metadata:
        tags = metadata["tags"]
        if "learning" in tags: additional.append("semantic")
        if "emotion" in tags: additional.append("emotional")
    
    return {
        "primary": primary,
        "additional": list(set(additional))
    }

def calc_mean_vec(embeddings, sectors):
    if not embeddings:
        return np.array([]) if np else []
    
    vecs = [e["vector"] for e in embeddings]
    if not vecs:
        return np.array([]) if np else []
        
    if np:
        # Simple mean
        mean = np.mean(vecs, axis=0)
        # Normalize
        norm = np.linalg.norm(mean)
        if norm > 0:
            mean = mean / norm
        return mean.astype(np.float32)
    else:
        # Pure python mean
        dim = len(vecs[0])
        mean = [0.0] * dim
        for v in vecs:
            for i in range(dim):
                mean[i] += v[i]
        
        count = len(vecs)
        mean = [x/count for x in mean]
        
        # Normalize
        norm = sum(x*x for x in mean) ** 0.5
        if norm > 0:
            mean = [x/norm for x in mean]
        return mean

async def create_single_waypoint(id, mean_vec, now, user_id):
    # In a real implementation, this would find nearest neighbors and create edges
    # For now, just a placeholder or minimal implementation
    pass

async def create_cross_sector_waypoints(id, primary, additional, user_id):
    pass

async def hsg_query(query, k=10, filters=None):
    # 1. Embed query
    embeddings = await embed_multi_sector("query", query, ["query"])
    if not embeddings:
        return []
    
    query_vec = embeddings[0]["vector"]
    
    # 2. Fetch only vectors (id, mean_vec) to compute similarity, then fetch content
    # We add get_all_mean_vecs to db.py or use a custom query here
    from ..core.db import many_query, q
    
    # Use many_query directly for optimization or add to Q
    # Filter by user_id at DB level if possible?
    # db.py doesn't have get_mean_vecs_by_user yet.
    
    sql = "select id, mean_vec, user_id, salience, created_at from memories order by created_at desc limit 1000"
    if filters and filters.get("user_id"):
        sql = f"select id, mean_vec, user_id, salience, created_at from memories where user_id='{filters['user_id']}' order by created_at desc limit 1000"

    candidates = many_query(sql)
    
    scored = []
    for mem in candidates:
        if not mem["mean_vec"]: continue
        
        # Apply filters on metadata fields available
        if filters:
            if filters.get("user_id") and mem["user_id"] != filters["user_id"]: continue
            if filters.get("startTime") and mem["created_at"] < filters["startTime"]: continue
            if filters.get("endTime") and mem["created_at"] > filters["endTime"]: continue
            if filters.get("minSalience") and mem.get("salience", 0) < filters["minSalience"]: continue

        vec = buffer_to_vector(mem["mean_vec"])
        if len(vec) != len(query_vec): continue
        
        if np:
            score = np.dot(vec, query_vec)
        else:
            score = sum(a*b for a,b in zip(vec, query_vec))
        
        scored.append((mem["id"], float(score)))
        
    scored.sort(key=lambda x: x[1], reverse=True)
    top_k = scored[:k]

    if not top_k:
        return []

    # 3. Fetch full content for top k
    ids = [x[0] for x in top_k]
    full_mems = q.get_mems_by_ids.all(ids)

    # Map back to results with score
    id_map = {m["id"]: m for m in full_mems}
    results = []
    for mid, score in top_k:
        if mid in id_map:
            results.append({
                **dict(id_map[mid]),
                "score": score
            })

    return results

async def reinforce_memory(id, boost=0.1):
    mem = q.get_mem.get(id)
    if not mem:
        raise ValueError(f"Memory {id} not found")
    
    current_salience = mem["salience"] if "salience" in mem else 0.5
    new_sal = min(1.0, current_salience + boost)
    now_ts = int(time.time() * 1000)
    
    # We need a query to update salience. Python SDK db.py is missing generic update, implementing SQL exec.
    # q.upd_seen logic from backend: update last_seen, salience.
    # Let's add upd_seen to db.py or execute raw SQL here?
    # db.exec_query is available.
    
    from ..core.db import exec_query
    exec_query("update memories set salience=?, last_seen_at=?, updated_at=? where id=?", (new_sal, now_ts, now_ts, id))
