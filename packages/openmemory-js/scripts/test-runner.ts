#!/usr/bin/env bun

/**
 * OpenMemory Resilient Test Framework
 * Memory-aware test execution with OOM prevention and intelligent resource management
 * Enhanced with robust process management and automatic termination
 */

import { $ } from "bun";
import { testProcessManager, runTestCommand } from "../src/utils/testProcessManager";
import { preTestCleanup, postTestCleanup } from "../src/utils/testCleanup";
import { initializeTestWatchdog, stopTestWatchdog, runWithWatchdog } from "../src/utils/testWatchdog";
import { 
    getTestFrameworkConfig, 
    getFrameworkSummary, 
    validateSystemRequirements,
    calculateMemoryLimit,
    getTestEnvironment,
    type TestPhaseConfig
} from "../src/utils/testConfig";

/**
 * Monitor memory usage during test execution
 */
function monitorMemoryUsage(phaseName: string, memoryLimit: number): Timer {
    const config = getTestFrameworkConfig();
    
    return setInterval(() => {
        const usage = process.memoryUsage();
        const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
        const memoryLimitMB = Math.round(memoryLimit);
        
        const usagePercent = heapUsedMB / memoryLimitMB;
        
        if (usagePercent > config.memory.warningThreshold) {
            console.warn(`⚠️  [${phaseName}] High memory usage: ${heapUsedMB}MB/${memoryLimitMB}MB (${Math.round(usagePercent * 100)}%)`);
            
            // Force garbage collection if available
            if (global.gc) {
                console.log(`🗑️  [${phaseName}] Running garbage collection...`);
                global.gc();
            }
            
            // If memory usage is critical, terminate
            if (usagePercent > config.memory.criticalThreshold) {
                console.error(`🚨 [${phaseName}] Critical memory usage (${Math.round(usagePercent * 100)}%), terminating phase`);
                throw new Error(`Memory exhaustion in phase: ${phaseName}`);
            }
        }
    }, config.memory.checkInterval);
}

async function runPhase(phase: TestPhaseConfig): Promise<boolean> {
    const config = getTestFrameworkConfig();
    const memoryLimit = calculateMemoryLimit(phase);
    
    console.log(`\n🧪 Running ${phase.name}...`);
    console.log(`   📝 ${phase.description}`);
    console.log(`   🧠 Memory limit: ${memoryLimit}MB (${Math.round(phase.memoryLimitPercent * 100)}% of system)`);
    console.log(`   ⏱️  Timeout: ${phase.timeout}ms`);
    console.log(`   🔒 Process isolation: ${phase.isolateProcess ? 'enabled' : 'disabled'}`);
    console.log(`   🎯 Critical: ${phase.critical ? 'yes' : 'no'}`);
    console.log(`   🔄 Retry attempts: ${phase.retryAttempts}`);
    
    let attempts = 0;
    const maxAttempts = phase.retryAttempts + 1;
    
    while (attempts < maxAttempts) {
        if (attempts > 0) {
            console.log(`   🔄 Retry attempt ${attempts}/${phase.retryAttempts}...`);
        }
        
        const success = await runWithWatchdog(`Phase: ${phase.name}`, async () => {
            // Start memory monitoring
            const memoryMonitor = monitorMemoryUsage(phase.name, memoryLimit);
            
            try {
                // Force garbage collection before starting phase
                if (global.gc) {
                    global.gc();
                }
                
                // Run each pattern separately and collect results
                let totalPassed = 0;
                let totalFailed = 0;
                let allPassed = true;
                
                for (const pattern of phase.patterns) {
                    const processId = `test-${phase.id}-${Date.now()}`;
                    
                    // Use the robust process manager for test execution
                    const result = await runTestCommand(
                        processId,
                        ['bun', 'test', '--timeout', phase.timeout.toString(), pattern],
                        {
                            timeout: phase.timeout + 10000, // Add 10s buffer for process management
                            killOnTimeout: true,
                            env: getTestEnvironment(phase),
                            memoryLimit,
                            isolateProcess: phase.isolateProcess
                        }
                    );
                    
                    // Parse output for test results
                    const fullOutput = result.output;
                    const passMatch = fullOutput.match(/(\d+) pass/);
                    const failMatch = fullOutput.match(/(\d+) fail/);
                    
                    if (passMatch) {
                        totalPassed += parseInt(passMatch[1]);
                    }
                    if (failMatch) {
                        totalFailed += parseInt(failMatch[1]);
                    }
                    
                    if (!result.success) {
                        allPassed = false;
                        console.log(`❌ Failed pattern ${pattern}:`);
                        
                        // Show only the actual test failures, not the full stderr
                        const lines = (result.error || '').split('\n');
                        const errorLines = lines.filter(line => 
                            line.includes('error:') || 
                            line.includes('Expected:') || 
                            line.includes('Received:') ||
                            line.includes('(fail)') ||
                            line.includes('memory') ||
                            line.includes('timeout') ||
                            line.includes('OOM') ||
                            line.includes('exceeded')
                        );
                        if (errorLines.length > 0) {
                            console.log(errorLines.slice(0, 10).join('\n')); // Show first 10 error lines
                        }
                    }
                    
                    // Force garbage collection between patterns if available
                    if (global.gc && phase.patterns.length > 1) {
                        global.gc();
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause for GC
                    }
                }
                
                if (allPassed) {
                    console.log(`✅ ${phase.name} - PASSED (${totalPassed} tests)`);
                    return true;
                } else {
                    console.log(`❌ ${phase.name} - FAILED (${totalPassed} passed, ${totalFailed} failed)`);
                    return false;
                }
                
            } finally {
                // Stop memory monitoring
                clearInterval(memoryMonitor);
                
                // Final garbage collection
                if (global.gc) {
                    global.gc();
                }
            }
        }, Math.round(phase.timeout * config.timeouts.watchdogBuffer)); // Watchdog timeout with buffer
        
        if (success) {
            return true;
        }
        
        attempts++;
        
        // If this was the last attempt or phase is not critical, break
        if (attempts >= maxAttempts) {
            break;
        }
        
        // Brief pause before retry
        console.log(`   ⏳ Waiting 3 seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    return false;
}

async function main() {
    const config = getTestFrameworkConfig();
    
    // Display framework summary
    console.log(getFrameworkSummary());
    
    // Validate system requirements
    const validation = validateSystemRequirements();
    if (!validation.valid) {
        console.error("❌ System requirements not met:");
        validation.issues.forEach(issue => console.error(`   • ${issue}`));
        console.error("\n💡 Consider upgrading your system or adjusting memory limits.");
        process.exit(1);
    }
    
    // Initialize watchdog with memory-aware timeouts
    const totalEstimatedTime = config.phases.reduce((sum, phase) => sum + phase.timeout, 0);
    const watchdogTimeout = Math.max(totalEstimatedTime * 2, 900000); // At least 15 minutes
    
    initializeTestWatchdog({
        maxExecutionTime: watchdogTimeout,
        warningThreshold: 0.8, // Warn at 80%
        checkInterval: 5000, // Check every 5 seconds
        forceKillProcess: true, // Force kill on timeout
        onBeforeTerminate: async () => {
            console.error("🚨 TEST FRAMEWORK TIMEOUT: Force terminating stuck tests...");
            await testProcessManager.stopAllProcesses();
            await postTestCleanup();
        }
    });
    
    // Set up cleanup handlers
    testProcessManager.addShutdownHandler(async () => {
        console.log("🧹 Running test cleanup...");
        stopTestWatchdog();
        await postTestCleanup();
    });
    
    // Run pre-test cleanup
    console.log("🧹 Pre-test cleanup...");
    await preTestCleanup();
    
    // Set global test environment
    const globalEnv = getTestEnvironment();
    Object.entries(globalEnv).forEach(([key, value]) => {
        process.env[key] = value;
    });
    
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const phaseResults: Array<{ 
        name: string; 
        success: boolean; 
        duration: number; 
        critical: boolean;
        skipped: boolean;
    }> = [];
    
    try {
        // Run all phases with watchdog protection
        await runWithWatchdog("Complete Test Framework", async () => {
            for (const phase of config.phases) {
                const startTime = Date.now();
                let success = false;
                let wasSkipped = false;
                
                // Skip non-critical phases if previous critical phases failed
                if (!phase.critical && failed > 0) {
                    console.log(`\n⏭️  Skipping non-critical phase: ${phase.name} (previous critical failures)`);
                    wasSkipped = true;
                    skipped++;
                } else {
                    success = await runPhase(phase);
                    
                    if (success) {
                        passed++;
                    } else {
                        failed++;
                        
                        // If this is a critical phase and it failed, consider stopping
                        if (phase.critical) {
                            console.warn(`⚠️  Critical phase ${phase.name} failed. Continuing with remaining phases...`);
                        }
                    }
                }
                
                const duration = Date.now() - startTime;
                phaseResults.push({ 
                    name: phase.name, 
                    success, 
                    duration, 
                    critical: phase.critical,
                    skipped: wasSkipped
                });
                
                // Brief pause between phases for memory cleanup
                if (!wasSkipped) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }, watchdogTimeout);
        
    } catch (error) {
        console.error("💥 Test framework failed or timed out:", error);
        failed = config.phases.length; // Mark all as failed if framework times out
    } finally {
        // Ensure all processes are cleaned up
        console.log("🧹 Cleaning up test processes...");
        await testProcessManager.stopAllProcesses();
        
        // Stop watchdog
        stopTestWatchdog();
        
        // Run post-test cleanup
        await postTestCleanup();
    }
    
    console.log("\n📊 OpenMemory Resilient Test Framework Results");
    console.log("==============================================");
    console.log(`✅ Passed Phases: ${passed}`);
    console.log(`❌ Failed Phases: ${failed}`);
    console.log(`⏭️  Skipped Phases: ${skipped}`);
    console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed + skipped)) * 100)}%`);
    
    // Detailed phase results
    console.log("\n📋 Phase Details:");
    phaseResults.forEach(result => {
        let status = "⏭️  SKIP";
        if (!result.skipped) {
            status = result.success ? "✅ PASS" : "❌ FAIL";
        }
        const duration = Math.round(result.duration / 1000);
        const critical = result.critical ? " (CRITICAL)" : "";
        console.log(`   ${status} ${result.name}${critical} (${duration}s)`);
    });
    
    // Summary and recommendations
    const criticalFailed = phaseResults.filter(r => r.critical && !r.success && !r.skipped).length;
    
    if (criticalFailed > 0) {
        console.log(`\n🚨 ${criticalFailed} critical phase(s) failed. OpenMemory may not function correctly.`);
        console.log("💡 Review the error output above and fix critical issues before deployment.");
        process.exit(1);
    } else if (failed > 0) {
        console.log(`\n⚠️  ${failed} non-critical phase(s) failed. Core functionality should work.`);
        console.log("💡 Consider addressing these issues for optimal performance.");
        process.exit(0); // Non-critical failures don't fail the build
    } else {
        console.log("\n🎉 All test phases passed! OpenMemory is ready for production.");
        console.log("🚀 System is stable and memory-efficient.");
        process.exit(0);
    }
}

main().catch((error) => {
    console.error("💥 OpenMemory Resilient Test Framework failed:", error);
    process.exit(1);
});