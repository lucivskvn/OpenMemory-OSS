import { beforeEach, mock } from "bun:test";
import { closeDb } from "../src/core/db";
import { reloadConfig } from "../src/core/cfg";

// Mock sharp to prevent "Could not load the sharp module" errors
mock.module("sharp", () => {
    return {
        default: () => ({
            resize: () => ({
                toFormat: () => ({
                    toBuffer: async () => Buffer.from("mock-image-buffer"),
                }),
            }),
            metadata: async () => ({ width: 100, height: 100, format: "png" }),
        }),
    };
});

beforeEach(async () => {
    await closeDb();
    reloadConfig();
});
