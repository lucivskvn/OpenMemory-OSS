
import { vectorStore, closeDb, waitForDb, getContextId } from "./packages/openmemory-js/src/core/db";
import { reloadConfig } from "./packages/openmemory-js/src/core/cfg";
import { getUniqueDbPath } from "./packages/openmemory-js/test/test_utils";

async function debug() {
    const DB_PATH = getUniqueDbPath("debug_vector");
    process.env.OM_DB_PATH = DB_PATH;
    process.env.OM_METADATA_BACKEND = "sqlite";

    await closeDb();
    reloadConfig();
    await waitForDb();

    const userId = "debug-user";
    const testId = "debug-v-1";
    const vec = new Array(768).fill(0.5);

    console.log("Storing vector with userId:", userId);
    await vectorStore.storeVector(testId, "episodic", vec, 768, userId, { debug: true });

    const { allAsync } = await import("./packages/openmemory-js/src/core/db_access");
    const rawRows = await allAsync("SELECT * FROM vectors", []);
    console.log("Raw DB Row:", JSON.stringify(rawRows[0], null, 2));

    console.log("Querying with user_id=?", [userId]);
    const filteredRows = await allAsync("SELECT * FROM vectors WHERE user_id=?", [userId]);
    console.log("Filtered Results:", filteredRows.length);

    console.log("Querying with userId=?", [userId]);
    const filteredRows2 = await allAsync("SELECT * FROM vectors WHERE user_id=?", [userId]);
    console.log("Filtered Results (camelCase):", filteredRows2.length);

    await closeDb();
}

debug().catch(console.error);
