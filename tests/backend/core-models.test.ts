import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

/**
 * Model Configuration Tests
 * 
 * Tests YAML parsing, model loading, sector mapping, and fallback logic
 * for backend/src/core/models.ts
 */

describe("Model Configuration (models.ts)", () => {
    const testModelsPath = join(__dirname, "../../backend/src/../../../models.yml");
    let originalModelsYml: string | null = null;

    beforeEach(() => {
        // Backup original models.yml if it exists
        if (existsSync(testModelsPath)) {
            originalModelsYml = require("fs").readFileSync(testModelsPath, "utf-8");
        }
        // Ensure models module reads our test path
        process.env.OM_MODELS_PATH = testModelsPath;

        // Clear module cache to force reload
        try {
            delete require.cache[require.resolve("../../backend/src/core/models")];
        } catch { }
    });

    describe("load_models - Default Configuration", () => {
        test("loads default config when models.yml missing", () => {
            // Ensure no models.yml exists
            if (existsSync(testModelsPath)) {
                unlinkSync(testModelsPath);
            }

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            expect(config).toBeDefined();
            expect(config.episodic).toBeDefined();
            expect(config.semantic).toBeDefined();
            expect(config.procedural).toBeDefined();
            expect(config.emotional).toBeDefined();
            expect(config.reflective).toBeDefined();
        });

        test("default config has all required sectors", () => {
            if (existsSync(testModelsPath)) {
                unlinkSync(testModelsPath);
            }

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            const requiredSectors = ["episodic", "semantic", "procedural", "emotional", "reflective"];
            for (const sector of requiredSectors) {
                expect(config[sector]).toBeDefined();
            }
        });

        test("default config has all required providers", () => {
            if (existsSync(testModelsPath)) {
                unlinkSync(testModelsPath);
            }

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            const requiredProviders = ["ollama", "openai", "gemini", "local"];
            for (const sector of Object.keys(config)) {
                for (const provider of requiredProviders) {
                    expect(config[sector][provider]).toBeDefined();
                    expect(typeof config[sector][provider]).toBe("string");
                }
            }
        });

        test("default config uses sensible models", () => {
            if (existsSync(testModelsPath)) {
                unlinkSync(testModelsPath);
            }

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            // Check common default models
            expect(config.episodic.ollama).toBe("nomic-embed-text");
            expect(config.episodic.openai).toBe("text-embedding-3-small");
            expect(config.episodic.local).toBe("all-MiniLM-L6-v2");
        });
    });

    describe("load_models - YAML Parsing", () => {
        test("parses valid YAML configuration", () => {
            const validYaml = `
episodic:
  ollama: test-ollama-model
  openai: test-openai-model
  gemini: test-gemini-model
  local: test-local-model

semantic:
  ollama: semantic-ollama
  openai: semantic-openai
  gemini: semantic-gemini
  local: semantic-local
`;
            writeFileSync(testModelsPath, validYaml);

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            expect(config.episodic.ollama).toBe("test-ollama-model");
            expect(config.episodic.openai).toBe("test-openai-model");
            expect(config.semantic.ollama).toBe("semantic-ollama");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles YAML with comments", () => {
            const yamlWithComments = `
# Model configuration
episodic:
  ollama: model1  # This is a comment
  openai: model2
  # Another comment
  gemini: model3
  local: model4
`;
            writeFileSync(testModelsPath, yamlWithComments);

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            expect(config.episodic.ollama).toBe("model1");
            expect(config.episodic.openai).toBe("model2");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles YAML with empty lines", () => {
            const yamlWithEmptyLines = `
episodic:
  ollama: model1

  openai: model2


  gemini: model3
  local: model4
`;
            writeFileSync(testModelsPath, yamlWithEmptyLines);

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            expect(config.episodic.ollama).toBe("model1");
            expect(config.episodic.openai).toBe("model2");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles models with colons in names", () => {
            const yaml = `
episodic:
  ollama: registry.hub.docker.com/model:latest
  openai: model:v1
  gemini: models/embedding-001
  local: local-model
`;
            writeFileSync(testModelsPath, yaml);

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            expect(config.episodic.ollama).toBe("registry.hub.docker.com/model:latest");
            expect(config.episodic.openai).toBe("model:v1");
            expect(config.episodic.gemini).toBe("models/embedding-001");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("falls back to defaults on parse error", () => {
            const invalidYaml = "this is not: valid: yaml: at: all:";
            writeFileSync(testModelsPath, invalidYaml);

            const { load_models } = require("../../backend/src/core/models");
            const config = load_models();

            // Should return defaults
            expect(config.episodic).toBeDefined();
            expect(config.episodic.ollama).toBe("nomic-embed-text");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });
    });

    describe("load_models - Caching", () => {
        test("caches configuration after first load", () => {
            const yaml = `
episodic:
  ollama: cached-model
  openai: test-model
  gemini: test-model
  local: test-model
`;
            writeFileSync(testModelsPath, yaml);

            const { load_models } = require("../../backend/src/core/models");
            const config1 = load_models();
            expect(config1.episodic.ollama).toBe("cached-model");

            // Modify file
            const newYaml = `
episodic:
  ollama: new-model
  openai: test-model
  gemini: test-model
  local: test-model
`;
            writeFileSync(testModelsPath, newYaml);

            // Load again - should return cached version
            const config2 = load_models();
            expect(config2.episodic.ollama).toBe("cached-model");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });
    });

    describe("get_model - Model Selection", () => {
        test("retrieves model for valid sector and provider", () => {
            const yaml = `
episodic:
  ollama: episodic-ollama-model
  openai: episodic-openai-model
  gemini: episodic-gemini-model
  local: episodic-local-model
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toBe("episodic-ollama-model");
            expect(get_model("episodic", "openai")).toBe("episodic-openai-model");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("falls back to semantic sector for unknown sector", () => {
            const yaml = `
semantic:
  ollama: semantic-fallback
  openai: semantic-openai
  gemini: semantic-gemini
  local: semantic-local
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            const model = get_model("unknown_sector", "ollama");
            expect(model).toBe("semantic-fallback");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("falls back to nomic-embed-text for unknown provider", () => {
            const yaml = `
episodic:
  ollama: test-model
  openai: test-model
  gemini: test-model
  local: test-model
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            const model = get_model("episodic", "unknown_provider");
            expect(model).toBe("nomic-embed-text");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles all standard sectors", () => {
            const yaml = `
episodic:
  ollama: episodic-model
  openai: test
  gemini: test
  local: test
semantic:
  ollama: semantic-model
  openai: test
  gemini: test
  local: test
procedural:
  ollama: procedural-model
  openai: test
  gemini: test
  local: test
emotional:
  ollama: emotional-model
  openai: test
  gemini: test
  local: test
reflective:
  ollama: reflective-model
  openai: test
  gemini: test
  local: test
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toBe("episodic-model");
            expect(get_model("semantic", "ollama")).toBe("semantic-model");
            expect(get_model("procedural", "ollama")).toBe("procedural-model");
            expect(get_model("emotional", "ollama")).toBe("emotional-model");
            expect(get_model("reflective", "ollama")).toBe("reflective-model");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles all standard providers", () => {
            const yaml = `
episodic:
  ollama: ollama-model
  openai: openai-model
  gemini: gemini-model
  local: local-model
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toBe("ollama-model");
            expect(get_model("episodic", "openai")).toBe("openai-model");
            expect(get_model("episodic", "gemini")).toBe("gemini-model");
            expect(get_model("episodic", "local")).toBe("local-model");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });
    });

    describe("Integration - Real-World Scenarios", () => {
        test("handles production-like configuration", () => {
            const prodYaml = `
episodic:
  ollama: nomic-embed-text
  openai: text-embedding-3-small
  gemini: models/embedding-001
  local: all-MiniLM-L6-v2

semantic:
  ollama: nomic-embed-text
  openai: text-embedding-3-small
  gemini: models/embedding-001
  local: all-MiniLM-L6-v2

procedural:
  ollama: nomic-embed-text
  openai: text-embedding-3-small
  gemini: models/embedding-001
  local: all-MiniLM-L6-v2

emotional:
  ollama: nomic-embed-text
  openai: text-embedding-3-small
  gemini: models/embedding-001
  local: all-MiniLM-L6-v2

reflective:
  ollama: nomic-embed-text
  openai: text-embedding-3-large
  gemini: models/embedding-001
  local: all-mpnet-base-v2
`;
            writeFileSync(testModelsPath, prodYaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { load_models, get_model } = require("../../backend/src/core/models");

            const config = load_models();
            expect(Object.keys(config).length).toBe(5);

            // Verify reflective uses larger model for OpenAI
            expect(get_model("reflective", "openai")).toBe("text-embedding-3-large");
            expect(get_model("episodic", "openai")).toBe("text-embedding-3-small");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles custom model names", () => {
            const customYaml = `
episodic:
  ollama: custom/model:v2.0
  openai: ada-002
  gemini: models/text-embedding-004
  local: sentence-transformers/all-MiniLM-L6-v2
`;
            writeFileSync(testModelsPath, customYaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toContain("custom/model");
            expect(get_model("episodic", "local")).toContain("sentence-transformers");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles minimal configuration with fallbacks", () => {
            const minimalYaml = `
episodic:
  ollama: minimal-model
  openai: minimal-model
  gemini: minimal-model
  local: minimal-model
`;
            writeFileSync(testModelsPath, minimalYaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            // Defined sector
            expect(get_model("episodic", "ollama")).toBe("minimal-model");

            // Undefined sector falls back to semantic (then default)
            const fallbackModel = get_model("semantic", "ollama");
            expect(fallbackModel).toBeDefined();

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });
    });

    describe("Edge Cases", () => {
        test("handles YAML with extra whitespace", () => {
            const yaml = `
episodic:
    ollama:   model-with-spaces  
    openai:model-no-space
    gemini:    models/test   
    local: normal-model
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toBe("model-with-spaces");
            expect(get_model("episodic", "openai")).toBe("model-no-space");

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles empty YAML file", () => {
            writeFileSync(testModelsPath, "");

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { load_models } = require("../../backend/src/core/models");

            const config = load_models();
            // Should fall back to defaults
            expect(config.episodic).toBeDefined();

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });

        test("handles sector with missing providers", () => {
            const yaml = `
episodic:
  ollama: test-model
  # openai missing
  gemini: test-model
  # local missing
`;
            writeFileSync(testModelsPath, yaml);

            delete require.cache[require.resolve("../../backend/src/core/models")];
            const { get_model } = require("../../backend/src/core/models");

            expect(get_model("episodic", "ollama")).toBe("test-model");
            // Missing provider should fall back
            expect(get_model("episodic", "openai")).toBeDefined();

            // Cleanup
            if (originalModelsYml) {
                writeFileSync(testModelsPath, originalModelsYml);
            } else {
                unlinkSync(testModelsPath);
            }
        });
    });
});
