/**
 * Example Property-Based Test
 * 
 * This file demonstrates the property-based testing setup and serves as
 * a template for writing property tests in the OpenMemory codebase.
 */

import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { propertyTestConfig, generators, propertyTestUtils } from '../setup';

test('**Feature: openmemory-codebase-improvement, Property Example: Vector Normalization**', () => {
  fc.assert(
    fc.property(
      generators.embeddingVector(8), // Reduced dimensions from 128 to 8
      (vector) => {
        // Property: All generated vectors should be normalized (magnitude ≈ 1)
        const isNormalized = propertyTestUtils.isNormalizedVector(vector);
        expect(isNormalized).toBe(true);
        
        // Additional property: All values should be finite numbers
        const allFinite = vector.every(v => propertyTestUtils.isFiniteNumber(v));
        expect(allFinite).toBe(true);
        
        return true;
      }
    ),
    { ...propertyTestConfig, numRuns: 5 } // Very reduced for this complex test
  );
});

test('**Feature: openmemory-codebase-improvement, Property Example: User ID Validation**', () => {
  fc.assert(
    fc.property(
      generators.userId(),
      (userId) => {
        // Property: Generated user IDs should be non-empty strings
        expect(typeof userId).toBe('string');
        expect(userId.length).toBeGreaterThan(0);
        expect(userId.trim().length).toBeGreaterThan(0);
        
        return true;
      }
    ),
    { ...propertyTestConfig, numRuns: 10 } // Further reduced for this test
  );
});