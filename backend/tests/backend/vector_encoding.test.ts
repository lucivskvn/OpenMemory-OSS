import { describe, it, expect } from "bun:test";
import { bufferToVector, vectorToBuffer } from "../../src/memory/embed";

describe("Vector encoding", () => {
    it("vectorToBuffer and bufferToVector roundtrip", () => {
        const v = [1.5, -2.25, 3.125];
        const b = vectorToBuffer(v);
        const out = bufferToVector(b);
        expect(out.length).toBe(v.length);
        for (let i = 0; i < v.length; i++) expect(out[i]).toBeCloseTo(v[i], 6);
    });

    it("latin1 string roundtrip preserves bytes", () => {
        const v = [0.1, 0.2, 0.3];
        const b = vectorToBuffer(v);
        const s = b.toString("latin1");
        const b2 = Buffer.from(s, "latin1");
        const out = bufferToVector(b2);
        expect(out.length).toBe(v.length);
        for (let i = 0; i < v.length; i++) expect(out[i]).toBeCloseTo(v[i], 6);
    });
});
