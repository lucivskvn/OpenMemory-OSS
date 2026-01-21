import { describe, expect, it } from "bun:test";
import { eventBus } from "../../src/core/events";

describe("Phase 110: Event Isolation", () => {
    it("should isolate listener errors", () => {
        let called = 0;

        // Listener 1: Throws
        eventBus.on("memory_added" as any, () => {
            throw new Error("Boom");
        });

        // Listener 2: Should still be called
        eventBus.on("memory_added" as any, () => {
            called++;
        });

        const result = eventBus.emit("memory_added" as any, { id: "test" } as any);

        expect(result).toBe(true);
        expect(called).toBe(1);
    });
});
