#!/usr/bin/env bun
/**
 * @file cli.ts
 * @module CLI
 * @description Standard Command Line Interface for OpenMemory.
 * Legacy wrapper around the new modular CLI structure in `src/cli`.
 */


import { configureLogger } from "./utils/logger";

// Silence info logs to prevent polluting stdout (which is used for JSON output)
configureLogger({ logLevel: "warn" });

// Dynamic import to ensure logger is configured BEFORE other modules load
const { main } = await import("./cli/index");

main().catch(console.error);
