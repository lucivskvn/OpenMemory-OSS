# AI SDK v5.0.98 Verification Checklist (Dashboard)

This checklist documents how to verify Vercel AI SDK v5.0.98 with Bun v1.3.2 on Linux Mint 22 (Ubuntu 24.04 base).

Use the automated script `bun run verify:ai-sdk` for a strict, developer-friendly run, or `bun run verify:ai-sdk:ci` for a CI-friendly non-fatal run used by GitHub Actions.

Tip: To force verification to be fatal in CI set `OM_VERIFY_STRICT=1` before running the script: `OM_VERIFY_STRICT=1 bun run verify:ai-sdk`.

## Overview

- Test integration: `ai@5.0.98` (Vercel AI SDK v5)
- Runtime: Bun v1.3.2+ (recommended)
- OS: Linux Mint 22 / Ubuntu 24.04 base

## Prerequisites

- Bun 1.3.2 installed
- `build-essential`, `libssl-dev`, `pkg-config` installed for native module builds
- Dashboard dependencies installed: `cd dashboard && bun install --frozen-lockfile`

### Automate verification

Run this in `dashboard/`:

```bash
bun run verify:ai-sdk
```

Expect all checks to pass (green ✅).

Note: The script is strict locally by default and exits non-zero on errors. In CI, the job runs the `verify:ai-sdk:ci` target which reports the same errors but does not fail the job unless `OM_VERIFY_STRICT=1` is set. This prevents verification flakiness from blocking unrelated pipeline jobs.

## Manual Steps

- Verify AI SDK version

  ```bash
  cd dashboard
  bun pm ls ai
  # Expect ai@5.0.98
  ```

- Import test

  ```bash
  cat > /tmp/test-ai-sdk.ts << 'EOF'
  import { useChat, useCompletion } from '@ai-sdk/react'
  import { streamText } from 'ai'
  import { createStreamableValue } from 'ai/rsc'
  console.log('AI SDK import test successful')
  EOF
  cd dashboard && bunx --bun tsx /tmp/test-ai-sdk.ts
  ```

- Web APIs verification

  ```bash
  bun repl
  > typeof fetch     // should be 'function'
  > typeof ReadableStream
  > typeof TextEncoder
  > typeof EventSource (may be missing; polyfill recommended for Node-like envs)
  ```

- Streaming verification (manual)

  1. Start backend: `cd backend && bun run dev` (port 8080)
  2. Start dashboard: `cd dashboard && bun run dev` (port 3000)
  3. Open `http://localhost:3000/chat`
  4. Enter a query and verify useChat hook streams responses with `{role: 'assistant', content: ...}` format
  5. Runtime test: Check DevTools > Network for `text/event-stream` content-type and standard AI SDK message format in stream

- Benchmarks (optional)

  ```bash
  cd backend
  bun run test:benchmarks
  ```

  Expect TTFT < 500ms, TPS > 20 for AI SDK tests

## Test Coverage: Synthetic vs Real Provider Tests

The test suite includes both synthetic and real provider tests for comprehensive coverage:

- **Synthetic tests** (default in CI): Use the `OM_TEST_MODE=1` synthetic stream response for predictable, offline testing
- **Real LLM tests** (gated): Only run when `OM_ENABLE_LLM_TESTS=1` and `OPENAI_API_KEY` are set, testing actual `streamText` + OpenAI integration

Run synthetic tests (CI default):

```bash
cd dashboard
OM_TEST_MODE=1 bun test tests/dashboard/ai-sdk-streaming.test.ts
```

Run real LLM tests (developer debugging or nightly jobs):

```bash
OM_ENABLE_LLM_TESTS=1 bun test tests/dashboard/ai-sdk-streaming.test.ts
```

Synthetic tests validate:

- SSE format compatibility
- Telemetry and memory marker parsing
- API endpoint response structure

Real LLM tests validate:

- End-to-end OpenAI API connectivity
- `toUIMessageStreamResponse` streaming format
- Performance metrics (TTFT, throughput)
- Real assistant message generation without synthetic markers

Use real tests sparingly to avoid API costs; they are recommended for pull requests that touch streaming logic.

## Common Issues & Fixes

- `Cannot find module 'ai/react'`

  - Run `bun install --frozen-lockfile` inside `dashboard`
  - Remove node_modules and lockfile then reinstall:

    ```bash
    rm -rf node_modules bun.lockb .next
    bun install --frozen-lockfile
    ```

- Streaming not working:
  - Verify backend is running on port 8080
  - Check CORS on API endpoints
  - Use browser DevTools to inspect SSE or fetch responses

### Mock model requirements for `streamText`

- If you are running `streamText` with a synthetic/mock language model (e.g., in `dashboard/scripts/verify-ai-sdk.ts`), the AI SDK v5 requires the model to identify itself as implementing specification version `v2`.
- Missing or undefined `specificationVersion` will cause AI SDK to throw `AI_UnsupportedModelVersionError: Unsupported model version undefined for provider "undefined" and model "undefined"`.
- Provide the minimal metadata fields on your mock model so the `streamText` function accepts it. Example minimal structure:

```ts
// Minimal mock language model accepted by AI SDK v5 for streamText
const mockModel = {
  // REQUIRED: v5 uses a spec version check. Use "v2" for the current API.
  specificationVersion: 'v2',
  // REQUIRED: provider id for diagnostic/info messages
  provider: 'mock',
  // REQUIRED: a modelId for logging/diagnostics
  modelId: 'mock-model',

  // The `api` object must implement a generator-like execute method that yields chunks
  api: async (params: any) => ({
    shouldStream: true,
    execute: async function* (callbacks: any) {
      yield ['0:', 'Mock AI response'];
      callbacks.onFinish({
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 3, totalTokens: 4 },
        experimental_providerMetadata: {},
      });
    },
    modelId: 'mock-model',
  }),

  // Optional: other flags used by SDK internals
  supportsStructuredOutputs: false,
  maxToolRoundtrips: 0,
};
```

Add these fields when mocking models for `streamText` to avoid runtime errors during CI or local verification.

## Features in v5.0.98 relevant for the dashboard

- `useChat` — client-side hook for streaming chat states
- `useCompletion` — streaming completions for short text generation
- `streamText` — server-side streaming for LLMs
- `streamUI` — generative UI helpers for RSC
- `createStreamableValue` — helper to return streamable values from RSC

## Troubleshooting Checklist

- [ ] `bun --version` returns 1.3.2+
- [ ] `bun pm ls ai` shows `5.0.98`
- [ ] `/etc/os-release` indicates Ubuntu 24.04 base
- [ ] `bun run verify:ai-sdk` returns all green checks
- [ ] Dashboard loads in browser on <http://localhost:3000> and chat UI functions

## Known Limitations

None. `/api/chat` now uses `streamText` + `toUIMessageStreamResponse` as the primary and only streaming path for the dashboard.

Production-ready status: Full as of this verification.

## References

- `dashboard/scripts/verify-ai-sdk.ts` — automated verification script
- `docs/deployment/dashboard-bun-migration.md` — migration & compatibility notes
- `docs/testing/linux-mint-22-testing.md` — test suite & benchmarks
- Vercel AI SDK docs: <https://sdk.vercel.ai/docs>
