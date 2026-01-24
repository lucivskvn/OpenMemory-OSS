/**
 * @file Property Test: Test Coverage Achievement
 * **Property 28: Test Coverage Achievement**
 * **Validates: Requirements 6.1**
 * 
 * This property test validates that the test coverage system correctly measures
 * and reports coverage metrics, ensuring that coverage thresholds are properly
 * enforced and critical paths receive adequate testing.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { 
    analyzeCoverage, 
    generateCoverageSummary, 
    isCriticalPath, 
    getThresholdsForPath,
    DEFAULT_THRESHOLDS,
    CRITICAL_PATH_THRESHOLDS,
    CRITICAL_PATHS
} from "../../src/utils/coverageReporter";
import type { CoverageReport, CoverageThresholds } from "../../src/utils/coverageReporter";

describe("Property Test: Test Coverage Achievement", () => {
    
    test("Property 28.1: Coverage analysis should correctly identify threshold violations", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    lines: fc.record({
                        total: fc.integer({ min: 1, max: 1000 }),
                        covered: fc.integer({ min: 0, max: 1000 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    functions: fc.record({
                        total: fc.integer({ min: 1, max: 500 }),
                        covered: fc.integer({ min: 0, max: 500 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    branches: fc.record({
                        total: fc.integer({ min: 1, max: 800 }),
                        covered: fc.integer({ min: 0, max: 800 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    statements: fc.record({
                        total: fc.integer({ min: 1, max: 1200 }),
                        covered: fc.integer({ min: 0, max: 1200 }),
                        pct: fc.float({ min: 0, max: 100 })
                    })
                }),
                fc.record({
                    lines: fc.integer({ min: 50, max: 95 }),
                    functions: fc.integer({ min: 50, max: 90 }),
                    branches: fc.integer({ min: 40, max: 85 }),
                    statements: fc.integer({ min: 50, max: 95 })
                }),
                async (report: CoverageReport, thresholds: CoverageThresholds) => {
                    // Ensure covered <= total for consistency
                    report.lines.covered = Math.min(report.lines.covered, report.lines.total);
                    report.functions.covered = Math.min(report.functions.covered, report.functions.total);
                    report.branches.covered = Math.min(report.branches.covered, report.branches.total);
                    report.statements.covered = Math.min(report.statements.covered, report.statements.total);
                    
                    // Ensure percentage matches covered/total ratio
                    report.lines.pct = report.lines.total > 0 ? (report.lines.covered / report.lines.total) * 100 : 0;
                    report.functions.pct = report.functions.total > 0 ? (report.functions.covered / report.functions.total) * 100 : 0;
                    report.branches.pct = report.branches.total > 0 ? (report.branches.covered / report.branches.total) * 100 : 0;
                    report.statements.pct = report.statements.total > 0 ? (report.statements.covered / report.statements.total) * 100 : 0;
                    
                    const result = analyzeCoverage(report, thresholds);
                    
                    // Check if analysis correctly identifies failures
                    const expectedFailures = [];
                    if (report.lines.pct < thresholds.lines) {
                        expectedFailures.push("lines");
                    }
                    if (report.functions.pct < thresholds.functions) {
                        expectedFailures.push("functions");
                    }
                    if (report.branches.pct < thresholds.branches) {
                        expectedFailures.push("branches");
                    }
                    if (report.statements.pct < thresholds.statements) {
                        expectedFailures.push("statements");
                    }
                    
                    // Result should pass only if no thresholds are violated
                    expect(result.passed).toBe(expectedFailures.length === 0);
                    expect(result.failures.length).toBe(expectedFailures.length);
                    
                    // Each failure should mention the correct metric
                    for (const failure of expectedFailures) {
                        const hasFailure = result.failures.some(f => 
                            f.toLowerCase().includes(failure.toLowerCase())
                        );
                        expect(hasFailure).toBe(true);
                    }
                    
                    // Report should be preserved in result
                    expect(result.report).toEqual(report);
                    expect(result.thresholds).toEqual(thresholds);
                }
            ),
            { 
                numRuns: 25,
                timeout: 8000
            }
        );
    });

    test("Property 28.2: Critical path detection should work correctly for various file paths", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    // Generate critical paths
                    fc.constantFrom(...CRITICAL_PATHS),
                    // Generate non-critical paths
                    fc.oneof(
                        fc.constant("src/test/example.ts"),
                        fc.constant("src/examples/demo.ts"),
                        fc.constant("src/cli/helper.ts"),
                        fc.constant("src/server/routes/test.ts"),
                        fc.constant("packages/other/file.ts")
                    )
                ),
                async (filePath: string) => {
                    const isCritical = isCriticalPath(filePath);
                    const thresholds = getThresholdsForPath(filePath);
                    
                    // Check if critical path detection is consistent
                    const shouldBeCritical = CRITICAL_PATHS.some(pattern => {
                        if (pattern.includes("**")) {
                            const basePattern = pattern.replace("/**", "");
                            return filePath.startsWith(basePattern);
                        }
                        return filePath === pattern || filePath.endsWith(pattern);
                    });
                    
                    expect(isCritical).toBe(shouldBeCritical);
                    
                    // Thresholds should match criticality
                    if (isCritical) {
                        expect(thresholds).toEqual(CRITICAL_PATH_THRESHOLDS);
                    } else {
                        expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
                    }
                    
                    // Critical thresholds should be higher than default
                    expect(CRITICAL_PATH_THRESHOLDS.lines).toBeGreaterThan(DEFAULT_THRESHOLDS.lines);
                    expect(CRITICAL_PATH_THRESHOLDS.functions).toBeGreaterThan(DEFAULT_THRESHOLDS.functions);
                    expect(CRITICAL_PATH_THRESHOLDS.branches).toBeGreaterThan(DEFAULT_THRESHOLDS.branches);
                    expect(CRITICAL_PATH_THRESHOLDS.statements).toBeGreaterThan(DEFAULT_THRESHOLDS.statements);
                }
            ),
            { 
                numRuns: 20,
                timeout: 6000
            }
        );
    });

    test("Property 28.3: Coverage summary generation should be consistent and informative", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    lines: fc.record({
                        total: fc.integer({ min: 1, max: 1000 }),
                        covered: fc.integer({ min: 0, max: 1000 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    functions: fc.record({
                        total: fc.integer({ min: 1, max: 500 }),
                        covered: fc.integer({ min: 0, max: 500 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    branches: fc.record({
                        total: fc.integer({ min: 1, max: 800 }),
                        covered: fc.integer({ min: 0, max: 800 }),
                        pct: fc.float({ min: 0, max: 100 })
                    }),
                    statements: fc.record({
                        total: fc.integer({ min: 1, max: 1200 }),
                        covered: fc.integer({ min: 0, max: 1200 }),
                        pct: fc.float({ min: 0, max: 100 })
                    })
                }),
                fc.boolean(), // Whether coverage passes thresholds
                async (report: CoverageReport, shouldPass: boolean) => {
                    // Ensure covered <= total for consistency
                    report.lines.covered = Math.min(report.lines.covered, report.lines.total);
                    report.functions.covered = Math.min(report.functions.covered, report.functions.total);
                    report.branches.covered = Math.min(report.branches.covered, report.branches.total);
                    report.statements.covered = Math.min(report.statements.covered, report.statements.total);
                    
                    // Adjust percentages to match covered/total
                    report.lines.pct = report.lines.total > 0 ? (report.lines.covered / report.lines.total) * 100 : 0;
                    report.functions.pct = report.functions.total > 0 ? (report.functions.covered / report.functions.total) * 100 : 0;
                    report.branches.pct = report.branches.total > 0 ? (report.branches.covered / report.branches.total) * 100 : 0;
                    report.statements.pct = report.statements.total > 0 ? (report.statements.covered / report.statements.total) * 100 : 0;
                    
                    // Create a result that matches shouldPass
                    const result = {
                        passed: shouldPass,
                        report,
                        thresholds: DEFAULT_THRESHOLDS,
                        failures: shouldPass ? [] : ["Test failure for property testing"]
                    };
                    
                    const summary = generateCoverageSummary(result);
                    
                    // Summary should be a non-empty string
                    expect(typeof summary).toBe("string");
                    expect(summary.length).toBeGreaterThan(0);
                    
                    // Summary should contain coverage metrics
                    expect(summary).toContain("Lines:");
                    expect(summary).toContain("Functions:");
                    expect(summary).toContain("Branches:");
                    expect(summary).toContain("Statements:");
                    
                    // Summary should contain the actual numbers
                    expect(summary).toContain(report.lines.covered.toString());
                    expect(summary).toContain(report.lines.total.toString());
                    expect(summary).toContain(report.functions.covered.toString());
                    expect(summary).toContain(report.functions.total.toString());
                    
                    // Summary should indicate pass/fail status
                    if (shouldPass) {
                        expect(summary).toContain("✅");
                        expect(summary).toContain("met");
                    } else {
                        expect(summary).toContain("❌");
                        expect(summary).toContain("not met");
                    }
                }
            ),
            { 
                numRuns: 15,
                timeout: 6000
            }
        );
    });

    test("Property 28.4: Coverage thresholds should be reasonable and achievable", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    lines: fc.integer({ min: 0, max: 100 }),
                    functions: fc.integer({ min: 0, max: 100 }),
                    branches: fc.integer({ min: 0, max: 100 }),
                    statements: fc.integer({ min: 0, max: 100 })
                }),
                async (thresholds: CoverageThresholds) => {
                    // All thresholds should be within reasonable bounds
                    expect(thresholds.lines).toBeGreaterThanOrEqual(0);
                    expect(thresholds.lines).toBeLessThanOrEqual(100);
                    
                    expect(thresholds.functions).toBeGreaterThanOrEqual(0);
                    expect(thresholds.functions).toBeLessThanOrEqual(100);
                    
                    expect(thresholds.branches).toBeGreaterThanOrEqual(0);
                    expect(thresholds.branches).toBeLessThanOrEqual(100);
                    
                    expect(thresholds.statements).toBeGreaterThanOrEqual(0);
                    expect(thresholds.statements).toBeLessThanOrEqual(100);
                    
                    // Create a perfect coverage report
                    const perfectReport: CoverageReport = {
                        lines: { total: 100, covered: 100, pct: 100 },
                        functions: { total: 50, covered: 50, pct: 100 },
                        branches: { total: 80, covered: 80, pct: 100 },
                        statements: { total: 120, covered: 120, pct: 100 }
                    };
                    
                    // Perfect coverage should always pass any reasonable threshold
                    const result = analyzeCoverage(perfectReport, thresholds);
                    expect(result.passed).toBe(true);
                    expect(result.failures.length).toBe(0);
                }
            ),
            { 
                numRuns: 20,
                timeout: 5000
            }
        );
    });

    test("Property 28.5: Default and critical path thresholds should be properly configured", async () => {
        // This is a deterministic test that validates the threshold configuration
        
        // Default thresholds should be reasonable for general code
        expect(DEFAULT_THRESHOLDS.lines).toBeGreaterThanOrEqual(70);
        expect(DEFAULT_THRESHOLDS.lines).toBeLessThanOrEqual(90);
        
        expect(DEFAULT_THRESHOLDS.functions).toBeGreaterThanOrEqual(70);
        expect(DEFAULT_THRESHOLDS.functions).toBeLessThanOrEqual(90);
        
        expect(DEFAULT_THRESHOLDS.branches).toBeGreaterThanOrEqual(60);
        expect(DEFAULT_THRESHOLDS.branches).toBeLessThanOrEqual(85);
        
        expect(DEFAULT_THRESHOLDS.statements).toBeGreaterThanOrEqual(70);
        expect(DEFAULT_THRESHOLDS.statements).toBeLessThanOrEqual(90);
        
        // Critical path thresholds should be higher than default
        expect(CRITICAL_PATH_THRESHOLDS.lines).toBeGreaterThan(DEFAULT_THRESHOLDS.lines);
        expect(CRITICAL_PATH_THRESHOLDS.functions).toBeGreaterThan(DEFAULT_THRESHOLDS.functions);
        expect(CRITICAL_PATH_THRESHOLDS.branches).toBeGreaterThan(DEFAULT_THRESHOLDS.branches);
        expect(CRITICAL_PATH_THRESHOLDS.statements).toBeGreaterThan(DEFAULT_THRESHOLDS.statements);
        
        // Critical path thresholds should be achievable (not 100%)
        expect(CRITICAL_PATH_THRESHOLDS.lines).toBeLessThan(100);
        expect(CRITICAL_PATH_THRESHOLDS.functions).toBeLessThan(100);
        expect(CRITICAL_PATH_THRESHOLDS.branches).toBeLessThan(100);
        expect(CRITICAL_PATH_THRESHOLDS.statements).toBeLessThan(100);
        
        // Critical paths should be defined and non-empty
        expect(Array.isArray(CRITICAL_PATHS)).toBe(true);
        expect(CRITICAL_PATHS.length).toBeGreaterThan(0);
        
        // Each critical path should be a non-empty string
        for (const path of CRITICAL_PATHS) {
            expect(typeof path).toBe("string");
            expect(path.length).toBeGreaterThan(0);
            expect(path.startsWith("src/")).toBe(true);
        }
    });

    test("Property 28.6: Coverage analysis should handle edge cases gracefully", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    // Zero coverage case
                    fc.constant({
                        lines: { total: 100, covered: 0, pct: 0 },
                        functions: { total: 50, covered: 0, pct: 0 },
                        branches: { total: 80, covered: 0, pct: 0 },
                        statements: { total: 120, covered: 0, pct: 0 }
                    }),
                    // Perfect coverage case
                    fc.constant({
                        lines: { total: 100, covered: 100, pct: 100 },
                        functions: { total: 50, covered: 50, pct: 100 },
                        branches: { total: 80, covered: 80, pct: 100 },
                        statements: { total: 120, covered: 120, pct: 100 }
                    }),
                    // Minimal code case
                    fc.constant({
                        lines: { total: 1, covered: 1, pct: 100 },
                        functions: { total: 1, covered: 1, pct: 100 },
                        branches: { total: 1, covered: 1, pct: 100 },
                        statements: { total: 1, covered: 1, pct: 100 }
                    })
                ),
                async (report: CoverageReport) => {
                    const result = analyzeCoverage(report, DEFAULT_THRESHOLDS);
                    
                    // Analysis should complete without errors
                    expect(result).toBeDefined();
                    expect(result.report).toEqual(report);
                    expect(result.thresholds).toEqual(DEFAULT_THRESHOLDS);
                    expect(Array.isArray(result.failures)).toBe(true);
                    expect(typeof result.passed).toBe("boolean");
                    
                    // Perfect coverage should always pass
                    if (report.lines.pct === 100 && report.functions.pct === 100 && 
                        report.branches.pct === 100 && report.statements.pct === 100) {
                        expect(result.passed).toBe(true);
                        expect(result.failures.length).toBe(0);
                    }
                    
                    // Zero coverage should fail with default thresholds
                    if (report.lines.pct === 0 && report.functions.pct === 0 && 
                        report.branches.pct === 0 && report.statements.pct === 0) {
                        expect(result.passed).toBe(false);
                        expect(result.failures.length).toBeGreaterThan(0);
                    }
                }
            ),
            { 
                numRuns: 10,
                timeout: 4000
            }
        );
    });
});