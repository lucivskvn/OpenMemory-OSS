/**
 * @file Request Tracing Middleware for ElysiaJS
 * Provides correlation ID tracking and request tracing across API endpoints
 */

import { Elysia } from "elysia";
import { 
    runWithTrace, 
    extractTraceFromHeaders, 
    injectTraceIntoHeaders,
    generateTraceId,
    generateSpanId,
    type TraceContext 
} from "../../utils/logger";
import { logger } from "../../utils/logger";

export interface TracingConfig {
    /**
     * Whether to generate trace IDs for requests that don't have them
     */
    generateTraceIds?: boolean;
    
    /**
     * Whether to log request start/end
     */
    logRequests?: boolean;
    
    /**
     * Whether to include response time in logs
     */
    includeResponseTime?: boolean;
    
    /**
     * Paths to exclude from tracing (e.g., health checks)
     */
    excludePaths?: string[];
}

const DEFAULT_CONFIG: TracingConfig = {
    generateTraceIds: true,
    logRequests: true,
    includeResponseTime: true,
    excludePaths: ['/health', '/favicon.ico'],
};

/**
 * ElysiaJS middleware for request tracing and correlation ID management
 */
export function tracingMiddleware(config: TracingConfig = {}) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    
    const app = new Elysia({ name: 'tracing' })
        .derive(({ request, set }) => {
            const url = new URL(request.url);
            const path = url.pathname;
            
            // Skip tracing for excluded paths
            if (finalConfig.excludePaths?.includes(path)) {
                return {};
            }
            
            // Extract trace context from headers
            const headers: Record<string, string | undefined> = {};
            request.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });
            
            const extractedTrace = extractTraceFromHeaders(headers);
            
            // Create trace context for this request
            const traceContext: TraceContext = {
                traceId: extractedTrace.traceId || (finalConfig.generateTraceIds ? generateTraceId() : ''),
                spanId: generateSpanId(),
                parentSpanId: extractedTrace.parentSpanId,
                userId: extractedTrace.userId,
                requestId: extractedTrace.requestId || generateTraceId(),
                operation: `${request.method} ${path}`,
                startTime: Date.now(),
                metadata: {
                    method: request.method,
                    path,
                    userAgent: headers['user-agent'],
                    ip: headers['x-forwarded-for'] || headers['x-real-ip'] || 'unknown',
                }
            };
            
            // Inject trace headers into response
            const traceHeaders = injectTraceIntoHeaders(traceContext);
            Object.entries(traceHeaders).forEach(([key, value]) => {
                set.headers[key] = value;
            });
            
            return { traceContext };
        })
        .onRequest(({ traceContext }) => {
            if (!traceContext) return;
            
            return runWithTrace(traceContext, () => {
                if (finalConfig.logRequests) {
                    logger.info('Request started', {
                        method: traceContext.metadata?.method,
                        path: traceContext.metadata?.path,
                        userAgent: traceContext.metadata?.userAgent,
                        ip: traceContext.metadata?.ip,
                    });
                }
            });
        });
    
    // Add onAfterResponse handler separately to avoid chaining issues
    app.onAfterResponse(({ traceContext, set }) => {
        if (!traceContext) return;
        
        return runWithTrace(traceContext, () => {
            if (finalConfig.logRequests) {
                const duration = Date.now() - (traceContext.startTime || 0);
                const statusCode = set.status || 200;
                
                logger.info('Request completed', {
                    method: traceContext.metadata?.method,
                    path: traceContext.metadata?.path,
                    statusCode,
                    duration: finalConfig.includeResponseTime ? duration : undefined,
                    success: statusCode < 400,
                });
            }
        });
    });
    
    // Add onError handler separately
    app.onError(({ error, traceContext, set }) => {
        if (!traceContext) return;
        
        return runWithTrace(traceContext, () => {
            const duration = Date.now() - (traceContext.startTime || 0);
            const statusCode = set.status || 500;
            
            logger.error('Request failed', {
                method: traceContext.metadata?.method,
                path: traceContext.metadata?.path,
                statusCode,
                duration: finalConfig.includeResponseTime ? duration : undefined,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        });
    });
    
    return app;
}

/**
 * Helper to run a function within the current request's trace context
 */
export function withRequestTrace<T>(fn: () => T | Promise<T>): T | Promise<T> {
    // The trace context is automatically available via AsyncLocalStorage
    // This is just a convenience function for explicit tracing
    return fn();
}

/**
 * Helper to create a child operation within the current request trace
 */
export function traceOperation<T>(
    operation: string,
    fn: () => T | Promise<T>,
    metadata?: Record<string, unknown>
): T | Promise<T> {
    return logger.traceOperation(operation, async () => {
        const result = fn();
        return result instanceof Promise ? await result : result;
    }, metadata);
}