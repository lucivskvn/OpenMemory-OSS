import { run_async } from "../../src/core/db";

export const resetDb = async () => {
  try {
    await run_async("delete from memories", []);
    await run_async("delete from vectors", []);
    await run_async("delete from waypoints", []);
    await run_async("delete from users", []);
    await run_async("delete from stats", []);
    try { await run_async("VACUUM", []); } catch (e) {}
  } catch (e) {
    console.error('[TEST_HELPERS] resetDb failed', e);
    throw e;
  }
};
