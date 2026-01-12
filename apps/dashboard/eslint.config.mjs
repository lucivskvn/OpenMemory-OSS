import js from "@eslint/js";

export default [
    {
        ignores: [".next/", "**/node_modules/"],
    },
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                // Mock globals if package not present, or assume standard env
                window: "readonly",
                document: "readonly",
                console: "readonly",
                module: "readonly",
                process: "readonly",
            }
        }
    }
];
