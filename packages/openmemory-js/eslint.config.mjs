import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import bunNativeEnforcement from "./eslint-plugins/bun-native-enforcement.mjs";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            "unused-imports": unusedImports,
            "simple-import-sort": simpleImportSort,
            "bun-native": bunNativeEnforcement,
        },
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Disable standard unused vars to let plugin handle it
            "@typescript-eslint/no-unused-vars": "off",
            "no-unused-vars": "off",

            // Plugin rules
            "unused-imports/no-unused-imports": "error",
            "unused-imports/no-unused-vars": [
                "warn",
                {
                    "vars": "all",
                    "varsIgnorePattern": "^_",
                    "args": "after-used",
                    "argsIgnorePattern": "^_",
                },
            ],

            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",

            // Bun Native API Enforcement Rules
            "bun-native/no-node-fs": ["error", {
                "allowExceptions": [
                    "src/utils/compat", // Compatibility layer
                    "test/", // Allow in tests if needed for mocking
                    "scripts/" // Allow in build scripts
                ]
            }],
            "bun-native/prefer-bun-spawn": "error",
            "bun-native/prefer-bun-env": "warn",
            "bun-native/enforce-bun-file-patterns": "warn",

            "@typescript-eslint/no-floating-promises": "error",
            "no-console": ["warn", { allow: ["warn", "error"] }], // Prefer logger

            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-require-imports": "off",
            "no-undef": "off",
            "no-empty": "off",
            "no-useless-escape": "off"
        },
        ignores: ["dist/**", "node_modules/**", "eslint-plugins/**"]
    }
);
