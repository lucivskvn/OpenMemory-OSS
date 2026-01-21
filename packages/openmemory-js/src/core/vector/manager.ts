/**
 * @file Vector Store Manager
 * Handles initialization and access to the vector store backend (SQL or Valkey).
 * Decoupled from db.ts to prevent circular dependencies.
 */

import { env } from "../cfg";
import { runAsync, getAsync, allAsync, iterateAsync, transaction, TABLES, hasVector, getContextId } from "../db_access";
import { SqlVectorStore } from "./sql";
import { ValkeyVectorStore } from "./valkey";
import { VectorStore } from "../vector_store";

const vectorStores = new Map<string, VectorStore>();
const vectorStoreInitLocks = new Map<string, Promise<VectorStore>>();



/**
 * Retrieves the appropriate VectorStore implementation (SQL or Valkey) based on config.
 * @returns {VectorStore} The initialized vector store instance.
 */
export const getVectorStore = (): VectorStore => {
    const contextId = getContextId();
    let vs = vectorStores.get(contextId);
    if (vs) return vs;

    // Check if initialization is in progress
    let initPromise = vectorStoreInitLocks.get(contextId);
    if (initPromise) {
        return new Proxy({} as VectorStore, {
            get: (_target, prop) => {
                return async (...args: any[]) => {
                    const store = await initPromise!;
                    return (store as any)[prop](...args);
                };
            }
        });
    }

    // Start initialization
    initPromise = (async () => {
        try {
            let newVs: VectorStore;
            if (env.vectorBackend === "valkey") {
                newVs = new ValkeyVectorStore();
            } else {
                newVs = new SqlVectorStore(
                    {
                        runAsync,
                        getAsync,
                        allAsync,
                        transaction: transaction.run,
                        iterateAsync,
                    },
                    TABLES.vectors,
                );
            }
            vectorStores.set(contextId, newVs);
            return newVs;
        } finally {
            vectorStoreInitLocks.delete(contextId);
        }
    })();

    vectorStoreInitLocks.set(contextId, initPromise);

    return new Proxy({} as VectorStore, {
        get: (_target, prop) => {
            return async (...args: any[]) => {
                const store = await initPromise!;
                return (store as any)[prop](...args);
            };
        }
    });
};

export const vectorStore: VectorStore = {
    getVectorsById: (id, userId) => getVectorStore().getVectorsById(id, userId),
    getVectorsByIds: (ids, userId) =>
        getVectorStore().getVectorsByIds(ids, userId),
    getVector: (id, sector, userId) =>
        getVectorStore().getVector(id, sector, userId),
    searchSimilar: (sector, queryVec, topK, userId, filter) =>
        getVectorStore().searchSimilar(sector, queryVec, topK, userId, filter),
    storeVector: (id, sector, vec, dim, userId, metadata) =>
        getVectorStore().storeVector(id, sector, vec, dim, userId, metadata),
    storeVectors: (items, userId) =>
        getVectorStore().storeVectors(items, userId),
    deleteVector: (id, sector, userId) =>
        getVectorStore().deleteVector(id, sector, userId),
    deleteVectors: (ids, userId) => getVectorStore().deleteVectors(ids, userId),
    deleteVectorsByUser: (userId) => getVectorStore().deleteVectorsByUser(userId),
    getVectorsBySector: (sector, userId) =>
        getVectorStore().getVectorsBySector(sector, userId),
    getAllVectorIds: (userId) => getVectorStore().getAllVectorIds(userId),
    iterateVectorIds: async function* (userId) {
        const store = getVectorStore();
        // Handle both Proxy (Promise) and real instance
        const iterable = await store.iterateVectorIds(userId);
        for await (const id of iterable) {
            yield id;
        }
    },
    cleanupOrphanedVectors: (userId) => getVectorStore().cleanupOrphanedVectors(userId),
    disconnect: async () => {
        const vs = vectorStores.get(getContextId());
        if (vs) await vs.disconnect?.();
    },
};

export const cleanupVectorStores = async (cid: string) => {
    if (vectorStores.has(cid)) {
        await vectorStores.get(cid)!.disconnect?.();
        vectorStores.delete(cid);
    }
};
