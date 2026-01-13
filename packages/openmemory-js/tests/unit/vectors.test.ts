import { describe, expect, test } from "bun:test";
import { aggregateVectors, cosineSimilarity } from "../../src/utils/vectors";

describe("Vector Utilities", () => {
    test("aggregateVectors computes mean correctly", () => {
        const v1 = [1, 2, 3];
        const v2 = [3, 4, 5];
        const res = aggregateVectors([v1, v2]);
        expect(res[0]).toBeCloseTo(2);
        expect(res[1]).toBeCloseTo(3);
        expect(res[2]).toBeCloseTo(4);
    });

    test("aggregateVectors handles mismatched dimensions safely", () => {
        const v1 = [1, 2, 3];
        const v2 = [4, 5]; // Wrong dim
        const v3 = [3, 2, 1];

        // v2 should be ignored. Mean of v1 and v3: (1+3)/2=2, (2+2)/2=2, (3+1)/2=2
        const res = aggregateVectors([v1, v2, v3]);
        expect(res).toEqual([2, 2, 2]);
    });

    test("aggregateVectors handles all invalid vectors", () => {
        const v1 = [1];
        const v2 = [1, 2];
        // v2 has mismatch dim. Count=1. Res=[1].
        const res = aggregateVectors([v1, v2]);
        expect(res).toEqual([1]);
    });

    test("cosineSimilarity basics", () => {
        const v1 = [1, 0];
        const v2 = [0, 1];
        expect(cosineSimilarity(v1, v2)).toBe(0);

        const v3 = [1, 1];
        expect(cosineSimilarity(v1, v3)).toBeCloseTo(0.707);
    });
});
