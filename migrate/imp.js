const fs = require('fs'),
  readline = require('readline'),
  path = require('path');

class Importer {
  constructor(config) {
    this.config = config;
    const port = process.env.OM_PORT || '8080';
    this.baseUrl = config.openMemoryUrl || process.env.OPENMEMORY_URL || `http://localhost:${port}`;
    this.apiKey =
      config.openMemoryKey || process.env.OPENMEMORY_API_KEY || process.env.OM_API_KEY || '';
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async importFile(filePath) {
    const startTime = Date.now();
    let importedCount = 0,
      failedCount = 0;

    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    console.log('[IMPORT] Processing export file...');
    console.log(`[IMPORT] Target: ${this.baseUrl}`);

    for await (const line of lineReader) {
      try {
        const data = JSON.parse(line);
        await this.processMemory(data);
        importedCount++;
        if (importedCount % 100 === 0)
          console.log(`[IMPORT] Progress: ${importedCount} memories imported`);
      } catch (e) {
        failedCount++;
        console.error(`[IMPORT] Warning: Skipped record - ${e.message}`);
      }
    }

    lineReader.close();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    return { imported: importedCount, failed: failedCount, duration: duration, m: importedCount, f: failedCount, d: duration }; // Return both new and legacy props just in case
  }

  async processMemory(data) {
    const payload = {
      content: data.c,
      tags: data.t || [],
      metadata: {
        ...data.meta,
        migrated: true,
        orig_id: data.id,
        orig_created_at: data.ca,
        orig_last_seen: data.ls,
      },
    };
    if (data.uid && data.uid !== 'default') payload.user_id = data.uid;

    const response = await fetch(`${this.baseUrl}/api/memory/add`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'No response');
      throw new Error(`API ${response.status}: ${text}`);
    }
    return await response.json();
  }
}

module.exports = Importer;
