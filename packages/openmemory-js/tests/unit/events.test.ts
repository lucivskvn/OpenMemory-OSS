
import { describe, it, expect, mock } from "bun:test";
import { eventBus, EVENTS } from "../../src/core/events";

describe("Core EventBus", () => {
    it("should emit and receive MEMORY_ADDED events", async () => {
        const received = new Promise<any>((resolve) => {
            eventBus.once(EVENTS.MEMORY_ADDED, (data) => resolve(data));
        });

        // Conforms to MemoryAddedPayload
        const payload = {
            id: "123",
            content: "test",
            primarySector: "declarative" as const,
            userId: "user-1"
        };
        eventBus.emit(EVENTS.MEMORY_ADDED, payload);

        const result = await received;
        expect(result).toEqual(payload);
    });

    it("should emit and receive IDE_SUGGESTION events", async () => {
        const received = new Promise<any>((resolve) => {
            eventBus.once(EVENTS.IDE_SUGGESTION, (data) => resolve(data));
        });

        const payload = {
            sessionId: "sess-1",
            count: 5,
            topPattern: {
                patternId: "p1",
                description: "foo",
                salience: 0.8,
                detectedAt: 1234567890,
                lastReinforced: 1234567890
            },
            userId: "dev-1"
        };
        eventBus.emit(EVENTS.IDE_SUGGESTION, payload);

        const result = await received;
        expect(result).toEqual(payload);
    });

    it("should support multiple listeners", () => {
        let count = 0;
        const listener = () => count++;

        // Cast to any to test internal behavior with dynamic events if needed, 
        // or usage of a valid event key. We use a valid key here for type safety if possible
        // but 'test_event' is not in map. We cast to ignore.
        const bus = eventBus as any;
        const evt = "test_event";

        bus.on(evt, listener);
        bus.on(evt, listener);

        bus.emit(evt, {});
        // EventEmitter behavior: addEventListener adds it twice if called twice usually?
        // Node's EventEmitter does.

        expect(bus.listenerCount(evt)).toBe(2);

        // Cleanup
        bus.removeAllListeners(evt);
        expect(bus.listenerCount(evt)).toBe(0);
    });
});
