/**
 * @file Database Module Barrel Export
 * Centralized exports for all database-related functionality.
 * Split from the monolithic db_access.ts for better memory management.
 */

// Core database operations
export * from './operations';
export * from './connection';
export * from './transactions';
export * from './tables';
export * from './mappers';
export * from './population';

// Legacy compatibility - re-export everything that was in db_access.ts
export { q, type RepositoryMap, closeDb } from './connection';