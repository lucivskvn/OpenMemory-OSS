import { describe, it, expect, beforeEach } from 'bun:test';

// Set environment for embedding tests before importing modules
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_DB_PATH = ':memory:';
process.env.OM_EMBED_KIND = 'local';
process.env.OM_VEC_DIM = '128';
process.env.OM_EMBED_MODE = 'advanced';

// Import after env configured
import { initDb, q, get_async } from '../../backend/src/core/db.js';
import {
  embedMultiSector,
  gen_syn_emb,
  embedForSector,
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  getEmbeddingInfo,
} from '../../backend/src/memory/embed.js';

describe('Embedding layer integration tests', () => {
  beforeEach(async () => {
    // Ensure fresh in-memory DB
    await initDb();
  });

  it('local embedding returns normalized vector and records logs', async () => {
      const info = getEmbeddingInfo();
      const expectedDim = info.dimensions || 256;
    const id = 'embed-test-1';
    const res = await embedMultiSector(id, 'this is a test', ['semantic'], undefined, 'test-user');
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(1);
    const v = res[0].vector;
      expect(v.length).toBe(expectedDim);
    expect(Math.abs(cosineSimilarity(v, v) - 1)).toBeLessThan(1e-6);

    // Persist vector into DB and read it back
    const buf = vectorToBuffer(v);
    await q.ins_vec.run(id, 'semantic', 'test-user', buf, v.length);
    const stored = await q.get_vec.get(id, 'semantic', 'test-user');
    expect(stored).toBeTruthy();
    // `stored.v` may be a Uint8Array in Bun sqlite; ensure a Buffer is passed
    let storedBuf = stored.v;
    if (!storedBuf || typeof storedBuf.readFloatLE !== 'function') {
      storedBuf = Buffer.from(storedBuf || []);
    }
    const retrieved = bufferToVector(storedBuf);
    expect(retrieved.length).toBe(v.length);
    expect(cosineSimilarity(v, retrieved)).toBeGreaterThan(0.9999);

      // verify embed_logs status changed to completed (or present)
    const logRow = await get_async('select status from embed_logs where id=?', [id]);
    expect(logRow).toBeTruthy();
    expect(String(logRow.status).toLowerCase()).toBe('completed');
  });

  it('synthetic generator and sector fuser behave and return expected dims', async () => {
    const syn = gen_syn_emb('tokens for synthetic', 'episodic');
    expect(Array.isArray(syn)).toBe(true);
      const info = getEmbeddingInfo();
      const expectedDim = info.dimensions || 256;
      expect(syn.length).toBe(expectedDim);

    const sem = await embedForSector('some text', 'semantic');
      expect(sem.length).toBe(expectedDim);

    const fused = (await import('../../backend/src/memory/embed.js')).fuse_vecs(syn, sem);
    expect(Array.isArray(fused)).toBe(true);
    // fused dim should equal syn.length + sem.length as designed
    expect(fused.length).toBe(syn.length + sem.length);
  });

  it('getEmbeddingInfo reports provider and dimensions', () => {
    const info = getEmbeddingInfo();
    expect(info).toBeTruthy();
      expect(info.provider).toBeTruthy();
      expect(info.dimensions).toBeTruthy();
  });

    it('embedMultiSector marks logs failed after retries when provider consistently fails', async () => {
        const id = 'embed-fail-test';
        const mod = await import('../../backend/src/memory/embed.js');
        const orig_emb_local = mod.emb_local;
        // Monkey-patch the provider to always throw
        mod.emb_local = async () => {
            throw new Error('forced failure for test');
        };
        let threw = false;
        try {
            await mod.embedMultiSector(id, 'this will fail', ['semantic'], undefined, 'test-user');
        } catch (e) {
            threw = true;
        }
        try {
            const row = await get_async('select status,err from embed_logs where id=?', [id]);
            expect(threw).toBe(true);
            expect(row).toBeTruthy();
            expect(String(row.status).toLowerCase()).toBe('failed');
            expect(row.err).toBeTruthy();
            expect(String(row.err).length).toBeGreaterThan(0);
        } finally {
            // restore provider to avoid side-effects
            mod.emb_local = orig_emb_local;
        }
    });
});
