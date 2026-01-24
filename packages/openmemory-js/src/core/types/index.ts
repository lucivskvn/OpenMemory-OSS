export * from "./primitives";

// Re-export all domain types
export * from "./memory";
export * from "./temporal";
export * from "./dynamics";
export * from "./system";
export * from "./sources";
export * from "./ai";
export * from "./admin";

// Keep legacy Event types in index for simple SSE handling
import type { OpenMemoryEvent } from "./aiEvents";
export type { OpenMemoryEvent };
