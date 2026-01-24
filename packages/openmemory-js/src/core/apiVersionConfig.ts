import { z } from "zod";
import { env } from "./cfg";
import { logger } from "../utils/logger";

/**
 * API Version Configuration Schema
 */
const ApiVersionConfigSchema = z.object({
    // Version identification
    version: z.string(),
    name: z.string().optional(),
    
    // Lifecycle management
    deprecated: z.boolean().default(false),
    supportedUntil: z.string().datetime().optional(),
    removedIn: z.string().optional(),
    
    // Documentation and migration
    deprecationMessage: z.string().optional(),
    migrationGuide: z.string().url().optional(),
    changelog: z.string().url().optional(),
    
    // Feature flags
    features: z.record(z.string(), z.boolean()).default({}),
    
    // Compatibility settings
    backwardCompatible: z.boolean().default(true),
    forwardCompatible: z.boolean().default(false),
    
    // Rate limiting overrides
    rateLimits: z.object({
        requests: z.number().optional(),
        window: z.number().optional(), // in seconds
    }).optional(),
});

export type ApiVersionConfig = z.infer<typeof ApiVersionConfigSchema>;

/**
 * Default API version when none is specified
 */
export const DEFAULT_API_VERSION = "v1";

/**
 * Default API version configurations
 */
export const DEFAULT_API_VERSIONS: Record<string, ApiVersionConfig> = {
    "v1": {
        version: "1.0.0",
        name: "Stable API v1",
        deprecated: false,
        backwardCompatible: true,
        forwardCompatible: false,
        features: {
            "memory.batch": true,
            "memory.compression": true,
            "temporal.graph": true,
            "admin.metrics": true,
        }
    },
    "v2": {
        version: "2.0.0", 
        name: "Enhanced API v2",
        deprecated: false,
        backwardCompatible: true,
        forwardCompatible: true,
        features: {
            "memory.batch": true,
            "memory.compression": true,
            "memory.streaming": true,
            "temporal.graph": true,
            "temporal.analytics": true,
            "admin.metrics": true,
            "admin.advanced": true,
        }
    },
    "legacy": {
        version: "0.9.0",
        name: "Legacy API",
        deprecated: true,
        supportedUntil: "2026-12-31T23:59:59Z",
        removedIn: "v3",
        deprecationMessage: "Legacy API is deprecated. Please migrate to v1 or v2 for continued support.",
        migrationGuide: "https://docs.openmemory.ai/migration/legacy-to-v1",
        changelog: "https://docs.openmemory.ai/changelog/v1",
        backwardCompatible: false,
        forwardCompatible: false,
        features: {
            "memory.basic": true,
            "admin.basic": true,
        },
        rateLimits: {
            requests: 100, // Lower rate limit for deprecated version
            window: 3600, // 1 hour
        }
    }
};

/**
 * Load API version configuration from environment or use defaults
 */
export function loadApiVersionConfig(): Record<string, ApiVersionConfig> {
    try {
        // Check if custom config is provided via environment
        const customConfigJson = env.apiVersionConfig;
        if (customConfigJson) {
            const customConfig = JSON.parse(customConfigJson);
            
            // Validate custom configuration
            const validatedConfig: Record<string, ApiVersionConfig> = {};
            for (const [version, config] of Object.entries(customConfig)) {
                try {
                    validatedConfig[version] = ApiVersionConfigSchema.parse(config);
                } catch (error) {
                    logger.warn(`Invalid API version config for ${version}`, { error });
                    // Fall back to default for this version
                    if (DEFAULT_API_VERSIONS[version]) {
                        validatedConfig[version] = DEFAULT_API_VERSIONS[version];
                    }
                }
            }
            
            // Merge with defaults (custom config takes precedence)
            return { ...DEFAULT_API_VERSIONS, ...validatedConfig };
        }
    } catch (error) {
        logger.warn("Failed to load custom API version config, using defaults", { error });
    }
    
    return DEFAULT_API_VERSIONS;
}

/**
 * Get configuration for a specific API version
 */
export function getApiVersionConfig(version: string): ApiVersionConfig | null {
    const configs = loadApiVersionConfig();
    return configs[version] || null;
}

/**
 * Check if a feature is enabled for a specific API version
 */
export function isFeatureEnabled(version: string, feature: string): boolean {
    const config = getApiVersionConfig(version);
    if (!config) return false;
    
    return config.features[feature] === true;
}

/**
 * Get all supported API versions
 */
export function getSupportedApiVersions(): string[] {
    const configs = loadApiVersionConfig();
    const now = new Date();
    
    return Object.entries(configs)
        .filter(([_, config]) => {
            // Filter out expired versions
            if (config.supportedUntil) {
                const supportedUntil = new Date(config.supportedUntil);
                return now <= supportedUntil;
            }
            return true;
        })
        .map(([version, _]) => version);
}

/**
 * Get deprecated API versions with their deprecation info
 */
export function getDeprecatedApiVersions(): Array<{
    version: string;
    config: ApiVersionConfig;
    daysUntilRemoval?: number;
}> {
    const configs = loadApiVersionConfig();
    const now = new Date();
    
    return Object.entries(configs)
        .filter(([_, config]) => config.deprecated)
        .map(([version, config]) => {
            let daysUntilRemoval: number | undefined;
            if (config.supportedUntil) {
                const supportedUntil = new Date(config.supportedUntil);
                const diffTime = supportedUntil.getTime() - now.getTime();
                daysUntilRemoval = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            }
            
            return {
                version,
                config,
                daysUntilRemoval
            };
        });
}

/**
 * Validate API version compatibility matrix
 */
export function validateVersionCompatibility(): {
    valid: boolean;
    issues: string[];
} {
    const configs = loadApiVersionConfig();
    const issues: string[] = [];
    
    // Check for version conflicts
    const versions = Object.keys(configs);
    for (const version of versions) {
        const config = configs[version];
        
        // Check if deprecated versions have sunset dates
        if (config.deprecated && !config.supportedUntil) {
            issues.push(`Deprecated version ${version} should have a supportedUntil date`);
        }
        
        // Check if migration guides exist for deprecated versions
        if (config.deprecated && !config.migrationGuide) {
            issues.push(`Deprecated version ${version} should have a migration guide`);
        }
        
        // Check for feature consistency
        if (config.backwardCompatible) {
            // Backward compatible versions should have subset of features from newer versions
            const newerVersions = versions.filter(v => {
                const vConfig = configs[v];
                return vConfig.version > config.version;
            });
            
            for (const newerVersion of newerVersions) {
                const newerConfig = configs[newerVersion];
                const currentFeatures = Object.keys(config.features);
                const newerFeatures = Object.keys(newerConfig.features);
                
                const missingFeatures = currentFeatures.filter(
                    feature => config.features[feature] && !newerConfig.features[feature]
                );
                
                if (missingFeatures.length > 0) {
                    issues.push(
                        `Version ${version} claims backward compatibility but has features missing in ${newerVersion}: ${missingFeatures.join(", ")}`
                    );
                }
            }
        }
    }
    
    return {
        valid: issues.length === 0,
        issues
    };
}

/**
 * Get API version statistics for monitoring
 */
export function getApiVersionStats(): {
    totalVersions: number;
    activeVersions: number;
    deprecatedVersions: number;
    expiredVersions: number;
    versionDetails: Array<{
        version: string;
        status: "active" | "deprecated" | "expired";
        featureCount: number;
        daysUntilRemoval?: number;
    }>;
} {
    const configs = loadApiVersionConfig();
    const now = new Date();
    
    let activeVersions = 0;
    let deprecatedVersions = 0;
    let expiredVersions = 0;
    
    const versionDetails = Object.entries(configs).map(([version, config]) => {
        let status: "active" | "deprecated" | "expired" = "active";
        let daysUntilRemoval: number | undefined;
        
        if (config.supportedUntil) {
            const supportedUntil = new Date(config.supportedUntil);
            const diffTime = supportedUntil.getTime() - now.getTime();
            daysUntilRemoval = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (now > supportedUntil) {
                status = "expired";
                expiredVersions++;
            } else if (config.deprecated) {
                status = "deprecated";
                deprecatedVersions++;
            } else {
                activeVersions++;
            }
        } else if (config.deprecated) {
            status = "deprecated";
            deprecatedVersions++;
        } else {
            activeVersions++;
        }
        
        return {
            version,
            status,
            featureCount: Object.keys(config.features).length,
            daysUntilRemoval
        };
    });
    
    return {
        totalVersions: Object.keys(configs).length,
        activeVersions,
        deprecatedVersions,
        expiredVersions,
        versionDetails
    };
}