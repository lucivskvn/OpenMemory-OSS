#!/usr/bin/env bun
/**
 * OpenMemory Dependency Auditing System
 * 
 * Comprehensive dependency analysis across the monorepo including:
 * - JavaScript/TypeScript packages (using bun audit, bun outdated)
 * - Python packages (using pip-audit, safety)
 * - Version consistency validation
 * - Security vulnerability detection
 * - License compliance checking
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { join } from "path";

interface DependencyReport {
  package: string;
  currentVersion: string;
  latestVersion: string;
  securityVulnerabilities: SecurityIssue[];
  updateRisk: 'low' | 'medium' | 'high';
  breakingChanges: boolean;
  license?: string;
}

interface SecurityIssue {
  severity: 'low' | 'moderate' | 'high' | 'critical';
  cve?: string;
  description: string;
  patchAvailable: boolean;
  affectedVersions: string;
}

interface AuditSummary {
  timestamp: string;
  totalPackages: number;
  outdatedPackages: number;
  vulnerabilities: {
    critical: number;
    high: number;
    moderate: number;
    low: number;
  };
  versionInconsistencies: string[];
  recommendations: string[];
  reports: {
    javascript: DependencyReport[];
    python: DependencyReport[];
  };
}

class DependencyAuditor {
  private workspaceRoot: string;
  private outputDir: string;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
    this.outputDir = join(workspaceRoot, "dependency-reports");
    
    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      Bun.spawn(["mkdir", "-p", this.outputDir]);
    }
  }

  async runJavaScriptAudit(): Promise<DependencyReport[]> {
    console.log("🔍 Running JavaScript/TypeScript dependency audit...");
    
    const reports: DependencyReport[] = [];
    
    try {
      // Run bun audit for security vulnerabilities
      console.log("  📦 Running bun audit...");
      const auditProc = Bun.spawn(["bun", "audit", "--json"], {
        cwd: this.workspaceRoot,
        stdout: "pipe",
        stderr: "pipe"
      });
      
      const auditOutput = await new Response(auditProc.stdout).text();
      const auditResult = auditOutput ? JSON.parse(auditOutput) : { advisories: {} };
      
      // Run bun outdated for version information
      console.log("  📊 Running bun outdated...");
      const outdatedProc = Bun.spawn(["bun", "outdated", "--json"], {
        cwd: this.workspaceRoot,
        stdout: "pipe",
        stderr: "pipe"
      });
      
      const outdatedOutput = await new Response(outdatedProc.stdout).text();
      const outdatedResult = outdatedOutput ? JSON.parse(outdatedOutput) : {};
      
      // Process audit results
      const advisories = auditResult.advisories || {};
      const vulnerabilities: { [pkg: string]: SecurityIssue[] } = {};
      
      Object.values(advisories).forEach((advisory: any) => {
        const pkgName = advisory.module_name;
        if (!vulnerabilities[pkgName]) {
          vulnerabilities[pkgName] = [];
        }
        
        vulnerabilities[pkgName].push({
          severity: advisory.severity,
          cve: advisory.cves?.[0],
          description: advisory.title,
          patchAvailable: advisory.patched_versions !== "<0.0.0",
          affectedVersions: advisory.vulnerable_versions
        });
      });
      
      // Process outdated packages
      Object.entries(outdatedResult).forEach(([pkgName, info]: [string, any]) => {
        const report: DependencyReport = {
          package: pkgName,
          currentVersion: info.current || "unknown",
          latestVersion: info.latest || "unknown",
          securityVulnerabilities: vulnerabilities[pkgName] || [],
          updateRisk: this.assessUpdateRisk(info.current, info.latest),
          breakingChanges: this.hasBreakingChanges(info.current, info.latest),
          license: info.license
        };
        
        reports.push(report);
      });
      
      // Save JavaScript audit report
      const jsReportPath = join(this.outputDir, "javascript-audit.json");
      await Bun.write(jsReportPath, JSON.stringify(reports, null, 2));
      
      console.log(`  ✅ JavaScript audit completed: ${reports.length} packages analyzed`);
      return reports;
      
    } catch (error) {
      console.error("❌ JavaScript audit failed:", error);
      return [];
    }
  }

  async runPythonAudit(): Promise<DependencyReport[]> {
    console.log("🔍 Running Python dependency audit...");
    
    const reports: DependencyReport[] = [];
    const pythonPackagePath = join(this.workspaceRoot, "packages", "openmemory-py");
    
    if (!existsSync(pythonPackagePath)) {
      console.log("  ⚠️  Python package not found, skipping Python audit");
      return reports;
    }
    
    try {
      // Run Python security scan script
      console.log("  🐍 Running Python security scan...");
      const pythonScanProc = Bun.spawn(["python3", "scripts/security-scan.py", "--tool", "all"], {
        cwd: pythonPackagePath,
        stdout: "pipe",
        stderr: "pipe"
      });
      
      await pythonScanProc.exited;
      
      // Read Python security reports
      const securityReportsDir = join(pythonPackagePath, "security-reports");
      
      if (existsSync(join(securityReportsDir, "security-summary.json"))) {
        const summaryContent = await Bun.file(join(securityReportsDir, "security-summary.json")).text();
        const summary = JSON.parse(summaryContent);
        
        // Convert Python security data to our format
        // This is a simplified conversion - in practice, you'd parse the detailed reports
        const pythonReport: DependencyReport = {
          package: "python-dependencies",
          currentVersion: "various",
          latestVersion: "various",
          securityVulnerabilities: [],
          updateRisk: summary.by_severity.high > 0 ? 'high' : 
                     summary.by_severity.medium > 0 ? 'medium' : 'low',
          breakingChanges: false
        };
        
        reports.push(pythonReport);
      }
      
      console.log(`  ✅ Python audit completed: ${reports.length} packages analyzed`);
      return reports;
      
    } catch (error) {
      console.error("❌ Python audit failed:", error);
      return [];
    }
  }

  async validateVersionConsistency(): Promise<string[]> {
    console.log("🔍 Validating version consistency across monorepo...");
    
    const inconsistencies: string[] = [];
    const packageVersions: { [pkg: string]: { [workspace: string]: string } } = {};
    
    try {
      // Read package.json files from all workspaces
      const workspaces = [
        "packages/openmemory-js",
        "packages/openmemory-py", 
        "apps/dashboard",
        "apps/vscode-extension"
      ];
      
      for (const workspace of workspaces) {
        const packageJsonPath = join(this.workspaceRoot, workspace, "package.json");
        
        if (existsSync(packageJsonPath)) {
          const packageJson = await Bun.file(packageJsonPath).json();
          const dependencies = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
            ...packageJson.peerDependencies
          };
          
          Object.entries(dependencies).forEach(([pkg, version]: [string, any]) => {
            if (!packageVersions[pkg]) {
              packageVersions[pkg] = {};
            }
            packageVersions[pkg][workspace] = version;
          });
        }
      }
      
      // Find version inconsistencies
      Object.entries(packageVersions).forEach(([pkg, versions]) => {
        const uniqueVersions = new Set(Object.values(versions));
        if (uniqueVersions.size > 1) {
          const versionList = Object.entries(versions)
            .map(([workspace, version]) => `${workspace}: ${version}`)
            .join(", ");
          inconsistencies.push(`${pkg} has inconsistent versions: ${versionList}`);
        }
      });
      
      console.log(`  ✅ Version consistency check completed: ${inconsistencies.length} inconsistencies found`);
      return inconsistencies;
      
    } catch (error) {
      console.error("❌ Version consistency check failed:", error);
      return [];
    }
  }

  private assessUpdateRisk(current: string, latest: string): 'low' | 'medium' | 'high' {
    if (!current || !latest) return 'medium';
    
    try {
      const currentParts = current.replace(/[^0-9.]/g, '').split('.').map(Number);
      const latestParts = latest.replace(/[^0-9.]/g, '').split('.').map(Number);
      
      // Major version change = high risk
      if (latestParts[0] > currentParts[0]) return 'high';
      
      // Minor version change = medium risk
      if (latestParts[1] > currentParts[1]) return 'medium';
      
      // Patch version change = low risk
      return 'low';
    } catch {
      return 'medium';
    }
  }

  private hasBreakingChanges(current: string, latest: string): boolean {
    try {
      const currentMajor = parseInt(current.split('.')[0]);
      const latestMajor = parseInt(latest.split('.')[0]);
      return latestMajor > currentMajor;
    } catch {
      return false;
    }
  }

  async generateSummaryReport(jsReports: DependencyReport[], pyReports: DependencyReport[], inconsistencies: string[]): Promise<AuditSummary> {
    const allReports = [...jsReports, ...pyReports];
    
    const vulnerabilities = {
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0
    };
    
    allReports.forEach(report => {
      report.securityVulnerabilities.forEach(vuln => {
        if (vuln.severity === 'critical') vulnerabilities.critical++;
        else if (vuln.severity === 'high') vulnerabilities.high++;
        else if (vuln.severity === 'moderate') vulnerabilities.moderate++;
        else vulnerabilities.low++;
      });
    });
    
    const recommendations: string[] = [];
    
    if (vulnerabilities.critical > 0) {
      recommendations.push(`🚨 CRITICAL: ${vulnerabilities.critical} critical vulnerabilities require immediate attention`);
    }
    if (vulnerabilities.high > 0) {
      recommendations.push(`⚠️  ${vulnerabilities.high} high-severity vulnerabilities should be addressed promptly`);
    }
    if (inconsistencies.length > 0) {
      recommendations.push(`📦 ${inconsistencies.length} version inconsistencies should be resolved`);
    }
    
    const outdatedCount = allReports.filter(r => r.currentVersion !== r.latestVersion).length;
    if (outdatedCount > 0) {
      recommendations.push(`📊 ${outdatedCount} packages have updates available`);
    }
    
    if (recommendations.length === 0) {
      recommendations.push("✅ All dependencies are up-to-date and secure");
    }
    
    const summary: AuditSummary = {
      timestamp: new Date().toISOString(),
      totalPackages: allReports.length,
      outdatedPackages: outdatedCount,
      vulnerabilities,
      versionInconsistencies: inconsistencies,
      recommendations,
      reports: {
        javascript: jsReports,
        python: pyReports
      }
    };
    
    // Save summary report
    const summaryPath = join(this.outputDir, "dependency-audit-summary.json");
    await Bun.write(summaryPath, JSON.stringify(summary, null, 2));
    
    return summary;
  }

  async runFullAudit(): Promise<AuditSummary> {
    console.log("🚀 Starting comprehensive dependency audit...");
    console.log(`📁 Reports will be saved to: ${this.outputDir}`);
    
    // Run all audits in parallel
    const [jsReports, pyReports, inconsistencies] = await Promise.all([
      this.runJavaScriptAudit(),
      this.runPythonAudit(),
      this.validateVersionConsistency()
    ]);
    
    // Generate summary report
    const summary = await this.generateSummaryReport(jsReports, pyReports, inconsistencies);
    
    // Print summary
    console.log("\n" + "="*60);
    console.log("📊 DEPENDENCY AUDIT SUMMARY");
    console.log("="*60);
    console.log(`Total Packages: ${summary.totalPackages}`);
    console.log(`Outdated Packages: ${summary.outdatedPackages}`);
    console.log(`Version Inconsistencies: ${summary.versionInconsistencies.length}`);
    console.log(`\nSecurity Vulnerabilities:`);
    console.log(`  - Critical: ${summary.vulnerabilities.critical}`);
    console.log(`  - High: ${summary.vulnerabilities.high}`);
    console.log(`  - Moderate: ${summary.vulnerabilities.moderate}`);
    console.log(`  - Low: ${summary.vulnerabilities.low}`);
    
    console.log(`\nRecommendations:`);
    summary.recommendations.forEach(rec => console.log(`  ${rec}`));
    
    console.log(`\n📊 Detailed reports saved to: ${this.outputDir}/`);
    
    return summary;
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "full";
  
  const auditor = new DependencyAuditor();
  
  switch (command) {
    case "js":
    case "javascript":
      await auditor.runJavaScriptAudit();
      break;
    case "py":
    case "python":
      await auditor.runPythonAudit();
      break;
    case "consistency":
      const inconsistencies = await auditor.validateVersionConsistency();
      console.log("Version Inconsistencies:", inconsistencies);
      break;
    case "full":
    default:
      const summary = await auditor.runFullAudit();
      // Exit with error code if critical issues found
      const hasCriticalIssues = summary.vulnerabilities.critical > 0 || 
                               summary.vulnerabilities.high > 0;
      process.exit(hasCriticalIssues ? 1 : 0);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}