# Property-Based Testing

This directory contains property-based tests using fast-check for the OpenMemory JavaScript/TypeScript codebase.

## Structure

- `setup.ts` - Property test configuration and utilities
- `properties/` - Individual property test files organized by module
- `generators/` - Custom generators for domain-specific data types

## Running Property Tests

```bash
# Run all property tests
bun test test/property

# Run specific property test file
bun test test/property/properties/memory.property.test.ts

# Run with verbose output
bun test test/property --verbose
```

## Property Test Guidelines

1. Each property test should run minimum 100 iterations (configured in setup.ts)
2. Use descriptive property names that explain what is being tested
3. Tag tests with the format: `**Feature: openmemory-codebase-improvement, Property {number}: {property_text}**`
4. Focus on universal properties that should hold across all valid inputs
5. Use smart generators that constrain to the input space intelligently

## Example Property Test

```typescript
import { test } from 'bun:test';
import fc from 'fast-check';
import { propertyTestConfig } from '../setup';

test('**Feature: openmemory-codebase-improvement, Property 1: Dependency Audit Completeness**', () => {
  fc.assert(
    fc.property(
      fc.record({
        packages: fc.array(fc.string()),
        versions: fc.array(fc.string())
      }),
      (input) => {
        // Property test logic here
        return true; // Property should hold
      }
    ),
    propertyTestConfig
  );
});
```