import { test, expect, beforeEach, afterEach } from 'bun:test';

process.env.OM_TEST_MODE = '1';

import * as userSummary from '../../backend/src/memory/user_summary';
import { q } from '../../backend/src/core/db';

beforeEach(() => {
  try {
    if (
      userSummary &&
      (userSummary as any).__TEST &&
      typeof (userSummary as any).__TEST.reset === 'function'
    )
      (userSummary as any).__TEST.reset();
  } catch (e) {}
});

afterEach(() => {
  try {
    if (
      userSummary &&
      (userSummary as any).__TEST &&
      typeof (userSummary as any).__TEST.reset === 'function'
    )
      (userSummary as any).__TEST.reset();
  } catch (e) {}
});

test('auto_update_user_summaries logs on per-user failure via __TEST hook', async () => {
  const captured: any[] = [];
  (userSummary as any).__TEST.logHook = (_lvl: any, meta: any, msg: any) => {
    captured.push({ meta, msg });
  };

  // Monkey-patch q to return a single user and cause update_user_summary to throw
  const origAll = q.all_mem.all;
  const origGetUser = q.get_user.get;

  try {
    q.all_mem.all = async () => [{ user_id: 'bad-user' }];
    q.get_user.get = async (_: string) => {
      throw new Error('boom');
    };

    const res = await userSummary.auto_update_user_summaries();

    // Because we threw in update_user_summary for a single user, the function
    // should still return and our logHook should have been called at least once
    // with component USER_SUMMARY
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const first = captured.find(
      (c) => c.meta && c.meta.component === 'USER_SUMMARY',
    );
    expect(first).toBeTruthy();
  } finally {
    q.all_mem.all = origAll;
    q.get_user.get = origGetUser;
    (userSummary as any).__TEST.logHook = null;
  }
});
