#!/usr/bin/env bun
/**
 * Production Cleanup Script
 * Removes all development artifacts and ensures production readiness
 * 
 * @module scripts/production-cleanup
 * @date 2026-01-24
 */

import { $ } from "bun";

interface CleanupResult {
  category: string;
  filesRemoved: number;
  bytesFreed: number;
  errors: string[];
}

class ProductionCleanup {
  private results: CleanupResult[] = [];
  private totalBytesFreed = 0;
  private totalFilesRemoved = 0;

  /**
   * Clean up test database artifacts
   */
  async cleanTestDatabases(): Promise<CleanupResult> {
    const result: CleanupResult = {
      category: "Test Databases",
      filesRemoved: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      const patterns = [
        "**/.test_*.db",
        "**/.test_*.db-shm",
        "**/.test_*.db-wal",
        "**/test_*.sqlite",
        "**/test_*.sqlite-shm",
        "**/test_*.sqlite-wal",
        "**/test-sdk.db*",
      ];

      for (const pattern of patterns) {
        try {
          const files = await Array.fromAsync(
            new Bun.Glob(pattern).scan({ cwd: ".", absolute: true })
          );

          for (const file of files) {
            try {
              const stat = await Bun.file(file).stat();
              if (stat) {
                result.bytesFreed += stat.size;
                await Bun.spawn(["rm", "-f", file]).exited;
                result.filesRemoved++;
              }
            } catch (err) {
              result.errors.push(`Failed to remove ${file}: ${err}`);
            }
          }
        } catch (err) {
          result.errors.push(`Pattern ${pattern} failed: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Test database cleanup failed: ${err}`);
    }

    this.results.push(result);
    this.totalBytesFreed += result.bytesFreed;
    this.totalFilesRemoved += result.filesRemoved;
    return result;
  }

  /**
   * Clean up coverage and test output artifacts
   */
  async cleanCoverageArtifacts(): Promise<CleanupResult> {
    const result: CleanupResult = {
      category: "Coverage & Test Output",
      filesRemoved: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      const directories = [
        "packages/openmemory-js/.nyc_output",
        "packages/openmemory-js/coverage",
        "test_output",
        "test_phase",
      ];

      for (const dir of directories) {
        try {
          const dirPath = `${process.cwd()}/${dir}`;
          const dirFile = Bun.file(dirPath);
          
          if (await dirFile.exists()) {
            // Calculate size before removal
            const files = await Array.fromAsync(
              new Bun.Glob("**/*").scan({ cwd: dirPath, absolute: true })
            );
            
            for (const file of files) {
              try {
                const stat = await Bun.file(file).stat();
                if (stat) {
                  result.bytesFreed += stat.size;
                  result.filesRemoved++;
                }
              } catch {}
            }

            await Bun.spawn(["rm", "-rf", dirPath]).exited;
          }
        } catch (err) {
          result.errors.push(`Failed to remove ${dir}: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Coverage cleanup failed: ${err}`);
    }

    this.results.push(result);
    this.totalBytesFreed += result.bytesFreed;
    this.totalFilesRemoved += result.filesRemoved;
    return result;
  }

  /**
   * Clean up build artifacts
   */
  async cleanBuildArtifacts(): Promise<CleanupResult> {
    const result: CleanupResult = {
      category: "Build Artifacts",
      filesRemoved: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      const patterns = [
        "**/*.tsbuildinfo",
        "**/dist/**/*",
        "**/.next/cache/**/*",
      ];

      for (const pattern of patterns) {
        try {
          const files = await Array.fromAsync(
            new Bun.Glob(pattern).scan({ cwd: ".", absolute: true })
          );

          for (const file of files) {
            try {
              const stat = await Bun.file(file).stat();
              if (stat && !stat.isDirectory()) {
                result.bytesFreed += stat.size;
                await Bun.spawn(["rm", "-f", file]).exited;
                result.filesRemoved++;
              }
            } catch (err) {
              result.errors.push(`Failed to remove ${file}: ${err}`);
            }
          }
        } catch (err) {
          result.errors.push(`Pattern ${pattern} failed: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Build artifact cleanup failed: ${err}`);
    }

    this.results.push(result);
    this.totalBytesFreed += result.bytesFreed;
    this.totalFilesRemoved += result.filesRemoved;
    return result;
  }

  /**
   * Clean up temporary and log files
   */
  async cleanTemporaryFiles(): Promise<CleanupResult> {
    const result: CleanupResult = {
      category: "Temporary & Log Files",
      filesRemoved: 0,
      bytesFreed: 0,
      errors: [],
    };

    try {
      const patterns = [
        "**/*.log",
        "**/trace.txt",
        "**/hits.json",
        "**/final_test_output.txt",
        "**/omnibus_debug.txt",
        "**/tsc_final.txt",
        "**/tsc_real.txt",
      ];

      for (const pattern of patterns) {
        try {
          const files = await Array.fromAsync(
            new Bun.Glob(pattern).scan({ cwd: ".", absolute: true })
          );

          for (const file of files) {
            // Skip important log files in production
            if (file.includes("node_modules") || file.includes(".git")) {
              continue;
            }

            try {
              const stat = await Bun.file(file).stat();
              if (stat) {
                result.bytesFreed += stat.size;
                await Bun.spawn(["rm", "-f", file]).exited;
                result.filesRemoved++;
              }
            } catch (err) {
              result.errors.push(`Failed to remove ${file}: ${err}`);
            }
          }
        } catch (err) {
          result.errors.push(`Pattern ${pattern} failed: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Temporary file cleanup failed: ${err}`);
    }

    this.results.push(result);
    this.totalBytesFreed += result.bytesFreed;
    this.totalFilesRemoved += result.filesRemoved;
    return result;
  }

  /**
   * Verify git working directory is clean
   */
  async verifyGitClean(): Promise<{ clean: boolean; untrackedFiles: string[] }> {
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], {
        stdout: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const lines = output.trim().split("\n").filter(Boolean);
      
      const untrackedFiles = lines
        .filter(line => line.startsWith("??"))
        .map(line => line.substring(3));

      return {
        clean: lines.length === 0,
        untrackedFiles,
      };
    } catch (err) {
      console.error("Failed to check git status:", err);
      return { clean: false, untrackedFiles: [] };
    }
  }

  /**
   * Generate cleanup report
   */
  generateReport(): string {
    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    };

    let report = "\n=== Production Cleanup Report ===\n\n";
    
    for (const result of this.results) {
      report += `${result.category}:\n`;
      report += `  Files Removed: ${result.filesRemoved}\n`;
      report += `  Space Freed: ${formatBytes(result.bytesFreed)}\n`;
      
      if (result.errors.length > 0) {
        report += `  Errors: ${result.errors.length}\n`;
        result.errors.forEach(err => {
          report += `    - ${err}\n`;
        });
      }
      report += "\n";
    }

    report += `Total Summary:\n`;
    report += `  Total Files Removed: ${this.totalFilesRemoved}\n`;
    report += `  Total Space Freed: ${formatBytes(this.totalBytesFreed)}\n`;

    return report;
  }

  /**
   * Run complete cleanup process
   */
  async run(): Promise<void> {
    console.log("🧹 Starting production cleanup...\n");

    console.log("1. Cleaning test databases...");
    await this.cleanTestDatabases();

    console.log("2. Cleaning coverage artifacts...");
    await this.cleanCoverageArtifacts();

    console.log("3. Cleaning build artifacts...");
    await this.cleanBuildArtifacts();

    console.log("4. Cleaning temporary files...");
    await this.cleanTemporaryFiles();

    console.log("\n" + this.generateReport());

    console.log("5. Verifying git working directory...");
    const gitStatus = await this.verifyGitClean();
    
    if (gitStatus.clean) {
      console.log("✅ Git working directory is clean");
    } else {
      console.log("⚠️  Untracked files found:");
      gitStatus.untrackedFiles.forEach(file => {
        console.log(`  - ${file}`);
      });
    }

    console.log("\n✨ Production cleanup complete!");
  }
}

// Run cleanup if executed directly
if (import.meta.main) {
  const cleanup = new ProductionCleanup();
  await cleanup.run();
}

export { ProductionCleanup };
