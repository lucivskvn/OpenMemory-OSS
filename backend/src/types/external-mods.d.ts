// Ambient declarations for modules without type definitions used in the backend
// This avoids TS7016 errors when dynamic-importing these packages in Bun.
declare module "pg";
declare module "sqlite3";
declare module "pdf-parse";
declare module "mammoth";
