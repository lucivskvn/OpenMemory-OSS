import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";
import simpleImportSort from "eslint-plugin-simple-import-sort";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            "unused-imports": unusedImports,
            "simple-import-sort": simpleImportSort,
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

            "@typescript-eslint/no-floating-promises": "error",
            "no-console": ["warn", { allow: ["warn", "error"] }], // Prefer logger

            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-require-imports": "off",
            "no-undef": "off",
            "no-empty": "off",
            "no-useless-escape": "off"
        },
        ignores: ["dist/**", "node_modules/**"]
    }
);
