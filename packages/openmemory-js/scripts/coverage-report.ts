#!/usr/bin/env bun
/**
 * @file Coverage Report Script
 * Standalone script to run test coverage analysis and generate reports.
 * Can be run manually or as part of CI/CD pipelines.
 */

import { runCoverage, generateCoverageSummary, validateCriticalPathCoverage, generateHtmlReport } from "../src/utils/coverageReporter";
import { logger } from "../src/utils/logger";

interface ScriptOptions {
    html: boolean;
    check: boolean;
    critical: boolean;
    pattern?: string;
    verbose: boolean;
    help: boolean;
}

function parseArgs(): ScriptOptions {
    const args = process.argv.slice(2);
    const options: ScriptOptions = {
        html: false,
        check: false,
        critical: false,
        verbose: false,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--html':
                options.html = true;
                break;
            case '--check':
                options.check = true;
                break;
            case '--critical':
                options.critical = true;
                break;
            case '--pattern':
                options.pattern = args[++i];
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                console.warn(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log(`
OpenMemory Test Coverage Report Script

Usage: bun scripts/coverage-report.ts [options]

Options:
  --html               Generate HTML coverage report
  --check              Check coverage against thresholds (exit 1 if below)
  --critical           Validate critical path coverage with higher thresholds
  --pattern <pattern>  Run coverage for specific test pattern
  --verbose, -v        Enable verbose logging
  --help, -h           Show this help message

Examples:
  bun scripts/coverage-report.ts                           # Basic coverage report
  bun scripts/coverage-report.ts --html                    # Generate HTML report
  bun scripts/coverage-report.ts --check                   # Check thresholds
  bun scripts/coverage-report.ts --critical                # Validate critical paths
  bun scripts/coverage-report.ts --pattern "test/core/*"   # Coverage for specific tests
`);
}

async function main(): Promise<void> {
    const options = parseArgs();

    if (options.help) {
        printHelp();
        process.exit(0);
    }

    if (options.verbose) {
        process.env.OM_VERBOSE = "true";
    }

    console.log("📊 OpenMemory Test Coverage Analysis");
    console.log("====================================");
    
    if (options.pattern) {
        console.log(`🎯 Test pattern: ${options.pattern}`);
    }
    
    console.log(`🔍 HTML report: ${options.html ? '✅' : '❌'}`);
    console.log(`✅ Threshold check: ${options.check ? '✅' : '❌'}`);
    console.log(`🔒 Critical paths: ${options.critical ? '✅' : '❌'}`);
    console.log("");

    try {
        const startTime = Date.now();
        
        // Run coverage analysis
        const result = await runCoverage(options.pattern);
        
        // Display summary
        console.log(generateCoverageSummary(result));
        console.log("");

        // Generate HTML report if requested
        if (options.html) {
            const htmlPath = await generateHtmlReport();
            console.log(`📄 HTML report: ${htmlPath}`);
        }

        // Validate critical paths if requested
        if (options.critical) {
            console.log("🔒 Validating critical path coverage...");
            const criticalValid = await validateCriticalPathCoverage();
            if (criticalValid) {
                console.log("✅ All critical paths meet coverage thresholds");
            } else {
                console.log("❌ Some critical paths do not meet coverage thresholds");
                if (options.check) {
                    process.exit(1);
                }
            }
        }

        const duration = Date.now() - startTime;
        console.log(`⏱️  Analysis completed in ${duration}ms`);

        // Exit with error code if thresholds not met and --check is enabled
        if (options.check && !result.passed) {
            console.log("\n❌ Coverage thresholds not met. Exiting with error code 1.");
            process.exit(1);
        }

        console.log("\n✨ Coverage analysis completed successfully!");

    } catch (error) {
        console.error("❌ Coverage analysis failed:", error);
        process.exit(1);
    }
}

// Run the script
if (import.meta.main) {
    main().catch((error) => {
        console.error("💥 Script failed:", error);
        process.exit(1);
    });
}