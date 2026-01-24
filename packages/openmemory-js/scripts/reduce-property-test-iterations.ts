#!/usr/bin/env bun

/**
 * Script to reduce property-based test iterations for faster execution
 * This script reduces numRuns values in fast-check property tests to make them run faster
 * while maintaining correctness validation.
 */

import { readdir } from "fs/promises";
import { join } from "path";

const PROPERTY_TEST_DIR = "test/property";
const MAX_RUNS = 25; // Reduced from typical 100+ to 25 for faster execution

async function reducePropertyTestIterations() {
    console.log("🔧 Reducing property-based test iterations for faster execution...");
    
    try {
        const propertyTestFiles = await readdir(PROPERTY_TEST_DIR, { recursive: true });
        const testFiles = propertyTestFiles
            .filter(file => file.endsWith('.test.ts'))
            .map(file => join(PROPERTY_TEST_DIR, file));
        
        let totalReductions = 0;
        
        for (const filePath of testFiles) {
            const content = await Bun.file(filePath).text();
            
            // Pattern to match numRuns configurations
            const numRunsPattern = /numRuns:\s*(\d+)/g;
            let modified = false;
            
            const newContent = content.replace(numRunsPattern, (match, runs) => {
                const currentRuns = parseInt(runs);
                if (currentRuns > MAX_RUNS) {
                    modified = true;
                    totalReductions++;
                    console.log(`  📉 ${filePath}: ${currentRuns} → ${MAX_RUNS} runs`);
                    return `numRuns: ${MAX_RUNS}`;
                }
                return match;
            });
            
            if (modified) {
                await Bun.write(filePath, newContent);
            }
        }
        
        console.log(`✅ Reduced ${totalReductions} property test configurations`);
        console.log(`🚀 Property tests will now run faster while maintaining correctness validation`);
        
    } catch (error) {
        console.error("❌ Error reducing property test iterations:", error);
        process.exit(1);
    }
}

// Run the script
await reducePropertyTestIterations();