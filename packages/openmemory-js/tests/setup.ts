import { beforeAll } from "bun:test";
import { init_db } from "../src/core/db";

beforeAll(async () => {
    try {
        console.log("Setting up DB tables for test...");
        await init_db();
        console.log("DB setup complete");
    } catch (e) {
        console.error("Test setup DB init failed", e);
    }
});
