/**
 * @file vector_store.ts
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
    ): Promise<{ vector: number[]; dim: number } | null>;
    getVectorsById(
        id: string,
        userId?: string | null,
    ): Promise<Array<{ sector: string; vector: number[]; dim: number }>>;
    getVectorsByIds(
        ids: string[],
        userId?: string | null,
    ): Promise<
        Array<{ id: string; sector: string; vector: number[]; dim: number }>
    >;
    getVectorsBySector(
        sector: string,
        userId?: string | null,
    ): Promise<Array<{ id: string; vector: number[]; dim: number }>>;
    getAllVectorIds(userId?: string | null): Promise<Set<string>>;
    disconnect?(): Promise<void>;
}
