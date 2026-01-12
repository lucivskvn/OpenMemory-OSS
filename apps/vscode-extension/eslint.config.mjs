import js from "@eslint/js";
import tseslint from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";

export default tseslint.config(
    {
        ignores: ["out/**", "dist/**", "**/*.d.ts", "node_modules/**", "src/test/**", "postinstall.js"]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
            },
        },
        rules: {
            "@typescript-eslint/naming-convention": [
                "warn",
                {
                    "selector": "import",
                    "format": ["camelCase", "PascalCase"]
                }
            ],
            // Note: standard "semi" rule is preferred in modern ESLint, or use stylistic plugin if needed. 
            // typescript-eslint v8 recommends using the stylistic config for formatting rules, but for now we keep it simple.
            "semi": ["warn", "always"],
            "eqeqeq": "warn",
            "no-throw-literal": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", {
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_"
            }]
        }
    }
);
