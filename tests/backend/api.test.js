import { test } from 'bun:test'

// Legacy runner replaced by Bun-native test suites. Keep a noop test so
// CI/tools that still collect files see this as a valid, intentionally
// empty legacy placeholder.
test('legacy api.test disabled', () => {
  // no-op
})
