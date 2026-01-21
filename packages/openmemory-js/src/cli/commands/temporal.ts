
import { CliFlags } from "../types";
import { ensureClient } from "../utils";

export const temporalCommands = {
    "add-fact": async (args: string[], flags: CliFlags) => {
        if (args.length < 3) throw new Error("S, P, O required");
        const api = await ensureClient(flags);
        const res = await api.temporal.add(args[0], args[1], args[2]);
        console.log(JSON.stringify(res, null, 2));
    },

    "search-facts": async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("Pattern required");
        const api = await ensureClient(flags);
        const res = await api.temporal.search(args[0], { type: flags.type });
        console.log(JSON.stringify(res, null, 2));
    },

    timeline: async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("Subject required");
        const api = await ensureClient(flags);
        const res = await api.temporal.history(args[0]);
        console.log(JSON.stringify(res, null, 2));
    },

    compare: async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("Subject required");
        const api = await ensureClient(flags);
        const t1 = args[1] ? new Date(args[1]) : new Date(Date.now() - 86400000);
        const t2 = args[2] ? new Date(args[2]) : new Date();
        const res = await api.temporal.compare(args[0], t1, t2);
        console.log(JSON.stringify(res, null, 2));
    }
};
