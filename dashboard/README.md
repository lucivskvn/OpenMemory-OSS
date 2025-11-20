# OpenMemory Dashboard

Web interface for managing memories, viewing analytics, and chatting with your memory system.

## Quick Start (Bun)

```bash
bun install --frozen-lockfile
bun run dev
```

Open <http://localhost:3000>

## Environment Setup

Create `.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_API_KEY=your-api-key-here
```

## Scripts

- `bun run dev` - Start development server (Bun runtime)
- `bun run build` - Build for production (Bun runtime)
- `bun run start` - Start production server (Bun runtime)
- `bun run lint` - Run ESLint
- `bun run verify:bun` - Verify Bun + Next.js compatibility

**Node.js Fallback:**

- `npm run dev:node` - Development server (Node.js)
- `npm run build:node` - Production build (Node.js)

## Features

- **Memory Management**: View, search, and manage memories
- **Analytics**: Real-time telemetry and performance metrics
- **Chat Interface**: Memory-augmented chat with Vercel AI SDK v5.0.93 (streaming, completions, generative UI)
- **Embedding Config**: Switch between providers (synthetic, OpenAI, Gemini, Ollama, router_cpu)
- **Ollama Management**: Pull, list, delete, and switch models
- **Timeline View**: Temporal knowledge graph visualization
- **Decay Monitoring**: Track memory decay and salience

## Tech Stack

- **Framework**: Next.js 16.0.1 (App Router, React Server Components)
- **Runtime**: Bun v1.3.2+ (recommended) or Node.js 20+
- **AI**: Vercel AI SDK v5.0.93 (streaming chat, completions)
- **UI**: Tailwind CSS 4.1.9, shadcn/ui components
- **Charts**: Chart.js 4.5.1, react-chartjs-2
- **State**: React hooks, Server Actions

## Bun Compatibility

The dashboard is fully compatible with Bun v1.3.2+:

- **Next.js 16**: Works with Bun runtime via `bunx --bun next`
- **Vercel AI SDK v5**: Uses Web APIs (fetch, streams) that Bun implements
- **Dependencies**: All dashboard dependencies are Bun-compatible
- **Performance**: ~40% faster dev server, ~2x faster builds

## Linux Mint 22 Setup

### System Dependencies

```bash
sudo apt update
sudo apt install -y build-essential libssl-dev pkg-config
```

### Bun Installation

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.2"
export PATH="$HOME/.bun/bin:$PATH"
```

### Dashboard Setup

```bash
cd dashboard
bun install --frozen-lockfile
bun run verify:bun
bun run dev
```

### Verification

1. Backend running on port 8080: `curl http://localhost:8080/health`
2. Dashboard running on port 3000: Open <http://localhost:3000>
3. API connection: Check Settings page for green status
4. Chat working: Send a test message in Chat page

### AI SDK Verification

- Quick verification: `cd dashboard && bun run verify:ai-sdk` (automated checks for Bun & ai imports)
- Expected output: All checks return ✅.
- Link to detailed checklist: `dashboard/AI_SDK_VERIFICATION.md`

## Development Workflow

### Adding Dependencies

```bash
bun add <package>  # Add runtime dependency
bun add -d <package>  # Add dev dependency
```

### Updating Dependencies

```bash
bun pm outdated  # Check for updates
bun update  # Update all dependencies
```

### Building for Production

```bash
bun run build
bun run start
```

### Cleaning Cache

```bash
bunx next clean
rm -rf node_modules .next bun.lockb
bun install
```

## Troubleshooting

### Module Resolution Errors

**Symptom:** `Cannot find module` errors

**Solution:**

```bash
rm -rf node_modules .next bun.lockb
bun install --frozen-lockfile
```

### Next.js Build Errors

**Symptom:** Build fails with TypeScript errors

**Solution:**

```bash
bunx next clean
bun run build
```

### AI SDK Streaming Not Working

**Symptom:** Chat messages don't stream

**Solution:**

1. Verify backend is running: `curl http://localhost:8080/health`
2. Check `.env.local` has correct `NEXT_PUBLIC_API_URL`
3. Verify API key matches backend
4. Check browser console for CORS errors

### Bun Version Mismatch

**Symptom:** `Bun version mismatch` warning

**Solution:**

```bash
bun upgrade
bun --version  # Should be >= 1.3.2
```

### Linux Mint 22 Build Failures

**Symptom:** Native module compilation fails

**Solution:**

```bash
sudo apt install -y build-essential libssl-dev pkg-config
bun install --force
```

## Performance Tips

1. **Use Bun for dev**: ~40% faster startup than Node.js
2. **Clear cache regularly**: `bunx next clean` before major changes
3. **Use frozen lockfile**: `bun install --frozen-lockfile` in CI
4. **Enable Turbopack**: Next.js 16 uses Turbopack by default (faster HMR)

## Node.js Fallback

If you need to use Node.js:

```bash
npm install
npm run dev:node
npm run build:node
```

All functionality is identical - Bun just provides better performance.

## See Also

- [CONTRIBUTING.md](../CONTRIBUTING.md) - Development guidelines
- [linux-mint-22-setup.md](../docs/deployment/linux-mint-22-setup.md) - System setup
- [Bun Documentation](https://bun.sh/docs) - Bun runtime reference
- [Next.js Documentation](https://nextjs.org/docs) - Next.js framework reference
- [Vercel AI SDK](https://sdk.vercel.ai/docs) - AI SDK reference
