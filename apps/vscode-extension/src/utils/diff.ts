
/**
 * Simple Line-based Diff Implementation
 * Generates a unified diff-like output string.
 */

export function generateDiff(oldText: string, newText: string, filePath: string): string {
    const oldLines = oldText.split(/\r?\n/);
    const newLines = newText.split(/\r?\n/);

    const dp: number[][] = Array(oldLines.length + 1).fill(0).map(() => Array(newLines.length + 1).fill(0));

    // Calculate LCS matrix
    for (let i = 1; i <= oldLines.length; i++) {
        for (let j = 1; j <= newLines.length; j++) {
            dp[i][j] = (oldLines[i - 1] === newLines[j - 1])
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    const changes: string[] = [];
    let i = oldLines.length;
    let j = newLines.length;

    // Backtrack to find diff
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            i--;
            j--;
            continue;
        }

        if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            changes.unshift("+ " + newLines[j - 1]);
            j--;
            continue;
        }

        changes.unshift("- " + oldLines[i - 1]);
        i--;
    }

    if (changes.length === 0) return "No changes detected.";

    return `Diff for ${filePath}:\n` + changes.join("\n");
}
