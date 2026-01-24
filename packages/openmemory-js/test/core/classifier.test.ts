import { describe, test, expect } from "bun:test";
import { LearnedClassifier, ClassifierModel } from "../../src/core/learnedClassifier";

describe("Learned Classifier", () => {
    test("train() should handle empty data gracefully", async () => {
        await expect(LearnedClassifier.train([])).rejects.toThrow("Cannot train classifier with empty data");
    });

    test("train() should learn a simple pattern (XOR logic not guaranteed, but simple separation)", async () => {
        // Simple 2D separation:
        // Semantic: [1, 0]
        // Temporal: [0, 1]
        const data = [
            { vector: [1.0, 0.1], label: "semantic" },
            { vector: [0.9, 0.0], label: "semantic" },
            { vector: [0.1, 1.0], label: "temporal" },
            { vector: [0.0, 0.9], label: "temporal" },
        ];

        const model = await LearnedClassifier.train(data, undefined, 0.1, 50);

        expect(model).toBeDefined();
        expect(model.weights["semantic"]).toBeDefined();
        expect(model.weights["temporal"]).toBeDefined();

        // Verify prediction
        const resSem = LearnedClassifier.predict([1.0, 0.0], model);
        expect(resSem.primary).toBe("semantic");

        const resTemp = LearnedClassifier.predict([0.0, 1.0], model);
        expect(resTemp.primary).toBe("temporal");
    });

    test("dimension mismatch should reset model", async () => {
        const initialData = [{ vector: [1, 0], label: "A" }];
        const model1 = await LearnedClassifier.train(initialData);

        const newData = [{ vector: [1, 0, 0, 0], label: "A" }]; // Diff dimension

        // Should not throw, but reset weights and train new
        const model2 = await LearnedClassifier.train(newData, model1);

        expect(model2.weights["A"].length).toBe(4);
    });

    test("predict() should handle unknown sectors gracefully", async () => {
        const dummyModel: ClassifierModel = {
            userId: "u1",
            weights: { "A": [1, 1] },
            biases: { "A": 0 },
            version: 1,
            updatedAt: 0
        };

        const res = LearnedClassifier.predict([0.5, 0.5], dummyModel);
        expect(res.primary).toBe("A");
        expect(res.confidence).toBeGreaterThan(0);
    });
});
