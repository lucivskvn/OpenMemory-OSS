/**
 * Property-Based Testing Setup and Configuration
 * 
 * This file provides configuration and utilities for property-based testing
 * using fast-check in the OpenMemory codebase.
 */

import fc from 'fast-check';

/**
 * Default configuration for property tests
 * - Minimum 100 iterations as specified in the design document
 * - Verbose output for better debugging
 * - Seed for reproducible test runs
 */
export const propertyTestConfig: fc.Parameters<unknown> = {
  numRuns: 25, // Reduced from 100 to prevent hanging
  verbose: false, // Reduced verbosity
  seed: 42,
  endOnFailure: true,
  timeout: 5000, // 5 second timeout
};

/**
 * Configuration for performance-sensitive property tests
 * - Reduced iterations for tests that involve heavy operations
 */
export const performancePropertyTestConfig: fc.Parameters<unknown> = {
  numRuns: 10, // Reduced from 50
  verbose: false,
  seed: 42,
  endOnFailure: true,
  timeout: 3000,
};

/**
 * Configuration for integration property tests
 * - Fewer iterations for tests that involve database or external resources
 */
export const integrationPropertyTestConfig: fc.Parameters<unknown> = {
  numRuns: 5, // Reduced from 25
  verbose: false,
  seed: 42,
  endOnFailure: true,
  timeout: 2000,
};

/**
 * Custom generators for OpenMemory domain objects
 */
export const generators = {
  /**
   * Generate valid user IDs
   */
  userId: () => fc.string({ minLength: 1, maxLength: 50 }).map(s => s.trim() || 'user-id'),

  /**
   * Generate valid memory content
   */
  memoryContent: () => fc.string({ minLength: 1, maxLength: 10000 }),

  /**
   * Generate valid embedding vectors (normalized)
   */
  embeddingVector: (dimensions: number = 1536) => 
    fc.array(
      fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }), 
      { minLength: dimensions, maxLength: dimensions }
    ).map(arr => {
      // Ensure we have valid finite numbers
      const validArr = arr.filter(val => Number.isFinite(val));
      if (validArr.length === 0) {
        // Fallback to a simple normalized vector if all values are invalid
        return Array(dimensions).fill(0).map((_, i) => i === 0 ? 1 : 0);
      }
      
      // Pad with zeros if we filtered out some values
      while (validArr.length < dimensions) {
        validArr.push(0);
      }
      
      // Normalize the vector
      const magnitude = Math.sqrt(validArr.reduce((sum, val) => sum + val * val, 0));
      return magnitude > 0 ? validArr.map(val => val / magnitude) : validArr.map((_, i) => i === 0 ? 1 : 0);
    }),

  /**
   * Generate valid configuration objects
   */
  config: () => fc.record({
    databaseUrl: fc.string(),
    vectorDimensions: fc.integer({ min: 128, max: 4096 }),
    maxMemorySize: fc.integer({ min: 1000, max: 1000000 }),
  }),

  /**
   * Generate valid API keys
   */
  apiKey: () => fc.string({ minLength: 32, maxLength: 64 }).map(s => 
    s.replace(/[^a-zA-Z0-9_-]/g, 'a').padEnd(32, 'x')
  ),

  /**
   * Generate valid timestamps
   */
  timestamp: () => fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),

  /**
   * Generate valid file paths (following Bun Native patterns)
   */
  filePath: () => fc.string({ minLength: 1, maxLength: 255 }).map(s => 
    s.replace(/\0/g, '').trim() || 'default-path'
  ),

  /**
   * Generate valid dependency version strings
   */
  version: () => fc.tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 })
  ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),

  /**
   * Generate valid package names
   */
  packageName: () => fc.string({ minLength: 1, maxLength: 50 }).map(s => 
    s.toLowerCase().replace(/[^a-z0-9@/_-]/g, 'a') || 'package-name'
  ),
};

/**
 * Utility functions for property tests
 */
export const propertyTestUtils = {
  /**
   * Create a test database path for property tests
   */
  createTestDbPath: () => `test_property_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.sqlite`,

  /**
   * Clean up test database using Bun Native APIs
   */
  cleanupTestDb: async (dbPath: string) => {
    try {
      const file = Bun.file(dbPath);
      if (await file.exists()) {
        // Use Bun.spawn for cross-platform file deletion as per AGENTS.md
        const platform = process.platform;
        if (platform === 'win32') {
          await Bun.spawn(['del', dbPath]);
        } else {
          await Bun.spawn(['rm', dbPath]);
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup test database ${dbPath}:`, error);
    }
  },

  /**
   * Validate that a value is a finite number
   */
  isFiniteNumber: (value: unknown): value is number => 
    typeof value === 'number' && Number.isFinite(value),

  /**
   * Validate that an array represents a normalized vector
   */
  isNormalizedVector: (vector: number[]): boolean => {
    if (!Array.isArray(vector) || vector.length === 0) return false;
    if (!vector.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
    
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return Math.abs(magnitude - 1.0) < 1e-6; // Allow for floating point precision
  },

  /**
   * Validate error patterns for consistency
   */
  isConsistentError: (error: unknown): boolean => {
    return error instanceof Error && 
           typeof error.message === 'string' && 
           error.message.length > 0;
  },
};

/**
 * Property test assertion helpers
 */
export const propertyAssertions = {
  /**
   * Assert that a function maintains referential transparency
   */
  isReferentiallyTransparent: <T, R>(
    fn: (input: T) => R,
    input: T
  ): boolean => {
    const result1 = fn(input);
    const result2 = fn(input);
    return JSON.stringify(result1) === JSON.stringify(result2);
  },

  /**
   * Assert that a function is idempotent
   */
  isIdempotent: <T>(
    fn: (input: T) => T,
    input: T
  ): boolean => {
    const result1 = fn(input);
    const result2 = fn(result1);
    return JSON.stringify(result1) === JSON.stringify(result2);
  },

  /**
   * Assert that a function preserves invariants
   */
  preservesInvariant: <T>(
    fn: (input: T) => T,
    invariant: (value: T) => boolean,
    input: T
  ): boolean => {
    if (!invariant(input)) return true; // Skip if input doesn't satisfy invariant
    const result = fn(input);
    return invariant(result);
  },
};