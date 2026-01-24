import { Elysia } from "elysia";
import { z } from "zod";
import { 
    getApiVersionConfig, 
    getSupportedApiVersions, 
    getDeprecatedApiVersions,
    getApiVersionStats,
    validateVersionCompatibility
} from "../../core/apiVersionConfig";
import { AppError } from "../errors";
import { getUser } from "../middleware/auth";
import { logger } from "../../utils/logger";

/**
 * API Version Management Routes
 */
export const apiVersionRoutes = (app: Elysia) => app.group("/api/version", (app) => {
    return app
        /**
         * GET /api/version
         * Get current API version information
         */
        .get("/", () => {
            const supportedVersions = getSupportedApiVersions();
            const deprecatedVersions = getDeprecatedApiVersions();
            const stats = getApiVersionStats();
            
            return {
                success: true,
                current: "v1", // Default current version
                supported: supportedVersions,
                deprecated: deprecatedVersions.map(d => ({
                    version: d.version,
                    deprecationMessage: d.config.deprecationMessage,
                    migrationGuide: d.config.migrationGuide,
                    daysUntilRemoval: d.daysUntilRemoval,
                    removedIn: d.config.removedIn
                })),
                stats: {
                    totalVersions: stats.totalVersions,
                    activeVersions: stats.activeVersions,
                    deprecatedVersions: stats.deprecatedVersions,
                    expiredVersions: stats.expiredVersions
                }
            };
        })

        /**
         * GET /api/version/:version
         * Get detailed information about a specific API version
         */
        .get("/:version", ({ params }) => {
            const { version } = params;
            const config = getApiVersionConfig(version);
            
            if (!config) {
                throw new AppError(404, "VERSION_NOT_FOUND", 
                    `API version '${version}' not found. Supported versions: ${getSupportedApiVersions().join(", ")}`);
            }
            
            return {
                success: true,
                version,
                config: {
                    version: config.version,
                    name: config.name,
                    deprecated: config.deprecated,
                    supportedUntil: config.supportedUntil,
                    removedIn: config.removedIn,
                    deprecationMessage: config.deprecationMessage,
                    migrationGuide: config.migrationGuide,
                    changelog: config.changelog,
                    features: config.features,
                    backwardCompatible: config.backwardCompatible,
                    forwardCompatible: config.forwardCompatible,
                    rateLimits: config.rateLimits
                }
            };
        })

        /**
         * GET /api/version/:version/features
         * Get feature flags for a specific API version
         */
        .get("/:version/features", ({ params }) => {
            const { version } = params;
            const config = getApiVersionConfig(version);
            
            if (!config) {
                throw new AppError(404, "VERSION_NOT_FOUND", 
                    `API version '${version}' not found`);
            }
            
            return {
                success: true,
                version,
                features: config.features
            };
        })

        /**
         * GET /api/version/compatibility/matrix
         * Get API version compatibility matrix (Admin only)
         */
        .get("/compatibility/matrix", (ctx) => {
            const user = getUser(ctx);
            const isAdmin = (user?.scopes || []).includes("admin:all");
            
            if (!isAdmin) {
                throw new AppError(403, "FORBIDDEN", "Admin access required");
            }
            
            const validation = validateVersionCompatibility();
            const stats = getApiVersionStats();
            
            return {
                success: true,
                compatibility: {
                    valid: validation.valid,
                    issues: validation.issues
                },
                versionDetails: stats.versionDetails,
                matrix: generateCompatibilityMatrix()
            };
        })

        /**
         * POST /api/version/validate
         * Validate API version configuration (Admin only)
         */
        .post("/validate", (ctx) => {
            const user = getUser(ctx);
            const isAdmin = (user?.scopes || []).includes("admin:all");
            
            if (!isAdmin) {
                throw new AppError(403, "FORBIDDEN", "Admin access required");
            }
            
            const validation = validateVersionCompatibility();
            
            logger.info("API version configuration validated", {
                valid: validation.valid,
                issueCount: validation.issues.length,
                userId: user?.id
            });
            
            return {
                success: true,
                validation: {
                    valid: validation.valid,
                    issues: validation.issues,
                    timestamp: new Date().toISOString()
                }
            };
        });
});

/**
 * Generate compatibility matrix between API versions
 */
function generateCompatibilityMatrix(): Record<string, Record<string, boolean>> {
    const supportedVersions = getSupportedApiVersions();
    const matrix: Record<string, Record<string, boolean>> = {};
    
    for (const fromVersion of supportedVersions) {
        matrix[fromVersion] = {};
        const fromConfig = getApiVersionConfig(fromVersion);
        
        for (const toVersion of supportedVersions) {
            const toConfig = getApiVersionConfig(toVersion);
            
            if (!fromConfig || !toConfig) {
                matrix[fromVersion][toVersion] = false;
                continue;
            }
            
            // Same version is always compatible
            if (fromVersion === toVersion) {
                matrix[fromVersion][toVersion] = true;
                continue;
            }
            
            // Check backward/forward compatibility
            const isNewer = fromConfig.version > toConfig.version;
            const isOlder = fromConfig.version < toConfig.version;
            
            let compatible = false;
            
            if (isNewer && fromConfig.backwardCompatible) {
                compatible = true;
            } else if (isOlder && fromConfig.forwardCompatible) {
                compatible = true;
            }
            
            matrix[fromVersion][toVersion] = compatible;
        }
    }
    
    return matrix;
}