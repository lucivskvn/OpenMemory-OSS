# Dashboard Bun Migration & Vercel AI SDK v5.0.93 Integration

This document describes Dashboard migration to Bun runtime and details AI SDK (Vercel `ai` v5.0.93) integration patterns and verification steps.

## Bun + Dashboard summary

- Bun v1.3.2 provides significantly faster dev server and build times for Next.js 16.
- Use `bunx --bun next` to ensure Bun's runtime is used for Next commands.

## Vercel AI SDK v5.0.93 Integration

AI SDK v5.0.93 is used in the Dashboard for chat-related features and RSC streaming. Key features:

- `useChat` — client-side hook for reactive chat streams
- `useCompletion` — streaming completions for text generation
- `streamText` — server-side LLM streaming
- `createStreamableValue` — React Server Component streaming helper
- `streamUI` — generative UI helpers for RSC

**Version:** `ai@5.0.93` is the pinned and tested version for OpenMemory (Nov 2025).

### Why it works with Bun

- AI SDK v5 uses browser-style Web APIs (`fetch`, `ReadableStream`) which are implemented in Bun.
- No Node 18-specific internal APIs are required; the SDK runs in Bun without additional shims.

### Migration notes from SDK v4

- Import paths in v5 are updated: use `ai` package for all functions (hooks and core)
- `streamText` is the canonical streaming API for server-side streaming
- `createStreamableValue` supports RSC streaming values
- If upgrading from v4, update imports and test streaming flows thoroughly

### Current Implementation in OpenMemory

- AI SDK v5.0.93 is **fully integrated** in the Dashboard chat flow.
- `dashboard/app/chat/page.tsx` uses `useMemoryChat` (custom wrapper around `useChat` from `@ai-sdk/react`) for client-side reactive streaming.
- `dashboard/app/api/chat/route.ts` uses `streamText` (from `ai` package) + `toUIMessageStreamResponse` for server-side LLM streaming with memory augmentation.
- Streaming: Single source using AI SDK native `streamText` and compatible SSE stream, no legacy fallbacks.
- Telemetry and memories: Parsed from markers injected into the stream for sidebar display.

### useChat Hook Integration

The chat page (`dashboard/app/chat/page.tsx`) now uses the `useChat` hook with these key features:

- **API Endpoint**: `/api/chat` with streaming support
- **Memory Pre-processing**: Queries memories before submitting to useChat via custom form handler
- **Telemetry Parsing**: Extracts `[[OM_TELEMETRY]]` markers on completion for performance tracking
- **Error Handling**: Graceful fallbacks when backend unavailable
- **Loading States**: Native isLoading state from useChat replaces custom busy states

### streamText Server Integration

The chat API route (`dashboard/app/api/chat/route.ts`) implements a custom memory model using `streamText`:

- **Custom Model Provider**: Generates memory-augmented responses using existing OpenMemory logic
- **Memory Injection**: Queries backend memories and augments LLM responses with context
- **Streaming Format**: Produces text stream responses compatible with useChat client
- **Telemetry Embedding**: Injects performance metrics and memory IDs in response stream
- **Sector Weighting**: Applies memory sector weightings (episodic: 1.3x, emotional: 1.4x, etc.)

### Memory Augmentation Flow

1. User submits message via `handleFormSubmit`
2. Memory query runs first: `POST /memory/query` to backend
3. useChat processes message: calls `/api/chat` with streaming
4. API route uses custom memory model with `streamText`
5. Memory context injected into response generation
6. Streamed response delivered via AI SDK data stream protocol
7. Telemetry parsed on completion for UI display

### Verification

See `dashboard/AI_SDK_VERIFICATION.md` for a complete checklist and `bun run verify:ai-sdk` for an automated run.

### Best Practices with Bun

- Use `bunx --bun next` for all Next dev/build commands to ensure runtime consistency
- Test streaming flows with the backend running on port 8080
- Use `.env.local` for API keys
- Run `bun run verify:ai-sdk` in CI to catch runtime/import issues early

### Troubleshooting

- If `ai` import fails, remove `node_modules` and lockfile and run `bun install --frozen-lockfile`
- If `ReadableStream` or `fetch` missing, verify Bun version and global scope in your environment

### Resources

- Vercel AI SDK docs: [https://sdk.vercel.ai/docs](https://sdk.vercel.ai/docs)
- Dashboard verification script: `dashboard/scripts/verify-ai-sdk.ts`
- AI SDK checklist: `dashboard/AI_SDK_VERIFICATION.md`
