export interface VectorStore {
    storeVector(id: string, sector: string, vector: number[], dim: number, user_id?: string): Promise<void>;
    deleteVector(id: string, sector: string): Promise<void>;
    deleteVectors(id: string): Promise<void>;
    searchSimilar(sector: string, queryVec: number[], topK: number, user_id?: string): Promise<Array<{ id: string; score: number }>>;
    getVector(id: string, sector: string, user_id?: string): Promise<{ vector: number[]; dim: number } | null>;
    getVectorsById(id: string, user_id?: string): Promise<Array<{ sector: string; vector: number[]; dim: number }>>;
    getVectorsBySector(sector: string, user_id?: string): Promise<Array<{ id: string; vector: number[]; dim: number }>>;
    disconnect?(): Promise<void>;
}
