#!/usr/bin/env python3
"""
Python Security Scanning Script for OpenMemory
Runs pip-audit, safety, and bandit security scans
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Any
import argparse


class SecurityScanner:
    """Comprehensive security scanner for Python packages"""
    
    def __init__(self, output_dir: Path = None):
        self.output_dir = output_dir or Path("security-reports")
        self.output_dir.mkdir(exist_ok=True)
        
    def run_pip_audit(self) -> Dict[str, Any]:
        """Run pip-audit for dependency vulnerability scanning"""
        print("🔍 Running pip-audit for dependency vulnerabilities...")
        
        try:
            result = subprocess.run([
                "pip-audit", 
                "--desc", 
                "--format=json"
            ], capture_output=True, text=True, check=False)
            
            if result.returncode == 0:
                audit_data = json.loads(result.stdout) if result.stdout else {"vulnerabilities": []}
                
                # Save report
                report_path = self.output_dir / "pip-audit-report.json"
                with open(report_path, "w") as f:
                    json.dump(audit_data, f, indent=2)
                
                vuln_count = len(audit_data.get("vulnerabilities", []))
                print(f"✅ pip-audit completed: {vuln_count} vulnerabilities found")
                return audit_data
            else:
                print(f"❌ pip-audit failed: {result.stderr}")
                return {"error": result.stderr, "vulnerabilities": []}
                
        except FileNotFoundError:
            print("❌ pip-audit not found. Install with: pip install pip-audit")
            return {"error": "pip-audit not installed", "vulnerabilities": []}
    
    def run_safety(self) -> Dict[str, Any]:
        """Run safety for known security vulnerabilities"""
        print("🔍 Running safety for known security vulnerabilities...")
        
        try:
            result = subprocess.run([
                "safety", "check", 
                "--json"
            ], capture_output=True, text=True, check=False)
            
            # Safety returns non-zero exit code when vulnerabilities are found
            if result.stdout:
                safety_data = json.loads(result.stdout)
                
                # Save report
                report_path = self.output_dir / "safety-report.json"
                with open(report_path, "w") as f:
                    json.dump(safety_data, f, indent=2)
                
                vuln_count = len(safety_data) if isinstance(safety_data, list) else 0
                print(f"✅ safety completed: {vuln_count} vulnerabilities found")
                return {"vulnerabilities": safety_data}
            else:
                print("✅ safety completed: No vulnerabilities found")
                return {"vulnerabilities": []}
                
        except FileNotFoundError:
            print("❌ safety not found. Install with: pip install safety")
            return {"error": "safety not installed", "vulnerabilities": []}
    
    def run_bandit(self) -> Dict[str, Any]:
        """Run bandit for static security analysis"""
        print("🔍 Running bandit for static security analysis...")
        
        src_path = Path("src")
        if not src_path.exists():
            print("⚠️  src/ directory not found, skipping bandit")
            return {"issues": []}
        
        try:
            result = subprocess.run([
                "bandit", "-r", "src/", 
                "-f", "json"
            ], capture_output=True, text=True, check=False)
            
            if result.stdout:
                bandit_data = json.loads(result.stdout)
                
                # Save report
                report_path = self.output_dir / "bandit-report.json"
                with open(report_path, "w") as f:
                    json.dump(bandit_data, f, indent=2)
                
                issue_count = len(bandit_data.get("results", []))
                print(f"✅ bandit completed: {issue_count} security issues found")
                return bandit_data
            else:
                print("✅ bandit completed: No security issues found")
                return {"results": []}
                
        except FileNotFoundError:
            print("❌ bandit not found. Install with: pip install bandit")
            return {"error": "bandit not installed", "results": []}
    
    def generate_summary_report(self, pip_audit: Dict, safety: Dict, bandit: Dict) -> Dict[str, Any]:
        """Generate a comprehensive security summary report"""
        
        # Count vulnerabilities
        pip_audit_count = len(pip_audit.get("vulnerabilities", []))
        safety_count = len(safety.get("vulnerabilities", []))
        bandit_count = len(bandit.get("results", []))
        
        # Categorize severity
        high_severity = 0
        medium_severity = 0
        low_severity = 0
        
        # Process pip-audit vulnerabilities
        for vuln in pip_audit.get("vulnerabilities", []):
            severity = vuln.get("severity", "unknown").lower()
            if severity in ["high", "critical"]:
                high_severity += 1
            elif severity == "medium":
                medium_severity += 1
            else:
                low_severity += 1
        
        # Process bandit issues
        for issue in bandit.get("results", []):
            severity = issue.get("issue_severity", "unknown").lower()
            if severity in ["high", "critical"]:
                high_severity += 1
            elif severity == "medium":
                medium_severity += 1
            else:
                low_severity += 1
        
        summary = {
            "scan_timestamp": subprocess.run(["date", "-Iseconds"], capture_output=True, text=True).stdout.strip(),
            "total_vulnerabilities": pip_audit_count + safety_count + bandit_count,
            "by_tool": {
                "pip_audit": pip_audit_count,
                "safety": safety_count,
                "bandit": bandit_count
            },
            "by_severity": {
                "high": high_severity,
                "medium": medium_severity,
                "low": low_severity
            },
            "recommendations": []
        }
        
        # Add recommendations
        if summary["total_vulnerabilities"] == 0:
            summary["recommendations"].append("✅ No security vulnerabilities detected")
        else:
            if high_severity > 0:
                summary["recommendations"].append(f"🚨 CRITICAL: {high_severity} high-severity vulnerabilities require immediate attention")
            if medium_severity > 0:
                summary["recommendations"].append(f"⚠️  {medium_severity} medium-severity issues should be addressed")
            if pip_audit_count > 0:
                summary["recommendations"].append("📦 Update vulnerable dependencies identified by pip-audit")
            if bandit_count > 0:
                summary["recommendations"].append("🔒 Review code security issues identified by bandit")
        
        # Save summary report
        summary_path = self.output_dir / "security-summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2)
        
        return summary
    
    def run_full_scan(self) -> Dict[str, Any]:
        """Run all security scans and generate comprehensive report"""
        print("🚀 Starting comprehensive Python security scan...")
        print(f"📁 Reports will be saved to: {self.output_dir}")
        
        # Run all scans
        pip_audit_results = self.run_pip_audit()
        safety_results = self.run_safety()
        bandit_results = self.run_bandit()
        
        # Generate summary
        summary = self.generate_summary_report(pip_audit_results, safety_results, bandit_results)
        
        # Print summary
        print("\n" + "="*60)
        print("🛡️  SECURITY SCAN SUMMARY")
        print("="*60)
        print(f"Total Vulnerabilities: {summary['total_vulnerabilities']}")
        print(f"  - pip-audit: {summary['by_tool']['pip_audit']}")
        print(f"  - safety: {summary['by_tool']['safety']}")
        print(f"  - bandit: {summary['by_tool']['bandit']}")
        print(f"\nSeverity Breakdown:")
        print(f"  - High: {summary['by_severity']['high']}")
        print(f"  - Medium: {summary['by_severity']['medium']}")
        print(f"  - Low: {summary['by_severity']['low']}")
        
        print(f"\nRecommendations:")
        for rec in summary['recommendations']:
            print(f"  {rec}")
        
        print(f"\n📊 Detailed reports saved to: {self.output_dir}/")
        
        return summary


def main():
    parser = argparse.ArgumentParser(description="Python Security Scanner for OpenMemory")
    parser.add_argument("--output-dir", "-o", type=Path, default="security-reports",
                       help="Output directory for security reports")
    parser.add_argument("--tool", "-t", choices=["pip-audit", "safety", "bandit", "all"], 
                       default="all", help="Specific tool to run")
    
    args = parser.parse_args()
    
    scanner = SecurityScanner(args.output_dir)
    
    if args.tool == "all":
        summary = scanner.run_full_scan()
        # Exit with error code if vulnerabilities found
        sys.exit(1 if summary["total_vulnerabilities"] > 0 else 0)
    elif args.tool == "pip-audit":
        results = scanner.run_pip_audit()
        sys.exit(1 if len(results.get("vulnerabilities", [])) > 0 else 0)
    elif args.tool == "safety":
        results = scanner.run_safety()
        sys.exit(1 if len(results.get("vulnerabilities", [])) > 0 else 0)
    elif args.tool == "bandit":
        results = scanner.run_bandit()
        sys.exit(1 if len(results.get("results", [])) > 0 else 0)


if __name__ == "__main__":
    main()