import { describe, test, expect, spyOn, mock } from "bun:test";
import { classifyContent, computeSimhash, extractEssence } from "../../src/memory/hsg";
import { sectorConfigs } from "../../src/core/hsg_config";

describe("HSG Strict Typing & Logic", () => {
    test("classifyContent should return valid structure", () => {
        const c = classifyContent("I remember when I went to the store yesterday.");
        expect(c.primary).toBe("episodic");
        // Check confidence calculation involves division, results in number <= 1
        expect(c.confidence).toBeGreaterThan(0);
        expect(c.confidence).toBeLessThanOrEqual(1);
    });

    test("classifyContent should handle metadata override", () => {
        const c = classifyContent("Some text", { sector: "procedural" });
        expect(c.primary).toBe("procedural");
        expect(c.confidence).toBe(1.0);
    });

    test("computeSimhash should return 64-char string", () => {
        const h = computeSimhash("hello world");
        expect(h).toHaveLength(64);
        expect(/^[01]+$/.test(h)).toBe(true);
    });

    test("extractEssence should respect max length", () => {
        const text = "Sentence one. Sentence two. Sentence three. Sentence four.";
        const ess = extractEssence(text, 20); // very short
        expect(ess.length).toBeLessThanOrEqual(25); // + margin for words
    });
});
