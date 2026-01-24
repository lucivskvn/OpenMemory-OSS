# Bun Native API Guidelines

This document outlines the ESLint rules and guidelines for enforcing Bun Native API usage in the OpenMemory codebase, as mandated by AGENTS.md.

## Overview

The OpenMemory codebase follows the "Bun Native" rule, which requires using Bun's native APIs instead of Node.js APIs for optimal performance and compatibility.

## ESLint Rules

### 1. `bun-native/no-node-fs`

**Rule**: Disallow Node.js `fs` module in favor of `Bun.file()`

**❌ Forbidden:**
```typescript
import fs from 'node:fs';
import { readFile } from 'fs/promises';
const fs = require('fs');

// Usage
const content = await fs.readFile('file.txt', 'utf8');
const data = fs.readFileSync('file.txt', 'utf8');
```

**✅ Required:**
```typescript
// Reading files
const content = await Bun.file('file.txt').text();
const buffer = await Bun.file('file.txt').arrayBuffer();
const json = await Bun.file('file.json').json();

// Writing files
await Bun.write('file.txt', 'content');
await Bun.write('file.json', JSON.stringify(data));

// File existence check
const exists = await Bun.file('file.txt').exists();
```

**Exceptions:**
- Files in `src/utils/compat/` (compatibility layer)
- Test files (when mocking is required)
- Build scripts

### 2. `bun-native/prefer-bun-spawn`

**Rule**: Prefer `Bun.spawn()` over `child_process`

**❌ Forbidden:**
```typescript
import { spawn, exec } from 'child_process';
const { spawn } = require('child_process');

const child = spawn('ls', ['-la']);
```

**✅ Required:**
```typescript
const proc = Bun.spawn(['ls', '-la']);
const output = await new Response(proc.stdout).text();

// For cross-platform compatibility
const proc = Bun.spawn(['rm', filePath]); // Unix
const proc = Bun.spawn(['del', filePath]); // Windows
```

### 3. `bun-native/prefer-bun-env`

**Rule**: Prefer `Bun.env` over `process.env`

**❌ Discouraged:**
```typescript
const apiKey = process.env.API_KEY;
```

**✅ Required:**
```typescript
// Access environment variables through cfg.ts only
import { cfg } from '../core/cfg.ts';
const apiKey = cfg.apiKey;

// In cfg.ts file (exception)
const apiKey = Bun.env.API_KEY || 'default';
```

### 4. `bun-native/enforce-bun-file-patterns`

**Rule**: Enforce proper `Bun.file()` usage patterns

**✅ Best Practices:**
```typescript
// Async operations (preferred)
const content = await Bun.file('path').text();
const json = await Bun.file('path').json();
const buffer = await Bun.file('path').arrayBuffer();

// File operations
await Bun.write('path', content);
const exists = await Bun.file('path').exists();
const size = await Bun.file('path').size();
```

## Configuration

The ESLint configuration includes exceptions for specific directories:

```javascript
"bun-native/no-node-fs": ["error", {
    "allowExceptions": [
        "src/utils/compat", // Compatibility layer
        "test/",           // Test files
        "scripts/"         // Build scripts
    ]
}]
```

## Migration Guide

### From Node.js fs to Bun.file()

| Node.js Pattern | Bun Native Pattern |
|----------------|-------------------|
| `fs.readFile(path, 'utf8')` | `Bun.file(path).text()` |
| `fs.readFile(path)` | `Bun.file(path).arrayBuffer()` |
| `fs.writeFile(path, data)` | `Bun.write(path, data)` |
| `fs.existsSync(path)` | `await Bun.file(path).exists()` |
| `fs.statSync(path)` | `await Bun.file(path).size()` |
| `JSON.parse(fs.readFileSync())` | `Bun.file(path).json()` |

### From child_process to Bun.spawn()

| Node.js Pattern | Bun Native Pattern |
|----------------|-------------------|
| `spawn('cmd', args)` | `Bun.spawn(['cmd', ...args])` |
| `exec('command')` | `Bun.spawn(['sh', '-c', 'command'])` |
| `execSync('command')` | `Bun.spawnSync(['sh', '-c', 'command'])` |

## Performance Benefits

Using Bun Native APIs provides:

1. **Better Performance**: Bun's native file I/O is optimized for speed
2. **Memory Efficiency**: Reduced memory overhead compared to Node.js APIs
3. **Async First**: Bun's APIs are designed for async operations
4. **Type Safety**: Better TypeScript integration
5. **Cross-Platform**: Consistent behavior across platforms

## Compatibility Layer

When Node.js APIs are absolutely required (e.g., for third-party dependencies), create a compatibility layer in `src/utils/compat/`:

```typescript
// src/utils/compat/fs-compat.ts
import type { ReadStream } from 'fs';

export function createReadStreamCompat(path: string): ReadStream {
    // Wrapper for cases where ReadStream is required
    // Use sparingly and document why it's needed
    const fs = require('fs');
    return fs.createReadStream(path);
}
```

## Enforcement

- ESLint will flag violations during development
- CI/CD pipeline will fail on Bun Native API violations
- Pre-commit hooks prevent non-compliant code from being committed
- Regular audits ensure compliance across the codebase

## Troubleshooting

### Common Issues

1. **TypeScript Complaints**: Cast to `any` if TypeScript complains about Bun.file() compatibility:
   ```typescript
   const stream = await Bun.file(path) as any; // Verified working
   ```

2. **Third-Party Dependencies**: If a dependency requires Node.js streams, create a compatibility wrapper in `src/utils/compat/`

3. **Test Mocking**: Use Bun's native mocking in tests, but Node.js APIs are allowed in test files when necessary

## Resources

- [Bun File API Documentation](https://bun.sh/docs/api/file-io)
- [Bun Spawn API Documentation](https://bun.sh/docs/api/spawn)
- [AGENTS.md](../../../Agents.md) - Supreme law of the repo
- [OpenMemory Architecture](../../../ARCHITECTURE.md)