
import { env } from "../core/cfg";

export function enforce_tenant(user_id?: string): string {
    if (user_id) return user_id;
    if (process.env.OM_ALLOW_ANONYMOUS_TENANT === "true") {
        return "anonymous";
    }
    throw new Error("MissingTenantError: user_id is required for multi-tenant isolation.");
}
