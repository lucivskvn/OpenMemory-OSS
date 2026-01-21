
import { CliFlags } from "./types";

export function parseArgs(rawArgs: string[]): { command: string; args: string[]; flags: CliFlags } {
    const args: string[] = [];
    const flags: CliFlags = {};
    let command = rawArgs[0];

    // Handle "mcp start" as a sub-command conceptual
    if (command === "mcp" && rawArgs[1]) {
        // Keep as is, handled by command logic
    }

    for (let i = 1; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg.startsWith("--")) {
            const rawKey = arg.substring(2);
            // Convert kebab-case to camelCase
            const key = rawKey.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

            // Check if next arg is value
            const nextArg = rawArgs[i + 1];
            const hasValue = nextArg && !nextArg.startsWith("--");
            const val = hasValue ? nextArg : "true";

            flags[key] = val;
            if (hasValue) i++;
        } else if (arg.startsWith("-")) {
            // Short flags (e.g. -h)
            if (arg === '-h') flags.help = "true";
        } else {
            args.push(arg);
        }
    }

    return { command, args, flags };
}
