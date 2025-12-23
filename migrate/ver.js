class Verifier {
  constructor(config) {
    const port = process.env.OM_PORT || '8080';
    this.baseUrl = config.openMemoryUrl || `http://localhost:${port}`;
    this.apiKey = config.openMemoryKey || process.env.OM_API_KEY || '';
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async verify(stats) {
    const warnings = [];
    try {
      console.log('[VERIFY] Checking memory count via API...');
      // Updated to use correct endpoint and payload for search/query
      const response = await fetch(`${this.baseUrl}/api/memory/query`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query: '', k: 10000 }),
      });

      if (!response.ok) {
        return {
          ok: false,
          warnings: [`API verification unavailable: ${response.status}`],
          w: [`API verification unavailable: ${response.status}`]
        };
      }

      const data = await response.json();
      const memoryCount = data.matches?.length || 0;

      console.log(`[VERIFY] Found ${memoryCount} memories in OpenMemory`);

      const expected = stats.imported || stats.m;
      if (Math.abs(memoryCount - expected) > expected * 0.05)
        warnings.push(`Memory count mismatch: expected ${expected}, got ${memoryCount}`);

      console.log('[VERIFY] Checking for duplicates...');
      const duplicates = await this.checkDuplicates(data.matches || []);
      if (duplicates > memoryCount * 0.01)
        warnings.push(`High duplicate rate: ${((duplicates / memoryCount) * 100).toFixed(1)}%`);

      return { ok: warnings.length === 0, warnings, w: warnings };
    } catch (e) {
      return { ok: false, warnings: [`Verification failed: ${e.message}`], w: [`Verification failed: ${e.message}`] };
    }
  }

  async checkDuplicates(memories) {
    const hashes = new Set();
    let duplicates = 0;
    for (const m of memories) {
      const h = this.hash(m.content);
      if (hashes.has(h)) duplicates++;
      else hashes.add(h);
    }
    return duplicates;
  }

  hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  }
}

module.exports = Verifier;
