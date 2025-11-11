import { describe, it, expect } from "bun:test";
import { getEmbeddingInfo } from "../../backend/src/memory/embed";

describe("embed provider info", () => {
    it("returns provider metadata", () => {
        const info = getEmbeddingInfo();
        expect(info).toHaveProperty("provider");
        expect(info).toHaveProperty("dimensions");
        expect(typeof info.dimensions).toBe("number");
    });
});
