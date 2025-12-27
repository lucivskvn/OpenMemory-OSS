import { describe, it, expect } from 'bun:test';
import { transcribeAudioWithOpenAI } from '../../src/core/openai_adapter';
import { env } from '../../src/core/cfg';

describe('OpenAI adapter', () => {
  it('throws when OPENAI key missing', async () => {
    const old = env.openai_key;
    (env as any).openai_key = undefined;
    try {
      let threw = false;
      try { await transcribeAudioWithOpenAI(Buffer.from('foo'), 'whisper-1'); } catch (e) { threw = true; }
      expect(threw).toBe(true);
    } finally {
      (env as any).openai_key = old;
    }
  });
});
