import { Elysia } from "elysia";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { AppError } from "../errors";

/**
 * API Version Configuration
 */
export interface ApiVersionConfig {
    version: string;
    supportedUntil?: Date;
    deprecated?: boolean;
    deprecationMessage?: string;
    migrationGuide?: string;
}

/**
 * API Version Registry
 */
export const API_VERSIONS: Record<string, ApiVersionConfig> = {
    "v1": {
        version: "1.0.0",
        deprecated: false,
    },
    "v2": {
        version: "2.0.0",
        deprecated: false,
    },
    // Legacy versions with deprecation warnings
    "legacy": {
        version: "0.9.0",
        deprecated: true,
        supportedUntil: new Date("2026-12-31"),
        deprecationMessage: "Legacy API version is deprecated. Please migrate to v1 or v2.",
        migrationGuide: "https://docs.openmemory.ai/migration/legacy-to-v1"
    }
};

/**
 * Default API version when none is specified
 */
export const DEFAULT_API_VERSION = "v1";

/**
 * Extract API version from request
 */
export function extractApiVersion(request: Request): string {
    // 1. Check Accept header (preferred)
    const acceptHeader = request.headers.get("Accept");
    if (acceptHeader) {
        const versionMatch = acceptHeader.match(/application\/vnd\.openmemory\.([^+]+)/);
        if (versionMatch) {
            return versionMatch[1];
        }
    }

    // 2. Check X-API-Version header
    const versionHeader = request.headers.get("X-API-Version");
    if (versionHeader) {
        return versionHeader;
    }

    // 3. Check URL path prefix
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/^\/api\/([^\/]+)\//);
    if (pathMatch && API_VERSIONS[pathMatch[1]]) {
        return pathMatch[1];
    }

    // 4. Default version
    return DEFAULT_API_VERSION;
}

/**
 * Validate API version compatibility
 */
export function validateApiVersion(version: string): ApiVersionConfig {
    const config = API_VERSIONS[version];
    if (!config) {
        throw new AppError(400, "UNSUPPORTED_API_VERSION", 
            `API version '${version}' is not supported. Supported versions: ${Object.keys(API_VERSIONS).join(", ")}`);
    }

    // Check if version is still supported
    if (config.supportedUntil && new Date() > config.supportedUntil) {
        throw new AppError(410, "API_VERSION_EXPIRED", 
            `API version '${version}' is no longer supported. ${config.migrationGuide ? `Migration guide: ${config.migrationGuide}` : ""}`);
    }

    return config;
}

/**
 * API Version Middleware Plugin
 */
export const apiVersioningPlugin = (app: Elysia) => app
    .derive(({ request, set }) => {
        const apiVersion = extractApiVersion(request);
        const versionConfig = validateApiVersion(apiVersion);

        // Add deprecation warning headers for deprecated versions
        if (versionConfig.deprecated) {
            set.headers["X-API-Deprecation-Warning"] = versionConfig.deprecationMessage || "This API version is deprecated";
            if (versionConfig.migrationGuide) {
                set.headers["X-API-Migration-Guide"] = versionConfig.migrationGuide;
            }
            if (versionConfig.supportedUntil) {
                set.headers["X-API-Sunset"] = versionConfig.supportedUntil.toISOString();
            }

            // Log deprecation usage for monitoring
            logger.warn("Deprecated API version used", {
                version: apiVersion,
                userAgent: request.headers.get("User-Agent"),
                ip: request.headers.get("X-Forwarded-For") || "unknown",
                path: new URL(request.url).pathname
            });
        }

        // Add current API version to response headers
        set.headers["X-API-Version"] = apiVersion;
        set.headers["X-API-Version-Config"] = versionConfig.version;

        return {
            apiVersion,
            versionConfig
        };
    });

/**
 * Response transformation for API compatibility
 */
export interface ResponseTransformer {
    fromVersion: string;
    toVersion: string;
    transform: (data: any) => any;
}

/**
 * Registry of response transformers for backward compatibility
 */
export const RESPONSE_TRANSFORMERS: ResponseTransformer[] = [
    // Example: Transform v2 response to v1 format
    {
        fromVersion: "v2",
        toVersion: "v1",
        transform: (data: any) => {
            // Transform new v2 response format to legacy v1 format
            if (data && typeof data === "object") {
                // Example transformations:
                if ("items" in data && Array.isArray(data.items)) {
                    // v2 uses 'items', v1 expects 'results'
                    return { ...data, results: data.items };
                }
                if ("metadata" in data && data.metadata) {
                    // v2 has nested metadata, v1 expects flat structure
                    return { ...data, ...data.metadata };
                }
            }
            return data;
        }
    },
    // Legacy API compatibility
    {
        fromVersion: "v1",
        toVersion: "legacy",
        transform: (data: any) => {
            // Transform v1 response to legacy format
            if (data && typeof data === "object") {
                // Legacy API expects different field names
                if ("success" in data) {
                    return {
                        status: data.success ? "ok" : "error",
                        data: data.success ? data : { error: data.error },
                        timestamp: Date.now()
                    };
                }
            }
            return data;
        }
    },
    // Direct v2 to legacy transformation
    {
        fromVersion: "v2",
        toVersion: "legacy",
        transform: (data: any) => {
            // Transform v2 response to legacy format
            if (data && typeof data === "object") {
                // First transform v2 to v1 format
                let v1Data = data;
                if ("items" in data && Array.isArray(data.items)) {
                    v1Data = { ...data, results: data.items };
                }
                if ("metadata" in data && data.metadata) {
                    v1Data = { ...v1Data, ...data.metadata };
                }
                
                // Then transform v1 to legacy format
                if ("success" in v1Data) {
                    return {
                        status: v1Data.success ? "ok" : "error",
                        data: v1Data.success ? v1Data : { error: v1Data.error },
                        timestamp: Date.now()
                    };
                }
            }
            return data;
        }
    }
];

/**
 * Transform response data for API version compatibility
 */
export function transformResponse(data: any, fromVersion: string, toVersion: string): any {
    if (fromVersion === toVersion) {
        return data;
    }

    const transformer = RESPONSE_TRANSFORMERS.find(
        t => t.fromVersion === fromVersion && t.toVersion === toVersion
    );

    if (transformer) {
        try {
            return transformer.transform(data);
        } catch (error) {
            logger.error("Response transformation failed", {
                fromVersion,
                toVersion,
                error: error instanceof Error ? error.message : String(error)
            });
            // Return original data if transformation fails
            return data;
        }
    }

    // No transformer found, return original data
    return data;
}

/**
 * Response transformation middleware
 */
export const responseTransformPlugin = (app: Elysia) => app
    .onAfterHandle(({ response, apiVersion, set }) => {
        // Only transform if we have a version and it's not the default
        if (!apiVersion || apiVersion === DEFAULT_API_VERSION) {
            return response;
        }

        // Transform response if needed
        const transformedResponse = transformResponse(response, DEFAULT_API_VERSION, apiVersion);
        
        // Add transformation info to headers for debugging
        if (transformedResponse !== response) {
            set.headers["X-API-Response-Transformed"] = "true";
            set.headers["X-API-Transform-From"] = DEFAULT_API_VERSION;
            set.headers["X-API-Transform-To"] = apiVersion;
        }

        return transformedResponse;
    });

/**
 * Deprecation path configuration
 */
export interface DeprecationPath {
    path: string;
    method: string;
    deprecatedIn: string;
    removedIn?: string;
    replacement?: string;
    message?: string;
}

/**
 * Registry of deprecated API endpoints
 */
export const DEPRECATED_ENDPOINTS: DeprecationPath[] = [
    {
        path: "/api/memory/search",
        method: "GET",
        deprecatedIn: "v1",
        removedIn: "v3",
        replacement: "POST /api/memory/query",
        message: "Use POST /api/memory/query for better filtering capabilities"
    },
    {
        path: "/api/system/status",
        method: "GET", 
        deprecatedIn: "v1",
        removedIn: "v3",
        replacement: "GET /api/system/health",
        message: "Renamed for consistency with health check standards"
    }
];

/**
 * Deprecation warning middleware
 */
export const deprecationWarningPlugin = (app: Elysia) => app
    .onRequest(({ request, set }) => {
        const url = new URL(request.url);
        const method = request.method;
        
        const deprecatedEndpoint = DEPRECATED_ENDPOINTS.find(
            dep => dep.path === url.pathname && dep.method === method
        );

        if (deprecatedEndpoint) {
            // Add deprecation headers
            set.headers["X-API-Endpoint-Deprecated"] = "true";
            set.headers["X-API-Deprecated-In"] = deprecatedEndpoint.deprecatedIn;
            if (deprecatedEndpoint.removedIn) {
                set.headers["X-API-Removed-In"] = deprecatedEndpoint.removedIn;
            }
            if (deprecatedEndpoint.replacement) {
                set.headers["X-API-Replacement"] = deprecatedEndpoint.replacement;
            }
            if (deprecatedEndpoint.message) {
                set.headers["X-API-Deprecation-Message"] = deprecatedEndpoint.message;
            }

            // Log deprecation usage
            logger.warn("Deprecated endpoint accessed", {
                path: url.pathname,
                method,
                deprecatedIn: deprecatedEndpoint.deprecatedIn,
                replacement: deprecatedEndpoint.replacement,
                userAgent: request.headers.get("User-Agent"),
                ip: request.headers.get("X-Forwarded-For") || "unknown"
            });
        }
    });

/**
 * Complete API versioning middleware that combines all features
 */
export const apiVersioningMiddleware = (app: Elysia) => app
    .use(apiVersioningPlugin)
    .use(deprecationWarningPlugin)
    .use(responseTransformPlugin);