import { q } from "../src/core/db";

const run = async () => {
  try {
    console.log('[DBG] start');
    const userA = 'dbg_user_a_' + Date.now();
    const userB = 'dbg_user_b_' + Date.now();
    const a1 = 'a1_' + Date.now();
    const a2 = 'a2_' + Date.now();
    const b1 = 'b1_' + Date.now();

    console.log('[DBG] inserting mem a1');
    await q.ins_mem.run(a1, userA, 0, "A1", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
    console.log('[DBG] inserted mem a1');

    console.log('[DBG] inserting mem a2');
    await q.ins_mem.run(a2, userA, 0, "A2", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
    console.log('[DBG] inserted mem a2');

    console.log('[DBG] inserting mem b1');
    await q.ins_mem.run(b1, userB, 0, "B1", null, "semantic", null, null, Date.now(), Date.now(), Date.now(), 0.5, 0.0, 1, null, null, null, 0);
    console.log('[DBG] inserted mem b1');

    console.log('[DBG] inserting waypoint a1->a2');
    await q.ins_waypoint.run(a1, a2, userA, 0.8, Date.now(), Date.now());
    console.log('[DBG] inserted waypoint a1->a2');

    console.log('[DBG] inserting waypoint a1->b1 for userB');
    await q.ins_waypoint.run(a1, b1, userB, 0.9, Date.now(), Date.now());
    console.log('[DBG] inserted waypoint a1->b1');

    console.log('[DBG] getting neighbors as userA');
    const neighA = await q.get_neighbors.all(a1, userA);
    console.log('[DBG] neighA', neighA);

    console.log('[DBG] getting neighbors as userB');
    const neighB = await q.get_neighbors.all(a1, userB);
    console.log('[DBG] neighB', neighB);

    console.log('[DBG] done');
  } catch (e) {
    console.error('[DBG] error', e);
    process.exit(1);
  }
};

run();
