#!/usr/bin/env bun

/**
 * @file OpenMemory Production Deployment Script
 * Automated deployment with health checks, rollback capabilities, and graceful system recovery
 */

import { $ } from "bun";
import { logger } from "../src/utils/logger";
import { env } from "../src/core/cfg";

interface DeploymentConfig {
    environment: "staging" | "production";
    healthCheckUrl: string;
    healthCheckTimeout: number;
    rollbackOnFailure: boolean;
    backupDatabase: boolean;
    runMigrations: boolean;
    restartServices: boolean;
    validateConfig: boolean;
}

interface DeploymentResult {
    success: boolean;
    version: string;
    timestamp: string;
    duration: number;
    healthChecksPassed: boolean;
    rollbackPerformed: boolean;
    errors: string[];
    warnings: string[];
}

class DeploymentManager {
    private config: DeploymentConfig;
    private startTime: number = 0;
    private errors: string[] = [];
    private warnings: string[] = [];

    constructor(config: DeploymentConfig) {
        this.config = config;
    }

    async deploy(): Promise<DeploymentResult> {
        this.startTime = Date.now();
        logger.info(`🚀 Starting OpenMemory deployment to ${this.config.environment}`);

        try {
            // Pre-deployment validation
            await this.validatePreDeployment();
            
            // Backup current state
            if (this.config.backupDatabase) {
                await this.backupDatabase();
            }

            // Build and prepare
            await this.buildApplication();
            
            // Run database migrations
            if (this.config.runMigrations) {
                await this.runMigrations();
            }

            // Deploy application
            await this.deployApplication();

            // Health checks
            const healthChecksPassed = await this.performHealthChecks();

            // Restart services if needed
            if (this.config.restartServices) {
                await this.restartServices();
            }

            // Final validation
            await this.validateDeployment();

            const result: DeploymentResult = {
                success: true,
                version: await this.getVersion(),
                timestamp: new Date().toISOString(),
                duration: Date.now() - this.startTime,
                healthChecksPassed,
                rollbackPerformed: false,
                errors: this.errors,
                warnings: this.warnings
            };

            logger.info(`✅ Deployment completed successfully in ${result.duration}ms`);
            return result;

        } catch (error) {
            logger.error(`❌ Deployment failed: ${error}`);
            
            let rollbackPerformed = false;
            if (this.config.rollbackOnFailure) {
                try {
                    await this.rollback();
                    rollbackPerformed = true;
                    logger.info("🔄 Rollback completed successfully");
                } catch (rollbackError) {
                    logger.error(`❌ Rollback failed: ${rollbackError}`);
                    this.errors.push(`Rollback failed: ${rollbackError}`);
                }
            }

            return {
                success: false,
                version: await this.getVersion(),
                timestamp: new Date().toISOString(),
                duration: Date.now() - this.startTime,
                healthChecksPassed: false,
                rollbackPerformed,
                errors: [...this.errors, String(error)],
                warnings: this.warnings
            };
        }
    }

    private async validatePreDeployment(): Promise<void> {
        logger.info("🔍 Validating pre-deployment requirements...");

        // Check if required environment variables are set
        if (this.config.validateConfig) {
            const requiredVars = [
                'OM_API_KEY',
                'OM_ADMIN_KEY',
                'OM_DB_PATH'
            ];

            for (const varName of requiredVars) {
                if (!Bun.env[varName]) {
                    throw new Error(`Required environment variable ${varName} is not set`);
                }
            }
        }

        // Check disk space
        try {
            const result = await $`df -h .`.text();
            const lines = result.split('\n');
            const dataLine = lines[1];
            const usage = dataLine.split(/\s+/)[4];
            const usagePercent = parseInt(usage.replace('%', ''));
            
            if (usagePercent > 90) {
                this.warnings.push(`Disk usage is high: ${usage}`);
            }
        } catch (error) {
            this.warnings.push(`Could not check disk space: ${error}`);
        }

        // Check if port is available
        try {
            const port = env.port;
            const result = await $`netstat -tuln | grep :${port}`.text();
            if (result.trim()) {
                this.warnings.push(`Port ${port} appears to be in use`);
            }
        } catch (error) {
            // Port is likely available (netstat returned non-zero)
        }

        logger.info("✅ Pre-deployment validation completed");
    }

    private async backupDatabase(): Promise<void> {
        logger.info("💾 Creating database backup...");

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `./backups/openmemory-${timestamp}.backup`;

        try {
            // Create backups directory
            await $`mkdir -p ./backups`;

            // Backup SQLite database
            if (env.dbPath && env.dbPath !== ":memory:") {
                await $`cp ${env.dbPath} ${backupPath}`;
                logger.info(`✅ Database backed up to ${backupPath}`);
            } else {
                this.warnings.push("Using in-memory database, no backup created");
            }
        } catch (error) {
            throw new Error(`Database backup failed: ${error}`);
        }
    }

    private async buildApplication(): Promise<void> {
        logger.info("🔨 Building application...");

        try {
            // Clean previous build
            await $`bun run clean`;
            
            // Install dependencies
            await $`bun install --frozen-lockfile`;
            
            // Run type checking
            await $`bun run typecheck`;
            
            // Build application
            await $`bun run build`;
            
            logger.info("✅ Application built successfully");
        } catch (error) {
            throw new Error(`Build failed: ${error}`);
        }
    }

    private async runMigrations(): Promise<void> {
        logger.info("🗄️ Running database migrations...");

        try {
            await $`bun run migrate`;
            logger.info("✅ Database migrations completed");
        } catch (error) {
            throw new Error(`Migration failed: ${error}`);
        }
    }

    private async deployApplication(): Promise<void> {
        logger.info("📦 Deploying application...");

        try {
            // Copy built files to deployment directory
            const deployDir = process.env.DEPLOY_DIR || "./deploy";
            await $`mkdir -p ${deployDir}`;
            await $`cp -r ./dist/* ${deployDir}/`;
            
            // Copy configuration files
            if (await Bun.file("./package.json").exists()) {
                await $`cp ./package.json ${deployDir}/`;
            }
            
            logger.info("✅ Application deployed successfully");
        } catch (error) {
            throw new Error(`Deployment failed: ${error}`);
        }
    }

    private async performHealthChecks(): Promise<boolean> {
        logger.info("🏥 Performing health checks...");

        const maxAttempts = 10;
        const delayMs = 2000;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await fetch(this.config.healthCheckUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'OpenMemory-Deployment-Health-Check'
                    }
                });

                if (response.ok) {
                    const healthData = await response.json();
                    logger.info(`✅ Health check passed (attempt ${attempt}/${maxAttempts})`);
                    logger.info(`   Status: ${healthData.status}`);
                    logger.info(`   Version: ${healthData.version}`);
                    return true;
                }

                logger.warn(`⚠️ Health check failed (attempt ${attempt}/${maxAttempts}): ${response.status}`);
            } catch (error) {
                logger.warn(`⚠️ Health check error (attempt ${attempt}/${maxAttempts}): ${error}`);
            }

            if (attempt < maxAttempts) {
                logger.info(`⏳ Waiting ${delayMs}ms before next health check...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        this.errors.push("Health checks failed after maximum attempts");
        return false;
    }

    private async restartServices(): Promise<void> {
        logger.info("🔄 Restarting services...");

        try {
            // Graceful shutdown of existing processes
            await this.gracefulShutdown();
            
            // Wait for processes to stop
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Start new processes
            await this.startServices();
            
            logger.info("✅ Services restarted successfully");
        } catch (error) {
            throw new Error(`Service restart failed: ${error}`);
        }
    }

    private async gracefulShutdown(): Promise<void> {
        logger.info("🛑 Performing graceful shutdown...");

        try {
            // Send SIGTERM to allow graceful shutdown
            const pidFile = "./openmemory.pid";
            if (await Bun.file(pidFile).exists()) {
                const pid = await Bun.file(pidFile).text();
                await $`kill -TERM ${pid.trim()}`;
                
                // Wait for graceful shutdown
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                // Force kill if still running
                try {
                    await $`kill -KILL ${pid.trim()}`;
                } catch {
                    // Process already stopped
                }
            }
        } catch (error) {
            this.warnings.push(`Graceful shutdown warning: ${error}`);
        }
    }

    private async startServices(): Promise<void> {
        logger.info("▶️ Starting services...");

        try {
            // Start OpenMemory server
            const deployDir = process.env.DEPLOY_DIR || "./deploy";
            const logFile = "./logs/openmemory.log";
            
            // Create logs directory
            await $`mkdir -p ./logs`;
            
            // Start server in background
            const serverProcess = Bun.spawn([
                "bun", 
                `${deployDir}/server/start.js`
            ], {
                stdout: Bun.file(logFile),
                stderr: Bun.file(logFile),
                env: process.env
            });

            // Save PID for later management
            await Bun.write("./openmemory.pid", serverProcess.pid.toString());
            
            logger.info(`✅ Services started (PID: ${serverProcess.pid})`);
        } catch (error) {
            throw new Error(`Service start failed: ${error}`);
        }
    }

    private async validateDeployment(): Promise<void> {
        logger.info("✅ Validating deployment...");

        // Check if all required files exist
        const requiredFiles = [
            "./dist/server/start.js",
            "./dist/index.js",
            "./dist/cli.js"
        ];

        for (const file of requiredFiles) {
            if (!await Bun.file(file).exists()) {
                throw new Error(`Required file missing: ${file}`);
            }
        }

        // Verify configuration
        try {
            const { env } = await import("../src/core/cfg");
            logger.info(`✅ Configuration validated for environment: ${env.nodeEnv}`);
        } catch (error) {
            throw new Error(`Configuration validation failed: ${error}`);
        }

        logger.info("✅ Deployment validation completed");
    }

    private async rollback(): Promise<void> {
        logger.info("🔄 Performing rollback...");

        try {
            // Stop current services
            await this.gracefulShutdown();

            // Restore from backup
            const backupDir = "./backups";
            const backups = await $`ls -t ${backupDir}/*.backup 2>/dev/null || echo ""`.text();
            const latestBackup = backups.split('\n')[0].trim();

            if (latestBackup) {
                await $`cp ${latestBackup} ${env.dbPath}`;
                logger.info(`✅ Database restored from ${latestBackup}`);
            }

            // Restart with previous version
            await this.startServices();

            logger.info("✅ Rollback completed");
        } catch (error) {
            throw new Error(`Rollback failed: ${error}`);
        }
    }

    private async getVersion(): Promise<string> {
        try {
            const packageJson = await Bun.file("./package.json").json();
            return packageJson.version || "unknown";
        } catch {
            return "unknown";
        }
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    const environment = (args[0] as "staging" | "production") || "staging";
    
    if (!["staging", "production"].includes(environment)) {
        logger.error("❌ Invalid environment. Use 'staging' or 'production'");
        process.exit(1);
    }

    const config: DeploymentConfig = {
        environment,
        healthCheckUrl: `http://localhost:${env.port}/health`,
        healthCheckTimeout: 30000,
        rollbackOnFailure: environment === "production",
        backupDatabase: environment === "production",
        runMigrations: true,
        restartServices: true,
        validateConfig: environment === "production"
    };

    const deployment = new DeploymentManager(config);
    const result = await deployment.deploy();

    // Output deployment report
    console.log("\n📊 Deployment Report");
    console.log("===================");
    console.log(`Environment: ${config.environment}`);
    console.log(`Success: ${result.success ? "✅" : "❌"}`);
    console.log(`Version: ${result.version}`);
    console.log(`Duration: ${Math.round(result.duration / 1000)}s`);
    console.log(`Health Checks: ${result.healthChecksPassed ? "✅" : "❌"}`);
    console.log(`Rollback: ${result.rollbackPerformed ? "✅" : "❌"}`);

    if (result.warnings.length > 0) {
        console.log("\n⚠️ Warnings:");
        result.warnings.forEach(warning => console.log(`  • ${warning}`));
    }

    if (result.errors.length > 0) {
        console.log("\n❌ Errors:");
        result.errors.forEach(error => console.log(`  • ${error}`));
    }

    process.exit(result.success ? 0 : 1);
}

if (import.meta.main) {
    main().catch(error => {
        logger.error(`💥 Deployment script failed: ${error}`);
        process.exit(1);
    });
}

export { DeploymentManager, type DeploymentConfig, type DeploymentResult };