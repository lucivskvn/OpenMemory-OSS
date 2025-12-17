## 2025-05-20 - [N+1 Query Elimination in HSG Query]
**Learning:** Found significant N+1 query pattern in `hsg_query` where memories are fetched one-by-one inside a loop after vector search. This scales linearly with `k` and is a major bottleneck.
**Action:** Implemented batch retrieval `get_mems_by_ids` in DB layer and updated `hsg.ts` to fetch all candidate memories in a single query.
