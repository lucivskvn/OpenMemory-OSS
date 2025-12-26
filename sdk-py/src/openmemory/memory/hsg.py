try:
    import numpy as np
except ImportError:
    np = None
import time
import uuid
import json
from openmemory.core.db import q, transaction
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
    from ..core.db import vector_store
    if not vector_store:
        return

    # Optimization: Use vector search to find best semantic match
    candidates = await vector_store.search(mean_vec, 20)

    best = None
    if candidates:
        cand_ids = [c['id'] for c in candidates if c['id'] != id]
        if cand_ids:
            # Fetch candidates to check user_id if needed
            # Assuming q.get_mems_by_ids exists or use many_query
            # In SDK, q is wrapper around db methods.
            # q.get_mems_by_ids might not exist in Python SDK yet?
            # Let's check db.py later or rely on vector store if it returned user_id?
            # vector store doesn't return user_id in search usually.
            # Fallback to simple SQL for now.
            from ..core.db import many_query
            placeholders = ",".join("?" * len(cand_ids))
            sql = f"select id, user_id from memories where id in ({placeholders})"
            mems = many_query(sql, tuple(cand_ids))
            mem_map = {m['id']: m for m in mems}

            for cand in candidates:
                if cand['id'] == id: continue

                m = mem_map.get(cand['id'])
                if not m: continue
                if user_id and m['user_id'] != user_id: continue

                if not best or cand['score'] > best['similarity']:
                    best = {'id': cand['id'], 'similarity': cand['score']}

    # Fallback to recent if no vector match (cold start)
    if not best:
        # Simplified recent fetch
        from ..core.db import many_query
        sql = "select id, mean_vec from memories order by created_at desc limit 50"
        if user_id:
            sql = f"select id, mean_vec from memories where user_id='{user_id}' order by created_at desc limit 50"

        recent = many_query(sql)
        for mem in recent:
            if mem['id'] == id or not mem['mean_vec']: continue
            vec = buffer_to_vector(mem['mean_vec'])
            if len(vec) != len(mean_vec): continue

            # Dot product
            sim = sum(a*b for a,b in zip(vec, mean_vec))
            if not best or sim > best['similarity']:
                best = {'id': mem['id'], 'similarity': sim}

    if best:
        q.ins_waypoint.run(id, best['id'], user_id, best['similarity'], now, now)
    else:
        q.ins_waypoint.run(id, id, user_id, 1.0, now, now)

async def create_cross_sector_waypoints(id, primary, additional, user_id):
    if not additional: return
    now = int(time.time() * 1000)
    for sec in additional:
        q.ins_waypoint.run(id, f"{id}:{sec}", user_id, 0.5, now, now)
        q.ins_waypoint.run(f"{id}:{sec}", id, user_id, 0.5, now, now)

async def hsg_query(query, k=10, filters=None):
    # 1. Embed query
    embeddings = await embed_multi_sector("query", query, ["query"])
    if not embeddings:
        return []
    
    query_vec = embeddings[0]["vector"]
    
    # 2. Fetch only vectors (id, mean_vec) to compute similarity, then fetch content
    from ..core.db import many_query, q
    
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

    # Batch retrieval
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
    
    q.upd_seen.run(now_ts, new_sal, now_ts, id)

async def add_hsg_memory(content, tags=[], metadata=None, user_id=None):
    id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    
    classification = classify_content(content, metadata)
    primary_sector = classification["primary"]
    all_sectors = [primary_sector] + classification["additional"]

    # 1. Embed outside transaction
    embeddings = await embed_multi_sector(id, content, all_sectors)
    mean_vec = calc_mean_vec(embeddings, all_sectors)

    # 2. Transactional write
    with transaction:
        # Check segment rotation (simplified)
        max_seg_res = q.get_max_segment.get()
        cur_seg = max_seg_res["max_seg"] if max_seg_res else 0

        init_sal = 1.0 # simplified
        decay = sector_configs.get(primary_sector, {}).get("decay_lambda", 0.01)

        q.ins_mem.run(
            id, user_id, cur_seg, content, "", primary_sector,
            json.dumps(tags), json.dumps(metadata or {}), now, now, now,
            init_sal, decay, 1, len(mean_vec), vector_to_buffer(mean_vec), None, 0
        )

        # Store vectors
        for emb in embeddings:
            from ..core.db import vector_store
            if vector_store:
                # Synchronous in SQLite
                vector_store.store_vector(id, emb["sector"], emb["vector"], len(emb["vector"]), user_id)

        await create_single_waypoint(id, mean_vec, now, user_id)
        await create_cross_sector_waypoints(id, primary_sector, classification["additional"], user_id)

    return {
        "id": id,
        "primary_sector": primary_sector,
        "sectors": all_sectors
    }
