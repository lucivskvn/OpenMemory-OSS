
import { CliFlags } from "../types";
import { ensureClient } from "../utils";

export const coreCommands = {
    add: async (args: string[], flags: CliFlags) => {
        if (args.length === 0) throw new Error("Content required");
        const api = await ensureClient(flags);
        const res = await api.add(args[0], {
            tags: flags.tags ? flags.tags.split(",") : [],
            userId: flags.userId,
            primarySector: flags.sector as any
        });
        console.log(JSON.stringify(res, null, 2));
    },

    search: async (args: string[], flags: CliFlags) => {
        if (args.length === 0) throw new Error("Query required");
        const api = await ensureClient(flags);
        const res = await api.search(args[0], {
            limit: parseInt(flags.limit || "10"),
            userId: flags.userId,
            type: flags.type,
            minSalience: flags.minSalience ? parseFloat(flags.minSalience) : undefined
        });

        if (Array.isArray(res)) {
            console.log(`\x1b[36mFound ${res.length} matches:\x1b[0m\n`);
            res.forEach((h: any, idx: number) => {
                console.log(`\x1b[1m${idx + 1}.\x1b[0m [${h.primarySector || '?'}] ${h.content?.slice(0, 100)}${h.content?.length > 100 ? "..." : ""}`);
                console.log(`   \x1b[90mID: ${h.id} | Score: ${h.score?.toFixed(4)}\x1b[0m\n`);
            });
        } else {
            console.log(JSON.stringify(res, null, 2));
        }
    },

    delete: async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("ID required");
        const api = await ensureClient(flags);
        const res = await api.delete(args[0]);
        if (res) {
            console.log(JSON.stringify({ success: true, id: args[0], deleted: true }, null, 2));
        } else {
            console.error("Delete failed or not found.");
            process.exit(1);
        }
    },

    update: async (args: string[], flags: CliFlags) => {
        if (args.length < 2) throw new Error("ID and Content required");
        const api = await ensureClient(flags);
        const res = await api.update(args[0], args[1]);
        // Handle both object return (legacy/future) and boolean return (current adapter)
        const success = typeof res === 'boolean' ? res : (res && (res.ok || res.success));

        if (success) {
            const updated = await api.get(args[0]);
            console.log(JSON.stringify(updated, null, 2));
        } else {
            console.error("Update failed.");
            console.log(JSON.stringify(res, null, 2));
            process.exit(1);
        }
    },

    "delete-all": async (args: string[], flags: CliFlags) => {
        const api = await ensureClient(flags);
        const userId = flags.userId;

        if (!userId && !flags.force) {
            const readline = await import("readline/promises");
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const ans = await rl.question("WARNING: No user specified. This will delete ALL memories. Type 'CONFIRM' to proceed: ");
            rl.close();
            if (ans !== "CONFIRM") {
                console.error("Aborted.");
                process.exit(1);
            }
        }
        const count = await api.deleteAll(userId);
        console.log(JSON.stringify({ success: true, count }, null, 2));
    }
};
