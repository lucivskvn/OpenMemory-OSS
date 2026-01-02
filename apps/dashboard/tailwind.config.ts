import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                background: "#030712",
                foreground: "#f9fafb",
                primary: {
                    DEFAULT: "#0ea5e9",
                    foreground: "#f9fafb",
                },
                secondary: {
                    DEFAULT: "#8b5cf6",
                    foreground: "#f9fafb",
                },
                card: {
                    DEFAULT: "rgba(17, 24, 39, 0.7)",
                    foreground: "#f8fafc",
                }
            },
            backgroundImage: {
                "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
                "glass-gradient": "linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0))",
            },
            boxShadow: {
                "neon-blue": "0 0 15px rgba(14, 165, 233, 0.4)",
                "neon-purple": "0 0 15px rgba(139, 92, 246, 0.4)",
            }
        },
    },
    plugins: [],
};
export default config;
