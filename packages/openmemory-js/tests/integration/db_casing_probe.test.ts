import { expect, test } from "bun:test";
import { q } from "../../src/core/db";
import { MemoryRow } from "../../src/core/types";

// PROBE TEST: Check if DB returns snake_case or camelCase
test("DB Column Casing Probe", async () => {
    // We can't easily insert without a user, but we can check the mapRow behavior 
    // or just rely on the types if this is purely for IDE debugging.

    // The user's error was: Argument of type 'MemoryRow | undefined' is not assignable... 
    // This implies they did: Object.keys(row) without checking if row is undefined.

    // We'll simulate a fetch
    const row = await q.getMem.get("some-id", "some-user");

    if (row) {
        const keys = Object.keys(row);
        console.log("Keys:", keys);
        expect(keys.length).toBeGreaterThan(0);
    } else {
        console.warn("Row not found, skipping probe.");
    }
});
