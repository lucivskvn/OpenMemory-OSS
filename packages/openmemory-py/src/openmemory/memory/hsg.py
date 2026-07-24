import math
import time
import json
import logging
from typing import List, Dict, Any, Optional
from ..core.db import db, q
from ..core.config import env
from ..core.vector_store import VectorStore
from ..utils.chunking import chunk_text
from ..utils.vectors import cos_sim as cosine_similarity, vec_to_buf, buf_to_vec
from .embed import (
    classify_content,
    embed_multi_sector,
    embed_query_for_all_sectors,
    embed_for_sector,
    SECTOR_CONFIGS,
    SECTOR_RELATIONSHIPS
)
from .decay import calc_decay
from .user_summary import update_user_summary

logger = logging.getLogger("hsg")

# Global singleton or dependency injected? Assuming global for now.
# In a real app, this should be part of an app context.
from ..core.vector_store import vector_store as store

HYBRID_PARAMS = {
    "alpha": 0.5, # text overlap weight
    "beta": 0.4,  # vector similarity weight
    "gamma": 0.1, # associative waypoint weight
    "recency_lambda": 0.05
}

REINFORCEMENT = {
    "boost": 0.2,
    "prune_threshold": 0.15
}

def canonical_token_set(text: str) -> set:
    from ..utils.text import canonical_tokens_from_text
    return set(canonical_tokens_from_text(text))

def compute_simhash(text: str) -> str:
    from ..utils.text import stable_text_fallback_hash
    tokens = canonical_token_set(text)
    if not tokens:
        return stable_text_fallback_hash(text)

    hashes = []
    for t in tokens:
        h = 0
        for char in t:
            h = (h << 5) - h + ord(char)
            h = h & 0xffffffff
        hashes.append(h)

    vec = [0] * 64
    for h in hashes:
        for i in range(64):
            if h & (1 << i):
                vec[i] += 1
            else:
                vec[i] -= 1

    hash_str = ""
    for i in range(0, 64, 4):
        nibble = (
            (8 if vec[i] > 0 else 0) +
            (4 if vec[i + 1] > 0 else 0) +
            (2 if vec[i + 2] > 0 else 0) +
            (1 if vec[i + 3] > 0 else 0)
        )
        hash_str += hex(nibble)[2:]
    return hash_str

def compute_token_overlap(q_tokens: set, m_tokens: set) -> float:
    if not q_tokens or not m_tokens:
        return 0.0
    inter = q_tokens.intersection(m_tokens)
    return len(inter) / math.sqrt(len(q_tokens) * len(m_tokens))

def compute_keyword_overlap(q: str, m: str) -> float:
    qt = canonical_token_set(q)
    mt = canonical_token_set(m)
    return compute_token_overlap(qt, mt)

def calc_recency_score_decay(last_seen_at: int) -> float:
    now = int(time.time() * 1000)
    days = (now - last_seen_at) / 86400000.0
    return math.exp(-HYBRID_PARAMS["recency_lambda"] * days)

async def compute_tag_match_score(mid: str, q_tokens: set) -> float:
    # Simulating tag check - real impl would join tags table
    return 0.0

def compute_hybrid_score(v_sim: float, t_sim: float, w_sim: float, r_sim: float, kw_sim: float, tag_sim: float) -> float:
    return (HYBRID_PARAMS["beta"] * v_sim +
            HYBRID_PARAMS["alpha"] * t_sim +
            HYBRID_PARAMS["gamma"] * w_sim +
            0.1 * r_sim +
            kw_sim +
            tag_sim)

async def applyRetrievalTraceReinforcementToMemory(mid: str, current_salience: float) -> float:
    return min(1.0, current_salience + REINFORCEMENT["boost"])

async def propagateAssociativeReinforcementToLinkedNodes(mid: str, boost: float, waypoints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    results = []
    for w in waypoints:
        w_id = w["target_id"]
        weight = w["weight"]
        results.append({"node_id": w_id, "boost": boost * weight * 0.5})
    return results

async def calculateCrossSectorResonanceScore(m_sec: str, q_sec: str, fusion_score: float) -> float:
    # High resonance if query and memory sectors align
    if m_sec == q_sec:
        return fusion_score
    rel = SECTOR_RELATIONSHIPS.get(q_sec, {}).get(m_sec, 0.5)
    return fusion_score * rel

async def create_single_waypoint(src_id: str, src_vec: List[float], now: int, user_id: str = None):
    # Normalize tenant scope before searching and inserting
    normalized_user_id = user_id or "anonymous"

    # Find potential neighbors in semantic space
    res = await store.search(src_vec, "semantic", 5, {"user_id": normalized_user_id})
    for r in res:
        dst_id = r["id"]
        if dst_id == src_id:
            continue
        # Multi-tenancy guard: ensured by search filter and normalized user_id
        db.execute("INSERT INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                   (src_id, dst_id, normalized_user_id, r["similarity"], now, now))
    db.commit()

async def calc_multi_vec_fusion_score(mid: str, qe: Dict[str, List[float]], w: Dict[str, float], user_id: Optional[str] = None) -> float:
    # Multi-tenancy: getVectorsById now requires explicit user_id
    if not user_id:
        return 0.0

    vecs = await store.getVectorsById(mid, user_id)
    s = 0.0
    tot = 0.0

    wm = {
         "semantic": w.get("semantic_dimension_weight", 0),
         "emotional": w.get("emotional_dimension_weight", 0),
         "procedural": w.get("procedural_dimension_weight", 0),
         "episodic": w.get("temporal_dimension_weight", 0),
         "reflective": w.get("reflective_dimension_weight", 0),
    }

    for v in vecs:
        sec = v.sector
        if sec in qe and sec in wm:
            sim = cosine_similarity(qe[sec], v.vector)
            wt = wm[sec]
            s += sim * wt
            tot += wt

    return s / tot if tot > 0 else 0.0

async def add_hsg_memory(
    content: str,
    tags: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    user_id: Optional[str] = None,
    project_id: Optional[str] = None
) -> Dict[str, Any]:
    simhash = compute_simhash(content)
    existing = db.fetchone("SELECT * FROM memories WHERE simhash=?", (simhash,))
    if existing:
        now_ts = int(time.time() * 1000)
        boosted_sal = min(1.0, (existing["salience"] or 0) + 0.15)
        db.execute("UPDATE memories SET salience=?, last_seen_at=? WHERE id=?", (boosted_sal, now_ts, existing["id"]))
        db.commit()
        return {
            "id": existing["id"],
            "primary_sector": existing["primary_sector"],
            "sectors": [existing["primary_sector"]],
            "deduplicated": True
        }

    import uuid
    mid = str(uuid.uuid4())
    res = await hsg_store(mid, content, user_id, tags or "[]", metadata)
    res["deduplicated"] = False
    return res

async def hsg_store(mid: str, content: str, user_id: str = None, tags: str = "[]", metadata: Dict[str, Any] = None):
    now = int(time.time() * 1000)
    simhash = "0" # Stub

    if user_id:
        # Pre-seed user if not exists
        if not db.fetchone("SELECT 1 FROM users WHERE user_id=?", (user_id,)):
            db.execute("INSERT INTO users(user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)",
                       (user_id, "User profile initializing...", 0, now, now))
            db.commit()

    chunks = chunk_text(content)
    use_chunks = len(chunks) > 1
    cls = classify_content(content, metadata)
    all_secs = [cls["primary"]] + cls["additional"]
    try:
        max_seg_res = db.fetchone("SELECT coalesce(max(segment), 0) as max_seg FROM memories")
        cur_seg = max_seg_res["max_seg"]
        cnt_res = db.fetchone("SELECT count(*) as c FROM memories WHERE segment=?", (cur_seg,))
        if cnt_res and cnt_res["c"] >= env.seg_size:
            cur_seg += 1
            print(f"[HSG] Rotated to segment {cur_seg}")

        from .embed import extract_essence
        stored = extract_essence(content, cls["primary"], env.summary_max_length)
        sec_cfg = SECTOR_CONFIGS[cls["primary"]]
        init_sal = max(0.0, min(1.0, 0.4 + 0.1 * len(cls["additional"])))
        q.ins_mem(
            id=mid,
            user_id=user_id or "anonymous",
            segment=cur_seg,
            content=stored,
            simhash=simhash,
            primary_sector=cls["primary"],
            tags=tags,
            meta=json.dumps(metadata or {}),
            created_at=now,
            updated_at=now,
            last_seen_at=now,
            salience=init_sal,
            decay_lambda=sec_cfg["decay_lambda"],
            version=1,
            mean_dim=None,
            mean_vec=None,
            compressed_vec=None,
            feedback_score=0
        )
        emb_res = await embed_multi_sector(mid, content, all_secs, chunks if use_chunks else None)
        for r in emb_res:
             await store.storeVector(mid, r["sector"], r["vector"], r["dim"], user_id or "anonymous")

        from .embed import calc_mean_vec
        mean_vec = calc_mean_vec(emb_res, all_secs)
        from ..utils.vectors import vec_to_buf
        mean_buf = vec_to_buf(mean_vec)
        db.execute("UPDATE memories SET mean_dim=?, mean_vec=? WHERE id=?", (len(mean_vec), mean_buf, mid))

        # Store the mean vector into the vector store as `_mean` sector to enable ANN search (Issue #141)
        await store.storeVector(mid, "_mean", mean_vec, len(mean_vec), user_id or "anonymous")

        if len(mean_vec) > 128:
            from .embed import compress_vec_for_storage
            comp = compress_vec_for_storage(mean_vec, 128)
            db.execute("UPDATE memories SET compressed_vec=? WHERE id=?", (vec_to_buf(comp), mid))

        await create_single_waypoint(mid, mean_vec, now, user_id)
        if user_id:
            await update_user_summary(user_id)
        return {
            "id": mid,
            "content": content,
            "primary_sector": cls["primary"],
            "sectors": all_secs,
            "chunks": len(chunks),
            "salience": init_sal
        }
    except Exception as e:
        raise e

cache = {}
TTL = 60000

def clear_cache(user_id: str = None):
    if user_id is None:
        cache.clear()
    else:
        keys_to_delete = []
        for k in cache.keys():
            try:
                import re
                match = re.search(r':\d+:({.*}|null)$', k)
                if match:
                    f = json.loads(match.group(1))
                    if f and isinstance(f, dict) and f.get("user_id") == user_id:
                        keys_to_delete.append(k)
            except:
                pass
        for k in keys_to_delete:
            del cache[k]

async def expand_via_waypoints(ids: List[str], max_exp: int = 10):
    exp = []
    vis = set(ids)
    q_arr = [{"id": i, "weight": 1.0, "path": [i]} for i in ids]
    cnt = 0

    while q_arr and cnt < max_exp:
        cur = q_arr.pop(0)
        neighs = db.fetchall("SELECT dst_id, weight FROM waypoints WHERE src_id=? ORDER BY weight DESC", (cur["id"],))
        for n in neighs:
            dst = n["dst_id"]
            if dst in vis:
                continue
            wt = min(1.0, max(0.0, float(n["weight"])))
            exp_wt = cur["weight"] * wt * 0.8
            if exp_wt < 0.1:
                continue

            item = {"id": dst, "weight": exp_wt, "path": cur["path"] + [dst]}
            exp.append(item)
            vis.add(dst)
            q_arr.append(item)
            cnt += 1
    return exp

async def hsg_query(qt: str, k: int = 10, f: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    from .decay import inc_q, dec_q
    start_q = time.time()
    inc_q()
    try:
        # Normalize filter argument to ensure safe access
        f = f or {}

        cache_key = f"{qt}:{k}:{json.dumps(f)}"
        if cache_key in cache:
            entry = cache[cache_key]
            if time.time()*1000 - entry["t"] < TTL:
                return entry["r"]

        qc = classify_content(qt)
        qtk = canonical_token_set(qt)

        ss = f.get("sectors") or list(SECTOR_CONFIGS.keys())
        if not ss:
            ss = ["semantic"]

        qe = await embed_query_for_all_sectors(qt, ss)

        w = {
            "semantic_dimension_weight": 1.2 if qc["primary"] == "semantic" else 0.8,
            "emotional_dimension_weight": 1.5 if qc["primary"] == "emotional" else 0.6,
            "procedural_dimension_weight": 1.3 if qc["primary"] == "procedural" else 0.7,
            "temporal_dimension_weight": 1.4 if qc["primary"] == "episodic" else 0.7,
            "reflective_dimension_weight": 1.1 if qc["primary"] == "reflective" else 0.5,
        }
        sr = {}
        for s in ss:
            qv = qe[s]
            res = await store.search(qv, s, k*3, {"user_id": f.get("user_id")})
            sr[s] = res

        all_sims = []
        ids = set()
        for s, res in sr.items():
            for r in res:
                all_sims.append(r["similarity"])
                ids.add(r["id"])

        avg_top = sum(all_sims)/len(all_sims) if all_sims else 0
        adapt_exp = math.ceil(0.3 * k * (1 - avg_top))
        eff_k = k + adapt_exp
        high_conf = avg_top >= 0.55

        exp = []
        if not high_conf:
            exp = await expand_via_waypoints(list(ids), k*2)
            for e in exp:
                ids.add(e["id"])

        res_list = []
        kw_scores = {}
        for mid in ids:
            mem = q.get_mem(mid)
            if mem:
                overlap = compute_keyword_overlap(qt, mem["content"])
                kw_scores[mid] = overlap * 0.15

        for mid in ids:
            m = q.get_mem(mid)
            if not m:
                continue
            if f and f.get("minSalience") and m["salience"] < f["minSalience"]:
                continue
            if f and f.get("user_id") and m["user_id"] != f["user_id"]:
                continue

            mvf = await calc_multi_vec_fusion_score(mid, qe, w, m["user_id"])
            csr = await calculateCrossSectorResonanceScore(m["primary_sector"], qc["primary"], mvf)

            best_sim = csr
            for s, rlist in sr.items():
                 for r in rlist:
                     if r["id"] == mid and r["similarity"] > best_sim:
                         best_sim = r["similarity"]
            mem_sec = m["primary_sector"]
            q_sec = qc["primary"]
            penalty = 1.0
            if mem_sec != q_sec:
                penalty = SECTOR_RELATIONSHIPS.get(q_sec, {}).get(mem_sec, 0.3)

            adj = best_sim * penalty

            em = next((e for e in exp if e["id"] == mid), None)
            ww = min(1.0, max(0.0, em["weight"] if em else 0.0))

            days = (time.time()*1000 - m["last_seen_at"]) / 86400000.0
            sal = calc_decay(m["primary_sector"], m["salience"], days)
            mtk = canonical_token_set(m["content"])
            tok_ov = compute_token_overlap(qtk, mtk)
            rec_sc = calc_recency_score_decay(m["last_seen_at"])
            tag_Match = await compute_tag_match_score(mid, qtk)

            fs = compute_hybrid_score(adj, tok_ov, ww, rec_sc, kw_scores.get(mid, 0), tag_Match)

            item = {
                "id": mid,
                "content": m["content"],
                "score": fs,
                "primary_sector": m["primary_sector"],
                "path": em["path"] if em else [mid],
                "salience": sal,
                "last_seen_at": m["last_seen_at"],
                "tags": json.loads(m["tags"] or "[]"),
                "metadata": json.loads(m["meta"] or "{}"),
                "user_id": m["user_id"]
            }

            if f and f.get("debug"):
                item["_debug"] = {
                    "sim_adj": adj,
                    "tok_ov": tok_ov,
                    "recency": rec_sc,
                    "waypoint": ww,
                    "tag": tag_Match,
                    "penalty": penalty
                }

            res_list.append(item)

        res_list.sort(key=lambda x: x["score"], reverse=True)
        top = res_list[:k]
        for r in top:
             rsal = await applyRetrievalTraceReinforcementToMemory(r["id"], r["salience"])
             now = int(time.time()*1000)
             db.execute("UPDATE memories SET salience=?, last_seen_at=? WHERE id=?", (rsal, now, r["id"]))
             if len(r["path"]) > 1:
                 wps_rows = db.fetchall("SELECT dst_id, weight FROM waypoints WHERE src_id=?", (r["id"],))
                 wps = [{"target_id": row["dst_id"], "weight": row["weight"]} for row in wps_rows]

                 pru = await propagateAssociativeReinforcementToLinkedNodes(r["id"], rsal, wps)
                 for u in pru:
                     linked_mem = q.get_mem(u["node_id"])
                     if linked_mem:
                         time_diff = (now - linked_mem["last_seen_at"]) / 86400000.0
                         decay_fact = math.exp(-0.02 * time_diff)
                         ctx_boost = HYBRID_PARAMS["gamma"] * (rsal - (linked_mem["salience"] or 0)) * decay_fact
                         new_sal = max(0.0, min(1.0, (linked_mem["salience"] or 0) + ctx_boost))
                         db.execute("UPDATE memories SET salience=?, last_seen_at=? WHERE id=?", (new_sal, now, u["node_id"]))

             from .decay import on_query_hit
             await on_query_hit(r["id"], r["primary_sector"], lambda t: embed_for_sector(t, r["primary_sector"]))

        cache[cache_key] = {"r": top, "t": time.time()*1000}
        return top

    finally:
        dec_q()
