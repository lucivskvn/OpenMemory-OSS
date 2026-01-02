import time
import math
import asyncio
import json
import re
import random
import numpy as np
import uuid
import logging
from typing import List, Dict, Any, Optional, Set, Tuple
from ..core.types import MemoryItem

logger = logging.getLogger("openmemory.memory.hsg")

from ..core.db import q, db, transaction
from ..core.config import env
from ..core.constants import SECTOR_CONFIGS
from ..core.vector_store import vector_store as store
from ..utils.text import canonical_token_set, canonical_tokens_from_text
from ..utils.chunking import chunk_text
from ..utils.keyword import keyword_filter_memories, compute_keyword_overlap
from .embed import embed_multi_sector, embed_for_sector, calc_mean_vec 
from .decay import inc_q, dec_q, on_query_hit, calc_recency_score as calc_recency_score_decay, pick_tier
from ..utils.vectors import buf_to_vec, vec_to_buf, cos_sim, compress_vec_for_storage
# In backend/src/memory/hsg.ts line 275: export function calc_recency_score.
# I should put it here.
from ..core.learned_classifier import LearnedClassifier
from ..ops.dynamics import (
    calculateCrossSectorResonanceScore,
    applyRetrievalTraceReinforcementToMemory,
    propagateAssociativeReinforcementToLinkedNodes,
    SCORING_WEIGHTS,
    HYBRID_PARAMS,
    REINFORCEMENT,
    SECTOR_RELATIONSHIPS
)
from .user_summary import update_user_summary
from ..temporal_graph.query import query_facts_at_time

from ..core.security import get_encryption

async def embed_query_for_all_sectors(query: str, sectors: List[str]) -> Dict[str, List[float]]:
    # port of embedQueryForAllSectors
    # simplistic: sequential loop if batch not supported by embed implementation
    res = {}
    # embed.py's embed_dispatch handles batching if simple mode? 
    # For now loop. 1:1 logic from embed.ts shows optimizations but I need to call `embed_for_sector`.
    for s in sectors:
        res[s] = await embed_for_sector(query, s)
    return res

def has_temporal_markers(text: str) -> bool:
    pats = [
        r"\b(today|yesterday|tomorrow|this\s+week|last\s+week|this\s+morning)\b",
        r"\b\d{4}-\d{2}-\d{2}\b",
        r"\b20\d{2}[/-]?(0[1-9]|1[0-2])[/-]?(0[1-9]|[12]\d|3[01])\b",
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}",
        r"\bwhat\s+(did|have)\s+(i|we)\s+(do|done)\b",
    ]
    return any(re.search(p, text, re.I) for p in pats)

async def compute_tag_match_score(mid: str, q_toks: Set[str], user_id: Optional[str] = None) -> float:
    mem = await q.get_mem(mid)
    if not mem or not mem["tags"]: return 0.0
    if user_id and mem["user_id"] != user_id: return 0.0
    try:
        tags = json.loads(mem["tags"])
        if not isinstance(tags, list): return 0.0
        matches = 0
        for tag in tags:
            tl = str(tag).lower()
            if tl in q_toks: matches += 2
            else:
                for tok in q_toks:
                    if tl in tok or tok in tl: matches += 1
        return min(1.0, matches / max(1, len(tags) * 2))
    except:
        return 0.0


def classify_content(content: str, metadata: Any = None) -> Dict[str, Any]:
    # return {primary, additional, confidence}
    meta_sec = metadata.get("sector") if isinstance(metadata, dict) else None
    if meta_sec and meta_sec in SECTOR_CONFIGS:
        return {"primary": meta_sec, "additional": [], "confidence": 1.0}
        
    scores = {k: 0.0 for k in SECTOR_CONFIGS}
    for sec, cfg in SECTOR_CONFIGS.items():
        score = 0
        for pat in cfg["patterns"]:
            matches = pat.findall(content)
            if matches:
                score += len(matches) * cfg["weight"]
        scores[sec] = score
        
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    primary, p_score = sorted_scores[0]
    thresh = max(1.0, p_score * 0.3)
    
    additional = [s for s, sc in sorted_scores[1:] if sc > 0 and sc >= thresh]
    
    second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else 0
    confidence = min(1.0, p_score / (p_score + second_score + 1)) if p_score > 0 else 0.2
    
    return {
        "primary": primary if p_score > 0 else "semantic", # default semantic
        "additional": additional,
        "confidence": confidence
    }

def calc_decay(sec: str, init_sal: float, days_since: float, seg_idx: Optional[int] = None, max_seg: Optional[int] = None) -> float:
    cfg = SECTOR_CONFIGS.get(sec)
    if not cfg: return init_sal
    lam = cfg["decay_lambda"]
    if seg_idx is not None and max_seg is not None and max_seg > 0:
        seg_ratio = math.sqrt(seg_idx / max_seg)
        lam = lam * (1.0 - seg_ratio)
        
    decayed = init_sal * math.exp(-lam * days_since)
    reinf = HYBRID_PARAMS["alpha_reinforce"] * (1 - math.exp(-lam * days_since))
    return max(0.0, min(1.0, decayed + reinf))


def boosted_sim(s: float) -> float:
    return 1 - math.exp(-HYBRID_PARAMS["tau"] * s)

def compute_simhash(text: str) -> str:
    tokens = canonical_token_set(text)
    hashes = []
    for t in tokens:
        h = 0
        for c in t:
            # (h<<5) - h + ord(c) | 0 in JS
            val = (h << 5) - h + ord(c)
            # Enforce 32-bit signed behavior
            val = val & 0xffffffff
            if val > 0x7fffffff:
                val -= 0x100000000
            h = val
        hashes.append(h)
        
    vec = [0] * 64
    for h in hashes:
        for i in range(64):
            # JS line 309: if (h & (1 << i)). 
            # In JS, 1 << i wraps the shift amount to i % 32.
            # So bit 0 of h is checked for i=0 and i=32.
            bit = 1 << (i % 32)
            if h & bit:
                vec[i] += 1
            else:
                vec[i] -= 1
            
    res_hash = ""
    for i in range(0, 64, 4):
        nibble = 0
        if vec[i] > 0: nibble += 8
        if vec[i+1] > 0: nibble += 4
        if vec[i+2] > 0: nibble += 2
        if vec[i+3] > 0: nibble += 1
        res_hash += format(nibble, 'x')
    return res_hash

def hamming_dist(h1: str, h2: str) -> int:
    dist = 0
    for i in range(len(h1)):
        x = int(h1[i], 16) ^ int(h2[i], 16)
        if x & 8: dist += 1
        if x & 4: dist += 1
        if x & 2: dist += 1
        if x & 1: dist += 1
    return dist

def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))

def extract_essence(raw: str, sec: str, max_len: int) -> str:
    if not env.use_summary_only or len(raw) <= max_len: return raw
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", raw) if len(s.strip()) > 10]
    if not sents: return raw[:max_len]
    
    scored = []
    for idx, s in enumerate(sents):
        sc = 0
        if idx == 0: sc += 10
        if idx == 1: sc += 5
        if re.match(r"^#+\s", s) or re.match(r"^[A-Z][A-Z\s]+:", s): sc += 8
        if re.match(r"^[A-Z][a-z]+:", s): sc += 6
        if re.search(r"\d{4}-\d{2}-\d{2}", s): sc += 7
        if re.search(r"\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+", s, re.I): sc += 5
        if re.search(r"\$\d+|\d+\s*(miles|dollars|years|months|km)", s): sc += 4
        if re.search(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+", s): sc += 3
        if re.search(r"\b(bought|purchased|serviced|visited|went|got|received|paid|earned|learned|discovered|found|saw|met|completed|finished|fixed|implemented|created|updated|added|removed|resolved)\b", s, re.I): sc += 4
        if re.search(r"\b(who|what|when|where|why|how)\b", s, re.I): sc += 2
        if len(s) < 80: sc += 2
        if re.search(r"\b(I|my|me)\b", s): sc += 1
        scored.append({"text": s, "score": sc, "idx": idx})
        
    scored.sort(key=lambda x: x["score"], reverse=True)
    
    selected = []
    curr_len = 0
    
    # Always first
    first = next((x for x in scored if x["idx"] == 0), None)
    if first and len(first["text"]) < max_len:
        selected.append(first)
        curr_len += len(first["text"])
        
    for item in scored:
        if item["idx"] == 0: continue
        if curr_len + len(item["text"]) + 2 <= max_len:
            selected.append(item)
            curr_len += len(item["text"]) + 2
            
    selected.sort(key=lambda x: x["idx"])
    return " ".join(x["text"] for x in selected)

def compute_token_overlap(q_toks: Set[str], mem_toks: Set[str]) -> float:
    if not q_toks: return 0.0
    ov = len(q_toks.intersection(mem_toks))
    return ov / len(q_toks)

def generate_trace(metrics: Dict[str, Any], primary_sector: str) -> str:
    """Generates a human-readable justification for recall."""
    just = f"Recalled via {primary_sector} resonance"
    if metrics.get("sim_adj", 0) > 0.6:
        just += f" (high semantic similarity: {metrics['sim_adj']:.2f})"
    elif metrics.get("tok_ov", 0) > 0.4:
        just += f" (strong keyword overlap: {metrics['tok_ov']:.2f})"
        
    if metrics.get("waypoint", 0) > 0.2:
        just += f", linked via associative waypoint ({metrics['waypoint']:.2f})"
    
    if metrics.get("recency", 0) > 0.8:
        just += ", reinforced by recent interaction"
    elif metrics.get("recency", 0) < 0.2:
        just += ", retrieved from long-term memory"
        
    if metrics.get("tag", 0) > 0.5:
        just += " (matched user tags)"
        
    return just

def compute_hybrid_score(sim: float, tok_ov: float, ww: float, rec_sc: float, kw_score: float = 0, tag_match: float = 0) -> float:
    s_p = boosted_sim(sim)
    raw = (SCORING_WEIGHTS["similarity"] * s_p +
           SCORING_WEIGHTS["overlap"] * tok_ov +
           SCORING_WEIGHTS["waypoint"] * ww +
           SCORING_WEIGHTS["recency"] * rec_sc +
           SCORING_WEIGHTS["tag_match"] * tag_match +
           kw_score)
    return sigmoid(raw)

async def create_single_waypoint(new_id: str, new_mean: List[float], ts: int, user_id: str = "anonymous"):
    mems = await q.all_mem_by_user(user_id, 1000, 0) if user_id else await q.all_mem(1000, 0)
    best = None
    best_sim = -1.0
    
    nm = np.array(new_mean, dtype=np.float32)
    
    # Optimization: limit search for waypoints to recent or highly salient memories
    # to avoid O(N) growth in linkage time.
    for mem in mems[:250]: # only link to top 250 most recent/salient
        if mem["id"] == new_id or not mem["mean_vec"]: continue
        ex_mean = np.array(buf_to_vec(mem["mean_vec"]), dtype=np.float32)
        sim = cos_sim(nm, ex_mean)
        if sim > best_sim:
            best_sim = sim
            best = mem["id"]
            
    if best:
        await db.async_execute("INSERT OR REPLACE INTO waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, best, user_id, float(best_sim), ts, ts))
    else:
        await db.async_execute("INSERT OR REPLACE INTO waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, new_id, user_id, 1.0, ts, ts))


async def create_inter_mem_waypoints(new_id: str, prim_sec: str, new_vec: List[float], ts: int, user_id: str = "anonymous"):
    thresh = 0.75
    wt = 0.5
    # Simplistic fetch current sector vectors
    rows = await db.async_fetchall("SELECT id, v FROM vectors WHERE sector=?", (prim_sec,))
    nv = np.array(new_vec, dtype=np.float32)
    for r in rows:
        if r["id"] == new_id:
            continue
        ex_vec = np.array(buf_to_vec(r["v"]), dtype=np.float32)
        sim = cos_sim(nv, ex_vec)
        if sim >= thresh:
            await db.async_execute("INSERT OR REPLACE INTO waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (new_id, r["id"], user_id, wt, ts, ts))
            await db.async_execute("INSERT OR REPLACE INTO waypoints(src_id,dst_id,user_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?)", (r["id"], new_id, user_id, wt, ts, ts))


async def calc_multi_vec_fusion_score(mid: str, qe: Dict[str, List[float]], w: Dict[str, float]) -> float:
    vecs = await store.getVectorsById(mid)
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
        qv = qe.get(v.sector)
        if not qv: continue
        sim = cos_sim(v.vector, qv)
        wgt = wm.get(v.sector, 0.5)
        s += sim * wgt
        tot += wgt
        
    return s / tot if tot > 0 else 0.0

async def add_hsg_memory(content: str, tags: Optional[str] = None, metadata: Any = None, user_id: Optional[str] = None, commit: bool = True) -> Dict[str, Any]:
    if commit:
        await db.async_execute("BEGIN")
    
    try:
        simhash = compute_simhash(content)
        # Check for existing memory with similar simhash (Deduplication)
        # Matches JS hsg.ts line 1089
        if user_id:
             existing = await db.async_fetchone("SELECT * FROM memories WHERE simhash=? AND user_id=? ORDER BY salience DESC LIMIT 1", (simhash, user_id))
        else:
             existing = await db.async_fetchone("SELECT * FROM memories WHERE simhash=? AND (user_id IS NULL OR user_id='anonymous') ORDER BY salience DESC LIMIT 1", (simhash,))
        
        if existing and hamming_dist(simhash, existing["simhash"]) <= 3:
            now = int(time.time()*1000)
            boost = min(1.0, (existing["salience"] or 0) + 0.15)
            # Fast update for existing memory
            await db.async_execute("UPDATE memories SET last_seen_at=?, salience=?, updated_at=? WHERE id=?", (now, boost, now, existing["id"]))
            if commit: await db.async_commit()
            return {
                "id": existing["id"],
                "primary_sector": existing["primary_sector"],
                "sectors": [existing["primary_sector"]],
                "deduplicated": True
            }
            
        mid = str(uuid.uuid4())
        now_ts = int(time.time()*1000)
        
        # Classification and Chunking
        chunks = chunk_text(content)
        use_chunks = len(chunks) > 1
        
        # Allow metadata override for primary sector (useful for testing/forcing)
        forced_sector = (metadata or {}).get("primary_sector") or (metadata or {}).get("sector")
        cls = classify_content(content, metadata)
        if forced_sector in SECTOR_CONFIGS:
            cls["primary"] = forced_sector
            if forced_sector not in cls["additional"]:
                cls["additional"].append(forced_sector)
                
        all_secs = [cls["primary"]] + cls["additional"]
        
        # 1. Pre-calculate embeddings
        emb_res = await embed_multi_sector(mid, content, all_secs, chunks if use_chunks else None)
        mean_vec = calc_mean_vec(emb_res, all_secs)
        
        # 3. Learned Classifier Refinement
        if user_id:
            try:
                model_row = await q.get_classifier_model(user_id)
                if model_row:
                    model = {
                        "weights": json.loads(model_row["weights"]),
                        "biases": json.loads(model_row["biases"])
                    }
                    learned_cls = LearnedClassifier.predict(mean_vec, model)
                    if learned_cls["confidence"] > 0.4:
                        logger.info(f"[HSG] Learned Refinement: {cls['primary']} -> {learned_cls['primary']} (conf: {learned_cls['confidence']:.2f})")
                        
                        # If primary sector changed, we might need to re-embed if not already covered
                        if learned_cls["primary"] not in all_secs:
                            new_emb = await embed_for_sector(content, learned_cls["primary"])
                            emb_res.append({"sector": learned_cls["primary"], "vector": new_emb, "dim": len(new_emb)})
                            all_secs.append(learned_cls["primary"])
                            # Re-calculate mean_vec with new primary
                            mean_vec = calc_mean_vec(emb_res, [learned_cls["primary"]] + learned_cls["additional"])
                        
                        # Only apply learned refinement if NOT forced
                        if not forced_sector:
                            cls["primary"] = learned_cls["primary"]
                        cls["additional"] = list(set(cls["additional"] + learned_cls["additional"]))
            except Exception as e:
                logger.error(f"[HSG] Learned classifier refinement error: {e}")

        # Mean Vector Buffering
        mean_buf = vec_to_buf(mean_vec)
        comp_buf = None
        if env.tier == "smart" and len(mean_vec) > 128:
            comp = compress_vec_for_storage(mean_vec, 128)
            comp_buf = vec_to_buf(comp)
            
        # Ensure user exists for analytics/ownership
        if user_id:
            u = await db.async_fetchone("SELECT * FROM openmemory_users WHERE user_id=?", (user_id,))
            if not u:
                await db.async_execute("INSERT OR IGNORE INTO openmemory_users(user_id,summary,reflection_count,created_at,updated_at) VALUES (?,?,?,?,?)",
                           (user_id, "User profile initializing...", 0, now_ts, now_ts))
        
        # Segments logic
        max_seg_res = await db.async_fetchone("SELECT coalesce(max(segment), 0) as max_seg FROM memories")
        cur_seg = max_seg_res["max_seg"]
        cnt_res = await db.async_fetchone("SELECT count(*) as c FROM memories WHERE segment=?", (cur_seg,))
        if cnt_res and cnt_res["c"] >= env.seg_size:
            cur_seg += 1
            
        stored_content = extract_essence(content, cls["primary"], env.summary_max_length)
        stored_content_enc = get_encryption().encrypt(stored_content)
        
        sec_cfg = SECTOR_CONFIGS[cls["primary"]]
        init_sal = max(0.0, min(1.0, 0.4 + 0.1 * len(cls["additional"])))
        
        # Insert Memory Record
        await q.ins_mem(
            id=mid,
            user_id=user_id or "anonymous",
            segment=cur_seg,
            content=stored_content_enc,
            simhash=simhash,
            primary_sector=cls["primary"],
            tags=tags,
            meta=json.dumps(metadata or {}),
            created_at=now_ts,
            updated_at=now_ts,
            last_seen_at=now_ts,
            salience=init_sal,
            decay_lambda=sec_cfg["decay_lambda"],
            version=1,
            mean_dim=len(mean_vec),
            mean_vec=mean_buf,
            compressed_vec=comp_buf,
            feedback_score=0,
            commit=False
        )
        
        # Store Sector-specific Vectors
        for r in emb_res:
             await store.storeVector(mid, r["sector"], r["vector"], r["dim"], user_id or "anonymous")
             
        # Create Waypoints
        await create_single_waypoint(mid, mean_vec, now_ts, user_id or "anonymous")
        await create_inter_mem_waypoints(mid, cls["primary"], mean_vec, now_ts, user_id or "anonymous")
        
        # Final Commit
        if commit:
            await db.async_commit()
            
        # Post-commit: Trigger summary update
        if user_id:
            asyncio.create_task(update_user_summary(user_id))
            
        return {
            "id": mid,
            "content": content,
            "primary_sector": cls["primary"],
            "sectors": all_secs,
            "chunks": len(chunks),
            "salience": init_sal
        }
    except Exception as e:
        if commit:
            await db.async_rollback()
        raise e

# Cache for query
cache = {}
TTL = 60000

# Co-activation buffer for reinforcement
coact_buf: List[Tuple[Optional[str], str, str]] = []

async def _coactivation_worker():
    global coact_buf
    if not coact_buf:
        return
    
    pairs = coact_buf[:50]
    del coact_buf[:50]
    
    now = int(time.time() * 1000)
    tau_ms = HYBRID_PARAMS["tau_hours"] * 3600000
    
    for uid, a, b in pairs:
        try:
            memA = await q.get_mem(a)
            memB = await q.get_mem(b)
            if not memA or not memB:
                continue
            if memA["user_id"] != memB["user_id"]:
                continue
            if uid and (memA["user_id"] != uid or memB["user_id"] != uid):
                continue
            
            time_diff = abs(memA["last_seen_at"] - memB["last_seen_at"])
            temp_fact = math.exp(-time_diff / tau_ms)
            
            # Use raw SQL to handle OR REPLACE easily as in single_waypoint
            row = await db.async_fetchone("SELECT weight, created_at, user_id FROM waypoints WHERE src_id=? AND dst_id=?", (a, b))
            cur_wt = row["weight"] if row else 0.0
            new_wt = min(1.0, cur_wt + HYBRID_PARAMS["eta"] * (1.0 - cur_wt) * temp_fact)
            
            user_id = row["user_id"] if row else (memA["user_id"] or memB["user_id"] or "anonymous")
            created_at = row["created_at"] if row else now
            
            await db.async_execute("INSERT OR REPLACE INTO waypoints(src_id, dst_id, user_id, weight, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                       (a, b, user_id, new_wt, created_at, now))
        except Exception:
            pass
    await db.async_commit()

def trigger_coactivation_sync():
    asyncio.create_task(_coactivation_worker())

async def reinforce_waypoints(path: List[str], user_id: str = "anonymous"):
    now = int(time.time() * 1000)
    for i in range(len(path) - 1):
        src_id = path[i]
        dst_id = path[i+1]
        await db.async_execute("UPDATE waypoints SET weight=MIN(?, weight + ?), updated_at=? WHERE src_id=? AND dst_id=? AND (user_id=? OR (user_id IS NULL AND ? IS NULL))", 
                   (REINFORCEMENT["max_waypoint_weight"], REINFORCEMENT["waypoint_boost"], now, src_id, dst_id, user_id, user_id))

async def run_decay_process() -> Dict[str, int]:
    mems = await q.all_mem(10000, 0)
    p = 0
    d = 0
    now = int(time.time() * 1000)
    for m in mems:
        ds = (now - m["last_seen_at"]) / 86400000.0
        ns = calc_decay(m["primary_sector"], m["salience"], ds)
        if abs(ns - m["salience"]) > 0.0001:
            await db.async_execute("UPDATE memories SET salience=?, updated_at=? WHERE id=?", (ns, now, m["id"]))
            d += 1
        p += 1
    await db.async_commit()
    return {"processed": p, "decayed": d}

async def expand_via_waypoints(ids: List[str], max_exp: int = 10):
    exp = []
    vis = set(ids)
    q_arr = [{"id": i, "weight": 1.0, "path": [i]} for i in ids]
    cnt = 0
    
    while q_arr and cnt < max_exp:
        cur = q_arr.pop(0)
        # neighbors: dst_id, weight
        neighs = await db.async_fetchall("SELECT dst_id, weight FROM waypoints WHERE src_id=? ORDER BY weight DESC", (cur["id"],))
        for n in neighs:
            dst = n["dst_id"]
            if dst in vis: continue
            wt = min(1.0, max(0.0, float(n["weight"])))
            exp_wt = cur["weight"] * wt * 0.8
            if exp_wt < 0.1: continue
            
            item = {"id": dst, "weight": exp_wt, "path": cur["path"] + [dst]}
            exp.append(item)
            vis.add(dst)
            q_arr.append(item)
            cnt += 1
    return exp

async def hsg_query(qt: str, k: int = 10, f: Dict[str, Any] = None) -> List[MemoryItem]:
    # f: {sectors, minSalience, user_id, startTime, endTime}
    start_q = time.time()
    inc_q()
    try:
        f = f or {}
        cache_key = f"{qt}:{k}:{json.dumps(f)}"
        if cache_key in cache:
            entry = cache[cache_key]
            if time.time()*1000 - entry["t"] < TTL: return entry["r"]
            
        qc = classify_content(qt)
        qtk = canonical_token_set(qt)
        primary_sectors = [qc["primary"]] + qc["additional"]
        
        ss = f.get("sectors") or list(SECTOR_CONFIGS.keys())
        if not ss: ss = ["semantic"]
        
        qe = await embed_query_for_all_sectors(qt, ss)
        
        # Temporal Awareness
        if has_temporal_markers(qt):
            logger.info(f"[HSG] Temporal marker detected in query: {qt}")
            t_facts = await query_facts_at_time(user_id=f.get("user_id"), min_confidence=0.5)
            # In a more advanced version, we'd use these facts to re-rank or augment the query.
            # For now, we log the detection as a bridge achievement.
            
        # Refine using Learned Classifier
        if f.get("user_id"):
            try:
                model_row = await q.get_classifier_model(f["user_id"])
                if model_row:
                    model = {
                        "weights": json.loads(model_row["weights"]),
                        "biases": json.loads(model_row["biases"])
                    }
                    emb_res_for_mean = []
                    for sec, vec in qe.items():
                        emb_res_for_mean.append({"sector": sec, "vector": vec, "dim": len(vec)})
                        
                    q_mean = calc_mean_vec(emb_res_for_mean, ss)
                    learned_qc = LearnedClassifier.predict(q_mean, model)
                    
                    if learned_qc["confidence"] > 0.5:
                        logger.info(f"[HSG] Query refined for {f['user_id']}: {qc['primary']} -> {learned_qc['primary']}")
                        qc["primary"] = learned_qc["primary"]
                        # Extend additional sectors
                        qc["additional"] = list(set(qc["additional"] + learned_qc["additional"]))
            except Exception as e:
                pass
        
        w = {
            "semantic_dimension_weight": 1.2 if qc["primary"] == "semantic" else 0.8,
            "emotional_dimension_weight": 1.5 if qc["primary"] == "emotional" else 0.6,
            "procedural_dimension_weight": 1.3 if qc["primary"] == "procedural" else 0.7,
            "temporal_dimension_weight": 1.4 if qc["primary"] == "episodic" else 0.7,
            "reflective_dimension_weight": 1.1 if qc["primary"] == "reflective" else 0.5,
        }
        
        # Search vectors
        sr = {}
        for s in ss:
            qv = qe[s] # list[float]
            res = await store.search(qv, s, k*3, {"user_id": f.get("user_id")})
            sr[s] = [{"id": r["id"], "similarity": r["score"]} for r in res]
            
        all_sims = []
        for s, slist in sr.items():
            for x in slist[:8]:
                all_sims.append(x["similarity"])
                
        avg_top = sum(all_sims)/len(all_sims) if all_sims else 0
        adapt_exp = math.ceil(0.3 * k * (1 - avg_top))
        eff_k = k + adapt_exp
        high_conf = avg_top >= 0.55
        
        ids = set()
        for s, res in sr.items():
            for r in res: ids.add(r["id"])
            
        exp = []
        if not high_conf:
            exp = await expand_via_waypoints(list(ids), k*2)
            for e in exp: ids.add(e["id"])
            
        res_list = []
        kw_scores = {}
        # Simple keywords overlap matching JS tier logic (hybrid)
        if env.tier == "hybrid":
            for mid in ids:
                mem = await q.get_mem(mid)
                if mem:
                    overlap = compute_keyword_overlap(qt, mem["content"])
                    kw_scores[mid] = overlap * (env.keyword_boost or 0.15)
        
        # Bulk fetch memory rows for all candidates to avoid N+1 queries
        if not ids: return []
        
        placeholders = ",".join(["?"] * len(ids))
        m_rows = await db.async_fetchall(f"SELECT * FROM memories WHERE id IN ({placeholders})", tuple(ids))
        m_map = {m["id"]: m for m in m_rows}
        
        now_ts = int(time.time() * 1000)
        for mid in ids:
            m = m_map.get(mid)
            if not m: continue
            if f.get("minSalience") and m["salience"] < f["minSalience"]: continue
            if f.get("user_id") and m["user_id"] != f["user_id"]: continue
            if f.get("startTime") and m["created_at"] < f["startTime"]: continue
            if f.get("endTime") and m["created_at"] > f["endTime"]: continue
            
            mvf = await calc_multi_vec_fusion_score(mid, qe, w)
            csr = await calculateCrossSectorResonanceScore(m["primary_sector"], qc["primary"], mvf)
            
            best_sim = csr
            for s, rlist in sr.items():
                 for r in rlist:
                     if r["id"] == mid and r["similarity"] > best_sim: best_sim = r["similarity"]
                     
            # Penalty
            mem_sec = m["primary_sector"]
            q_sec = qc["primary"]
            penalty = 1.0
            # If not in query primary sectors list, apply relationship penalty
            if mem_sec != q_sec and mem_sec not in primary_sectors:
                penalty = SECTOR_RELATIONSHIPS.get(q_sec, {}).get(mem_sec, 0.3)
                
            adj = best_sim * penalty
            
            # Retrieve expansion data if available
            em = next((e for e in exp if e["id"] == mid), None)
            ww = min(1.0, max(0.0, em["weight"] if em else 0.0))
            path = em["path"] if em else [mid]
            
            ds = (now_ts - m["last_seen_at"]) / 86400000.0
            sal = calc_decay(m["primary_sector"], m["salience"], ds)
            mtk = canonical_token_set(m["content"])
            tok_ov = compute_token_overlap(qtk, mtk)
            rec_sc = calc_recency_score_decay(m["last_seen_at"])
            tag_match = await compute_tag_match_score(mid, qtk, f.get("user_id"))
            
            debug_obj = {
                "sim_adj": adj,
                "tok_ov": tok_ov,
                "recency": rec_sc,
                "waypoint": ww,
                "tag": tag_match,
                "penalty": penalty
            }
            
            # Populate trace
            trace_obj = {
                "justification": generate_trace(debug_obj, m["primary_sector"]),
                "metrics": debug_obj,
                "path": path
            }
            
            fs = compute_hybrid_score(adj, tok_ov, ww, rec_sc, kw_scores.get(mid, 0), tag_match)
            
            # Sector consistency fix: get all sectors for this memory
            # In a real implementation we'd join with vectors table, but for performance
            # we'll assume primary + potentially meta. If we had more info we'd list them.
            # For now, let's at least ensure it's a list.
            
            # Construct MemoryItem with path
            item = MemoryItem(
                id=mid,
                content=get_encryption().decrypt(m["content"]),
                score=fs,
                primary_sector=m["primary_sector"],
                sectors=list(set([m["primary_sector"]] + json.loads(m.get("meta", "{}")).get("additional_sectors", []))),
                salience=sal,
                created_at=m["created_at"],
                updated_at=m["updated_at"],
                last_seen_at=m["last_seen_at"],
                tags=json.loads(m["tags"] or "[]"),
                meta=json.loads(m["meta"] or "{}"),
                feedback_score=m["feedback_score"] or 0.0,
                trace=trace_obj
            )
            item.path = path # Attach path for reinforcement
            
            if f.get("debug"):
                item.debug = debug_obj
            
            res_list.append(item)
            
        res_list.sort(key=lambda x: x.score, reverse=True)
        top_cands = res_list[:eff_k]
        
        # Z-score normalization for results (matching JS line 915)
        if top_cands:
            scores = [r.score for r in top_cands]
            mean_sc = sum(scores) / len(scores)
            var = sum((s - mean_sc)**2 for s in scores) / len(scores)
            std = math.sqrt(var) + HYBRID_PARAMS["epsilon"]
            for r in top_cands:
                r.score = (r.score - mean_sc) / std
            top_cands.sort(key=lambda x: x.score, reverse=True)
            
        top = top_cands[:k]
        tids = [r.id for r in top]
        
        # Update feedback scores (EMA) and reinforcement
        for r in top:
             # EMA update for feedback_score - using cached value
             cur_fb = r.feedback_score
             new_fb = cur_fb * 0.9 + r.score * 0.1
             await db.async_execute("UPDATE memories SET feedback_score=? WHERE id=?", (new_fb, r.id))
             
             # Co-activation buffer
             uid = f.get("user_id") or "anonymous"
             for other_id in tids:
                 if r.id < other_id: # ensure unique pairs
                     coact_buf.append((uid, r.id, other_id))
             
             rsal = await applyRetrievalTraceReinforcementToMemory(r.id, r.salience)
             await db.async_execute("UPDATE memories SET salience=?, last_seen_at=?, updated_at=? WHERE id=?", (rsal, now_ts, now_ts, r.id))
             
             # Propagate to Linked Nodes
             if r.path and len(r.path) > 1:
                 user_id_context = f.get("user_id")
                 await reinforce_waypoints(r.path, user_id_context or "anonymous")
                 wps_rows = await db.async_fetchall("SELECT dst_id, weight FROM waypoints WHERE src_id=? AND (user_id=? OR (user_id IS NULL AND ? IS NULL))", (r.id, user_id_context, user_id_context))
                 wps = [{"target_id": row["dst_id"], "weight": row["weight"]} for row in wps_rows]
                 
                 pru = await propagateAssociativeReinforcementToLinkedNodes(r.id, rsal, wps, user_id_context)
                 if pru:
                     # Bulk fetch linked memories for decay-aware boost calculation
                     ln_ids = [u["node_id"] for u in pru]
                     placeholders = ",".join(["?"] * len(ln_ids))
                     ln_mems = await db.async_fetchall(f"SELECT id, salience, last_seen_at FROM memories WHERE id IN ({placeholders})", tuple(ln_ids))
                     ln_map = {m["id"]: m for m in ln_mems}
                     
                     for u in pru:
                         linked_mem = ln_map.get(u["node_id"])
                         if linked_mem:
                             time_diff = (now_ts - (linked_mem["last_seen_at"] or now_ts)) / 86400000.0
                             decay_fact = math.exp(-0.02 * time_diff)
                             ctx_boost = HYBRID_PARAMS["gamma"] * (rsal - r.salience) * decay_fact
                             new_sal = max(0.0, min(1.0, linked_mem["salience"] + ctx_boost))
                             await db.async_execute("UPDATE memories SET salience=?, last_seen_at=?, updated_at=? WHERE id=?", (new_sal, now_ts, now_ts, u["node_id"]))
                             
             await on_query_hit(r.id, r.primary_sector, lambda t: embed_for_sector(t, r.primary_sector))
             
        await db.async_commit()
        trigger_coactivation_sync() # trigger worker
        
        cache[cache_key] = {"r": top, "t": time.time()*1000}
        return top
        
    finally:
        dec_q()

async def reinforce_memory(mid: str, boost: float = 0.1) -> Dict[str, Any]:
    """Manually reinforce a memory's salience."""
    now = int(time.time() * 1000)
    await db.async_execute("BEGIN")
    try:
        mem = await q.get_mem(mid)
        if not mem:
             await db.async_rollback()
             return {"ok": False, "error": "Not Found"}
             
        new_sal = min(1.0, (mem["salience"] or 0) + boost)
        
        await db.async_execute("UPDATE memories SET salience=?, last_seen_at=?, updated_at=? WHERE id=?", 
                               (new_sal, now, now, mid))
                               
        # Trigger learning/decay update if applicable
        await on_query_hit(mid, mem["primary_sector"], lambda t: embed_for_sector(t, mem["primary_sector"]))
        
        await db.async_commit()
        return {"ok": True, "new_salience": new_sal}
    except Exception as e:
        await db.async_rollback()
        raise e
