import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { eventBus, EVENTS } from "../../src/core/events";
import { logger } from "../../src/utils/logger";

describe("Core Events System", () => {
    // Spy on logger to verify error handling
    const errorSpy = spyOn(logger, "error");

    beforeEach(() => {
        eventBus.removeAllListeners();
        errorSpy.mockClear();
    });

    test("should emit and receive events with typed payloads", async () => {
        let receivedPayload: any = null;
        eventBus.on(EVENTS.MEMORY_ADDED, (payload) => {
            receivedPayload = payload;
        });

        const testPayload = {
            id: "mem_123",
            userId: "user_test",
            content: "test content",
            primarySector: "semantic",
            sectors: ["semantic"],
            createdAt: 1000,
            simhash: "abc",
            chunks: 1
        };

        const result = eventBus.emit(EVENTS.MEMORY_ADDED, testPayload);

        expect(result).toBe(true);
        expect(receivedPayload).toEqual(testPayload);
    });

    test("should handle multiple listeners", async () => {
        let count = 0;
        eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, () => count++);
        eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, () => count++);
        eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, () => count++);

        eventBus.emit(EVENTS.TEMPORAL_FACT_CREATED, {
            id: "fact_1",
            subject: "s",
            predicate: "p",
            object: "o",
            primarySector: "semantic",
            validFrom: 0,
            confidence: 1
        } as any);

        expect(count).toBe(3);
    });

    test("should catch errors in listeners without crashing emitter", async () => {
        eventBus.on(EVENTS.IDE_SUGGESTION, () => {
            throw new Error("Listener failed");
        });

        let secondListenerRun = false;
        eventBus.on(EVENTS.IDE_SUGGESTION, () => {
            secondListenerRun = true;
        });

        expect(() => {
            eventBus.emit(EVENTS.IDE_SUGGESTION, {
                sessionId: "test_session",
                count: 1,
                topPattern: { description: "test", salience: 1 } as any,
                context: {},
                timestamp: 0
            } as any);
        }).not.toThrow();

        expect(errorSpy).toHaveBeenCalled();
        expect(secondListenerRun).toBe(true);
    });

    test("once() should trigger only once", async () => {
        let count = 0;
        eventBus.once(EVENTS.MEMORY_UPDATED, () => count++);

        eventBus.emit(EVENTS.MEMORY_UPDATED, { id: "1" });
        eventBus.emit(EVENTS.MEMORY_UPDATED, { id: "1" });

        expect(count).toBe(1);
    });

    test("off() should remove listeners", async () => {
        let count = 0;
        const listener = () => count++;
        eventBus.on(EVENTS.MEMORY_UPDATED, listener);
        eventBus.off(EVENTS.MEMORY_UPDATED, listener);

        eventBus.emit(EVENTS.MEMORY_UPDATED, { id: "1" });

        expect(count).toBe(0);
    });
});
