/**
 * @file Metrics Middleware
 * Automatically tracks API endpoint performance metrics
 */

import { Elysia } from "elysia";
import { metricsCollector } from "../../utils/metricsCollector";
import { logger } from "../../utils/logger";

/**
 * Middleware to automatically track API endpoint performance
 */
export const metricsMiddleware = (app: Elysia) => app
    .onBeforeHandle(({ request, store }) => {
        // Store request start time
        (store as any).requestStartTime = Date.now();
    })
    .onAfterHandle(({ request, set, store }) => {
        try {
            const startTime = (store as any).requestStartTime;
            if (!startTime) return;

            const duration = Date.now() - startTime;
            const url = new URL(request.url);
            const endpoint = url.pathname;
            const method = request.method;
            const statusCode = set.status || 200;

            // Get client info
            const userAgent = request.headers.get('user-agent') || undefined;
            const ip = request.headers.get('x-forwarded-for') || 
                      request.headers.get('x-real-ip') || 
                      undefined;

            // Record the API endpoint metrics
            metricsCollector.recordApiEndpoint({
                endpoint,
                method,
                statusCode,
                duration,
                userAgent,
                ip
            });

            // Log slow requests
            if (duration > 5000) { // > 5 seconds
                logger.warn(`[METRICS] Slow API request detected`, {
                    endpoint,
                    method,
                    duration,
                    statusCode
                });
            }
        } catch (error) {
            logger.error('[METRICS] Failed to record API metrics:', error);
        }
    })
    .onError(({ request, error, set, store }) => {
        try {
            const startTime = (store as any).requestStartTime;
            if (!startTime) return;

            const duration = Date.now() - startTime;
            const url = new URL(request.url);
            const endpoint = url.pathname;
            const method = request.method;
            const statusCode = set.status || 500;

            // Get client info
            const userAgent = request.headers.get('user-agent') || undefined;
            const ip = request.headers.get('x-forwarded-for') || 
                      request.headers.get('x-real-ip') || 
                      undefined;

            // Record the failed API endpoint metrics
            metricsCollector.recordApiEndpoint({
                endpoint,
                method,
                statusCode,
                duration,
                userAgent,
                ip
            });

            logger.error(`[METRICS] API request failed`, {
                endpoint,
                method,
                duration,
                statusCode,
                error: error.message
            });
        } catch (metricsError) {
            logger.error('[METRICS] Failed to record API error metrics:', metricsError);
        }
    });

/**
 * Middleware to periodically record system resource metrics
 */
export const systemMetricsMiddleware = (app: Elysia) => {
    // Record system metrics every 30 seconds
    const interval = setInterval(() => {
        try {
            metricsCollector.recordSystemResources();
        } catch (error) {
            logger.error('[METRICS] Failed to record system metrics:', error);
        }
    }, 30000);

    // Cleanup on app shutdown
    process.on('SIGTERM', () => clearInterval(interval));
    process.on('SIGINT', () => clearInterval(interval));

    return app;
};