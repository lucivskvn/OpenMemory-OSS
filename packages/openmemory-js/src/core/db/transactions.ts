/**
 * @file Database Transactions
 * Transaction management and coordination.
 * Extracted from db_access.ts for better memory management.
 */
import { 
    waitReady, 
    getIsPg, 
    get_sq_db, 
    txStorage, 
    pg,
    getContextId,
    get_tx_lock
} from "./connection";

export const transaction = {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
        await waitReady();
        const cid = getContextId();
        const store = txStorage.getStore();

        if (store) return await fn(); // Nested tx flattening

        let release: (() => void) | undefined;

        // Only lock for SQLite (single-writer constraint)
        // Postgres manages its own concurrency via MVCC and row-level locks
        if (!getIsPg()) {
            const cid = getContextId();

            // Queue Pattern: Append our "myLock" promise to the end of the chain.
            // We start when the *previous* promise resolves.
            // We resolve "myLock" (unlocking the NEXT guy) when our work is done (in finally).

            const previousLock = get_tx_lock();

            let unlockFn: () => void;
            const myLock = new Promise<void>((resolve) => { unlockFn = resolve; });

            // Handle previous failures gracefully so the chain doesn't perpetually break
            const safePrevious = previousLock.catch(() => { });

            // Append to chain
            const tx_locks = new Map<string, Promise<void>>();
            tx_locks.set(cid, safePrevious.then(() => myLock));

            // Wait for our turn
            await safePrevious;

            release = unlockFn!;
        }

        try {
            return await txStorage.run({ depth: 1 }, async () => {
                if (getIsPg()) {
                    const client = await pg!.connect();
                    txStorage.getStore()!.cli = client as any;
                    try {
                        await client.query("BEGIN");
                        const res = await fn();
                        await client.query("COMMIT");
                        return res;
                    } catch (e) {
                        try { await client.query("ROLLBACK"); } catch { }
                        throw e;
                    } finally {
                        client.release();
                    }
                } else {
                    const db = await get_sq_db();
                    db.exec("BEGIN IMMEDIATE");
                    try {
                        const res = await fn();
                        db.exec("COMMIT");
                        return res;
                    } catch (e) {
                        try { db.exec("ROLLBACK"); } catch { }
                        throw e;
                    }
                }
            });
        } finally {
            if (release) release();
        }
    }
};