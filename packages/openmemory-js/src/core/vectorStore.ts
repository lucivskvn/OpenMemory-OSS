/**
 * @file vectorStore.ts
 * @description Interface definition for vector storage backends.
 */

export interface VectorStore {
    storeVector(
        id: string,
        sector: string,
        vector: number[],
        dim: number,
        userId?: string | null,
        metadata?: Record<string, unknown>,
    ): Promise<void>;
    storeVectors(
        items: Array<{
            id: string;
            sector: string;
            vector: number[];
            dim: number;
            metadata?: Record<string, unknown>;
        }>,
        userId?: string | null,
    ): Promise<void>;
    deleteVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<void>;
    deleteVectors(ids: string[], userId?: string | null): Promise<void>;
    deleteVectorsByUser(userId: string): Promise<void>;
    searchSimilar(
        sector: string,
        queryVec: number[],
        topK: number,
        userId?: string | null,
        filter?: { metadata?: Record<string, unknown> },
    ): Promise<Array<{ id: string; score: number }>>;
    getVector(
        id: string,
        sector: string,
        userId?: string | null,
    ): Promise<{ vector: number[]; dim: number; metadata?: Record<string, unknown> } | null>;
    getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }>>;
    getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<
        Array<{ id: string; sector: string; vector: number[]; dim: number; metadata?: Record<string, unknown> }>
    >;
    getVectorsBySector(
        sector: string,
        userId?: string | null,
        limit?: number,
        offset?: number,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>>;
    getAllVectorIds(userId?: string | null): Promise<Set<string>>;
    iterateVectorIds(userId?: string | null): AsyncIterable<string>;
    cleanupOrphanedVectors(userId?: string | null): Promise<{ deleted: number }>;
    disconnect?(): Promise<void>;
}
