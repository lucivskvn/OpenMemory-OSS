import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { LearnedClassifier, ClassifierModel } from "../../src/core/learned_classifier";
import { q, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { env } from "../../src/core/cfg";
import path from "node:path";

// Mock environment
const DB_FILE = path.resolve(process.cwd(), "data", "test_classifier.sqlite");
process.env.OM_DB_PATH = DB_FILE;
process.env.OM_VERBOSE = "true";
env.dbPath = DB_FILE;
env.verbose = true;

describe("Learned Classifier Deep Dive", () => {

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        await closeDb();
        // Create clean DB tables
        const { get_sq_db } = await import("../../src/core/db");
        // Implicitly created by get_sq_db + migrate check if needed?
        // Actually, we need to run migrations or rely on auto-creation in `db.ts`?
        // `db.ts` creates tables via `createTables` function? No, `migrate.ts` does.
        // `Memory` class usually handles it?
        // Let's manually run basic table creation for learned_models if it doesn't exist.
        // Or cleaner: Use Memory.wipe() which clears tables (assuming they exist)
        // But we need to ensure they exist. Using `src/core/migrate` logic is best but complex.
        // Let's rely on `q` running successfully if tables exist.
        // To be safe, let's use `Memory` interaction to trigger any setup.
        const { Memory } = await import("../../src/core/memory");
        (globalThis as any).fetch = mock(async () => new Response("ok"));
        const mem = new Memory();
        await mem.deleteAll();
    });

    afterAll(async () => {
        await closeDb();
    });

    // Mock data
    const mockDataA = [
        { vector: [1, 0, 0], label: "tech" },
        { vector: [0, 1, 0], label: "health" },
        { vector: [0, 0, 1], label: "finance" },
    ];

    const mockDataB = [
        { vector: [1, 1, 0], label: "science" },
    ];

    const mockDataC = [
        { vector: [0, 2, 2], label: "sports" },
        { vector: [0, 2, 2], label: "sports" },
        { vector: [0, 2, 2], label: "sports" },
    ];

    // Mock vectors for prediction
    const vectorA = [1, 0, 0];
    const vectorB = [0, 0, 1];
    const vectorC = [0, 2, 2]; // Stronger signal overlapping with finance but distinct enough if trained well

    test("should train a simple model from scratch", async () => {
        const model = await LearnedClassifier.train(mockDataA, undefined, 0.1, 50);
        expect(model).toBeDefined();
        expect(model.version).toBe(1);
        expect(model.weights["tech"]).toBeDefined();
        expect(model.weights["finance"]).toBeDefined();
        expect(model.weights["health"]).toBeDefined();

        // Predict
        const p1 = LearnedClassifier.predict(vectorA, model);
        expect(p1.primary).toBe("tech");

        const p2 = LearnedClassifier.predict(vectorB, model);
        expect(p2.primary).toBe("finance");
    });

    test("should incrementally update model", async () => {
        // Initial
        let model = await LearnedClassifier.train(mockDataA, undefined, 0.1, 20);
        const v1 = model.version;

        // Update with more data
        // Increase epochs to ensure new pattern is learned strongly
        model = await LearnedClassifier.train(mockDataC, model, 0.5, 1000);

        expect(model.version).toBeGreaterThan(v1);
        expect(model.weights["sports"]).toBeDefined(); // New sector added
        expect(model.biases["sports"]).toBeDefined();
        expect(model.version).toBe(2);

        // Verification
        const p3 = LearnedClassifier.predict(vectorC, model);
        expect(p3.primary).toBe("sports");
    });

    test("should persist and load model for specific user", async () => {
        // Train and save (implicit via train? No, train returns object. Need to save?)
        // Ah, `train` does NOT save to DB in the class definition I saw. 
        // We need to implement save or check if it's handled.
        // Looking at `learned_classifier.ts`, `train` returns `ClassifierModel`.
        // It does NOT save.
        // But `load` reads from DB.
        // So we must manually save the model to DB for this test to pass "load".
        // Or using `get_sq_db` to fake it?
        // Let's see `db.ts` for strictly typed queries. `q.insClassifierModel`? No, `db.ts` lines 391+ showed `getClassifierModel` but I missed `ins`.

        // Wait, the test tries to load. If we haven't saved, it fails.
        // We need to insert the model into DB.
        // Let's assume we fix `train` calls first.

        const USER_ID = "classifier_user_1";
        let model = await LearnedClassifier.train(mockDataA, undefined, 0.1, 20);
        model.userId = USER_ID;

        // Manually insert into DB using stricter `q` if available
        // Or if not available, we need to add it or use raw query.
        // `classifier.test.ts` attempted to import `get_sq_db` which failed.
        // We should use `runAsync` from `db`.

        const { runAsync, TABLES } = await import("../../src/core/db");
        // Need to serialize weights/biases
        await runAsync(`INSERT OR REPLACE INTO ${TABLES.learned_models} (user_id, weights, biases, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [USER_ID, JSON.stringify(model.weights), JSON.stringify(model.biases), model.version, Date.now()]);

        const loaded = await LearnedClassifier.load(USER_ID);
        expect(loaded).toBeDefined();
        expect(loaded?.userId).toBe(USER_ID);
        expect(loaded?.weights["tech"]).toBeDefined();
        expect(loaded?.biases["tech"]).toBeDefined();
        expect(loaded?.version).toBe(1);
    });

    test("should respect userId isolation (no cross-contamination)", async () => {
        const USER_1 = "user_iso_1";
        const USER_2 = "user_iso_2";

        // Train for User 1
        let model1 = await LearnedClassifier.train(mockDataA, undefined, 0.1, 20);
        model1.userId = USER_1;

        const { runAsync, TABLES } = await import("../../src/core/db");
        await runAsync(`INSERT OR REPLACE INTO ${TABLES.learned_models} (user_id, weights, biases, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [USER_1, JSON.stringify(model1.weights), JSON.stringify(model1.biases), model1.version, Date.now()]);

        // Train for User 2 (different data)
        let model2 = await LearnedClassifier.train(mockDataB, undefined, 0.1, 20);
        model2.userId = USER_2;
        await runAsync(`INSERT OR REPLACE INTO ${TABLES.learned_models} (user_id, weights, biases, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [USER_2, JSON.stringify(model2.weights), JSON.stringify(model2.biases), model2.version, Date.now()]);

        // Verify Load
        const loaded1 = await LearnedClassifier.load(USER_1);
        const loaded2 = await LearnedClassifier.load(USER_2);

        expect(loaded1).not.toBeNull();
        expect(loaded2).not.toBeNull();

        // User 1 should predict "tech" for [1,0,0]
        const p1 = LearnedClassifier.predict([1, 0, 0], loaded1!);
        expect(p1.primary).toBe("tech");

        // User 2 should predict "science" (or random if unseen, but definitely has 'science' weight)
        // User 2 only knows "science".
        const p2 = LearnedClassifier.predict([1, 0, 0], loaded2!);
        // Since [1,0,0] is close to [1,1,0], it might predict science.
        // But definitely should NOT contain "tech" key in weights if it initialized from scratch.
        expect(Object.keys(loaded2!.weights)).not.toContain("tech");
        expect(Object.keys(loaded2!.weights)).toContain("science");
    });
});
