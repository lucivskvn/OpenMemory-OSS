import { test, expect, beforeEach, afterEach } from 'bun:test';

// Tests should set test mode early to make __TEST seams available.
process.env.OM_TEST_MODE = '1';

import * as decay from '../../backend/src/memory/decay';

beforeEach(() => {
  // Reset any prior test hooks
  try { if (decay && (decay as any).__TEST && typeof (decay as any).__TEST.reset === 'function') (decay as any).__TEST.reset(); } catch (e) { }
});

afterEach(() => {
  try { if (decay && (decay as any).__TEST && typeof (decay as any).__TEST.reset === 'function') (decay as any).__TEST.reset(); } catch (e) { }
});

test('apply_decay logs skipped when active queue > 0 (deterministic capture)', async () => {
  const calls: any[] = [];
  (decay as any).__TEST.logHook = (lvl: any, meta: any, msg: any) => {
    calls.push({ lvl, meta, msg });
  };

  // Ensure apply_decay early-exits due to active_q
  decay.inc_q();
  await decay.apply_decay();
  decay.dec_q();

  // Ensure we captured at least one DECAY log entry
  const embedCalls = calls.filter((c) => c.meta && c.meta.component === 'DECAY');
  expect(embedCalls.length).toBeGreaterThanOrEqual(1);
});
