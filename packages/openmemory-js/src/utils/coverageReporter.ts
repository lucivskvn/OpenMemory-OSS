/**
 * @file Coverage Reporting Utilities
 * Provides utilities for test coverage analysis and reporting.
 * Integrates with c8 for JavaScript/TypeScript coverage reporting.
 */

import { logger } from "./logger";

export interface CoverageThresholds {
    lines: number;
    functions: number;
    branches: number;
    statements: number;
}

export interface CoverageReport {
    lines: {
        total: number;
        covered: number;
        pct: number;
    };
    functions: {
        total: number;
        covered: number;
        pct: number;
    };
    branches: {
        total: number;
        covered: number;
        pct: number;
    };
    statements: {
        total: number;
        covered: number;
        pct: number;
    };
}

export interface CoverageResult {
    passed: boolean;
    report: CoverageReport;
    thresholds: CoverageThresholds;
    failures: string[];
}

/**
 * Default coverage thresholds for critical paths
 */
export const DEFAULT_THRESHOLDS: CoverageThresholds = {
    lines: 85,
    functions: 80,
    branches: 75,
    statements: 85
};

/**
 * Critical paths that require higher coverage thresholds
 */
export const CRITICAL_PATH_THRESHOLDS: CoverageThresholds = {
    lines: 95,
    functions: 90,
    branches: 85,
    statements: 95
};

/**
 * Patterns for critical code paths that need higher coverage
 */
export const CRITICAL_PATHS = [
    "src/core/security.ts",
    "src/core/db.ts",
    "src/core/memory.ts",
    "src/memory/hsg.ts",
    "src/core/types/**",
    "src/utils/vectors.ts"
];

/**
 * Run coverage analysis using c8
 */
export async function runCoverage(testPattern?: string): Promise<CoverageResult> {
    logger.info("[COVERAGE] Running test coverage analysis...");
    
    const testCmd = testPattern 
        ? `bun test --timeout 30000 ${testPattern}`
        : "bun test --timeout 30000";
    
    try {
        // Run tests with coverage
        const proc = Bun.spawn([
            "bun", "x", "c8", 
            "--reporter=json", 
            "--reporter=text",
            ...testCmd.split(" ").slice(1) // Remove 'bun' from the command
        ], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: process.cwd()
        });

        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();
        await proc.exited;

        // Parse coverage report
        const report = await parseCoverageReport();
        const result = analyzeCoverage(report, DEFAULT_THRESHOLDS);

        if (result.passed) {
            logger.info("[COVERAGE] Coverage thresholds met ✅");
        } else {
            logger.warn("[COVERAGE] Coverage thresholds not met ❌");
            for (const failure of result.failures) {
                logger.warn(`[COVERAGE] ${failure}`);
            }
        }

        return result;
    } catch (error) {
        logger.error("[COVERAGE] Coverage analysis failed:", error);
        throw error;
    }
}

/**
 * Parse coverage report from c8 JSON output
 */
async function parseCoverageReport(): Promise<CoverageReport> {
    try {
        const coverageFile = Bun.file("coverage/coverage-summary.json");
        if (!(await coverageFile.exists())) {
            throw new Error("Coverage report not found. Run tests with coverage first.");
        }

        const data = await coverageFile.json();
        const total = data.total;

        return {
            lines: {
                total: total.lines.total,
                covered: total.lines.covered,
                pct: total.lines.pct
            },
            functions: {
                total: total.functions.total,
                covered: total.functions.covered,
                pct: total.functions.pct
            },
            branches: {
                total: total.branches.total,
                covered: total.branches.covered,
                pct: total.branches.pct
            },
            statements: {
                total: total.statements.total,
                covered: total.statements.covered,
                pct: total.statements.pct
            }
        };
    } catch (error) {
        logger.error("[COVERAGE] Failed to parse coverage report:", error);
        throw error;
    }
}

/**
 * Analyze coverage against thresholds
 */
export function analyzeCoverage(
    report: CoverageReport, 
    thresholds: CoverageThresholds
): CoverageResult {
    const failures: string[] = [];
    
    if (report.lines.pct < thresholds.lines) {
        failures.push(`Lines coverage ${report.lines.pct.toFixed(1)}% below threshold ${thresholds.lines}%`);
    }
    
    if (report.functions.pct < thresholds.functions) {
        failures.push(`Functions coverage ${report.functions.pct.toFixed(1)}% below threshold ${thresholds.functions}%`);
    }
    
    if (report.branches.pct < thresholds.branches) {
        failures.push(`Branches coverage ${report.branches.pct.toFixed(1)}% below threshold ${thresholds.branches}%`);
    }
    
    if (report.statements.pct < thresholds.statements) {
        failures.push(`Statements coverage ${report.statements.pct.toFixed(1)}% below threshold ${thresholds.statements}%`);
    }

    return {
        passed: failures.length === 0,
        report,
        thresholds,
        failures
    };
}

/**
 * Generate coverage report summary
 */
export function generateCoverageSummary(result: CoverageResult): string {
    const { report } = result;
    
    const summary = [
        "📊 Test Coverage Summary",
        "========================",
        "",
        `📈 Lines:      ${report.lines.covered}/${report.lines.total} (${report.lines.pct.toFixed(1)}%)`,
        `🔧 Functions:  ${report.functions.covered}/${report.functions.total} (${report.functions.pct.toFixed(1)}%)`,
        `🌿 Branches:   ${report.branches.covered}/${report.branches.total} (${report.branches.pct.toFixed(1)}%)`,
        `📝 Statements: ${report.statements.covered}/${report.statements.total} (${report.statements.pct.toFixed(1)}%)`,
        ""
    ];

    if (result.passed) {
        summary.push("✅ All coverage thresholds met!");
    } else {
        summary.push("❌ Coverage thresholds not met:");
        for (const failure of result.failures) {
            summary.push(`   • ${failure}`);
        }
    }

    return summary.join("\n");
}

/**
 * Check if a file path is in critical paths
 */
export function isCriticalPath(filePath: string): boolean {
    return CRITICAL_PATHS.some(pattern => {
        if (pattern.includes("**")) {
            const basePattern = pattern.replace("/**", "");
            return filePath.startsWith(basePattern);
        }
        return filePath === pattern || filePath.endsWith(pattern);
    });
}

/**
 * Get appropriate thresholds for a file path
 */
export function getThresholdsForPath(filePath: string): CoverageThresholds {
    return isCriticalPath(filePath) ? CRITICAL_PATH_THRESHOLDS : DEFAULT_THRESHOLDS;
}

/**
 * Validate coverage for critical paths
 */
export async function validateCriticalPathCoverage(): Promise<boolean> {
    try {
        const coverageFile = Bun.file("coverage/coverage-final.json");
        if (!(await coverageFile.exists())) {
            logger.warn("[COVERAGE] No detailed coverage data found");
            return false;
        }

        const data = await coverageFile.json();
        let allCriticalPathsMeetThreshold = true;

        for (const filePath of Object.keys(data)) {
            if (isCriticalPath(filePath)) {
                const fileData = data[filePath];
                const thresholds = CRITICAL_PATH_THRESHOLDS;
                
                const lineCoverage = (fileData.s ? Object.values(fileData.s).filter((v: any) => v > 0).length / Object.keys(fileData.s).length * 100 : 0);
                
                if (lineCoverage < thresholds.lines) {
                    logger.warn(`[COVERAGE] Critical path ${filePath} has ${lineCoverage.toFixed(1)}% line coverage, below ${thresholds.lines}% threshold`);
                    allCriticalPathsMeetThreshold = false;
                }
            }
        }

        return allCriticalPathsMeetThreshold;
    } catch (error) {
        logger.error("[COVERAGE] Failed to validate critical path coverage:", error);
        return false;
    }
}

/**
 * Generate HTML coverage report
 */
export async function generateHtmlReport(): Promise<string> {
    logger.info("[COVERAGE] Generating HTML coverage report...");
    
    try {
        const proc = Bun.spawn([
            "bun", "x", "c8", 
            "--reporter=html",
            "bun", "test", "--timeout", "30000"
        ], {
            stdout: "pipe",
            stderr: "pipe"
        });

        await proc.exited;
        
        const reportPath = "coverage/index.html";
        const reportFile = Bun.file(reportPath);
        
        if (await reportFile.exists()) {
            logger.info(`[COVERAGE] HTML report generated: ${reportPath}`);
            return reportPath;
        } else {
            throw new Error("HTML report was not generated");
        }
    } catch (error) {
        logger.error("[COVERAGE] Failed to generate HTML report:", error);
        throw error;
    }
}