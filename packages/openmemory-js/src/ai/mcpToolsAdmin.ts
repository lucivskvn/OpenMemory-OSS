/**
 * @file mcpToolsAdmin.ts
 * @description Administrative tools registration for the MCP server.
 * @audited 2026-01-19
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Memory } from "../core/memory";
import {
    AuditQuerySchema,
    WebhookCreateSchema,
    WebhookListSchema,
    WebhookDeleteSchema,
    WebhookTestSchema,
    MetricsQuerySchema,
    BulkDeleteSchema,
    BulkUpdateSchema,
    HealthCheckSchema,
} from "./schemas";
import { verifyContext } from "../core/context";
import { webhookService } from "../core/services/webhooks";
import { auditService } from "../core/services/audit";

export const registerAdminTools = (srv: McpServer, mem: Memory): void => {
    srv.tool(
        "openmemory_admin_audit_query",
        "Query system audit logs for security and compliance monitoring",
        AuditQuerySchema.shape,
        async (args: z.infer<typeof AuditQuerySchema>) => {
            const userId = verifyContext(args.userId) as string;
            const logs = await auditService.query(args);
            return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_admin_webhook_create",
        "Create a new administrative webhook for system events",
        WebhookCreateSchema.shape,
        async (args: z.infer<typeof WebhookCreateSchema>) => {
            const userId = verifyContext(args.userId) as string;
            const hook = await webhookService.create(userId, args.url, args.events, args.secret);
            return { content: [{ type: "text", text: JSON.stringify(hook, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_admin_webhook_list",
        "List all active webhooks for the user",
        WebhookListSchema.shape,
        async (args: z.infer<typeof WebhookListSchema>) => {
            const userId = verifyContext(args.userId) as string;
            const hooks = await webhookService.list(userId, args.limit);
            return { content: [{ type: "text", text: JSON.stringify(hooks, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_admin_webhook_delete",
        "Delete a specific webhook",
        WebhookDeleteSchema.shape,
        async (args: z.infer<typeof WebhookDeleteSchema>) => {
            const userId = verifyContext(args.userId) as string;
            await webhookService.delete(args.id, userId);
            return { content: [{ type: "text", text: `Deleted webhook ${args.id}` }] };
        },
    );

    srv.tool(
        "openmemory_admin_webhook_test",
        "Test a webhook by sending a ping event",
        WebhookTestSchema.shape,
        async (args: z.infer<typeof WebhookTestSchema>) => {
            const userId = verifyContext(args.userId) as string;
            const res = await webhookService.test(args.id, userId);
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        },
    );

    srv.tool(
        "openmemory_admin_metrics",
        "Retrieve system performance and usage metrics",
        MetricsQuerySchema.shape,
        async (args: z.infer<typeof MetricsQuerySchema>) => {
            const userId = verifyContext(args.userId) as string;
            // Internal metrics logic here
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ status: "ok", metrics: [] }, null, 2),
                    },
                ],
            };
        },
    );

    srv.tool(
        "openmemory_admin_bulk_delete",
        "Bulk delete multiple memories (max 1000 per request)",
        BulkDeleteSchema.shape,
        async (args: z.infer<typeof BulkDeleteSchema>) => {
            const userId = verifyContext(args.userId) as string;
            const count = await mem.deleteBatch(args.memoryIds, userId);
            return { content: [{ type: "text", text: `Bulk deleted ${count} memories` }] };
        },
    );

    srv.tool(
        "openmemory_admin_bulk_update",
        "Bulk update metadata or tags for multiple memories",
        BulkUpdateSchema.shape,
        async (args: z.infer<typeof BulkUpdateSchema>) => {
            const userId = verifyContext(args.userId) as string;
            const count = await mem.updateBatch(args.memoryIds, {
                content: args.content,
                tags: args.tags,
                metadata: args.metadata
            }, userId);
            return { content: [{ type: "text", text: `Bulk updated ${count} memories` }] };
        },
    );

    srv.tool(
        "openmemory_health_check",
        "Check system health and dependency status",
        HealthCheckSchema.shape,
        async (args: z.infer<typeof HealthCheckSchema>) => {
            const stats = await mem.stats();
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ status: "healthy", stats, ...args }, null, 2),
                    },
                ],
            };
        },
    );
};
