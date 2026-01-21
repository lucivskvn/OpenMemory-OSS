import { Context } from "elysia";
import { UserContext } from "../core/types";

// Helper type to shim Elysia's Context when using the Auth Plugin
// usage: async ({ user, body }: AuthContext) => ...
export type AuthContext = {
    user: UserContext | undefined;
    store: {
        user?: UserContext;
        [key: string]: any;
    };
} & Partial<Context>;
