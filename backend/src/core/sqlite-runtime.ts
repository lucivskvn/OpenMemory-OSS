/**
 * Cross-runtime SQLite compatibility layer for OpenMemory
 *
 * This module provides runtime detection and unified interface for SQLite
 * implementations across different JavaScript runtimes:
 * - Bun: Uses bun:sqlite (preferred for performance)
 * - Node.js: Uses node:sqlite (22.12.0+ required)
 *
 * The module exports a unified Database class that works across runtimes.
 */

interface SQLiteDatabase {
    run(sql: string, params?: any[]): void;
    get<T = any>(sql: string, params?: any[]): T | undefined;
    all<T = any>(sql: string, params?: any[]): T[];
    prepare(sql: string): SQLiteStatement;
    close(): void;
    // Backup functionality (available in Node.js SQLite)
    backup?(destPath: string): SQLiteBackup;
    exec?(sql: string): void;
}

interface SQLiteBackup {
    pageCount: number;
    remaining: number;
    step(pages: number): void;
    finish(): void;
}

interface SQLiteStatement {
    run(params?: any[]): void;
    get<T = any>(params?: any[]): T | undefined;
    all<T = any>(params?: any[]): T[];
    finalize(): void;
}

/**
 * Runtime capability detection
 */
export function detectSQLiteCapabilities(): {
    runtime: "bun" | "node" | "unknown";
    hasBunSQLite: boolean;
    hasNodeSQLite: boolean;
    recommended: "bun" | "node" | null;
} {
    const isBun = typeof Bun !== "undefined";

    if (isBun) {
        return {
            runtime: "bun" as const,
            hasBunSQLite: true,
            hasNodeSQLite: false, // Bun doesn't have node:sqlite
            recommended: "bun" as const,
        };
    }

    // Check for Node.js SQLite support
    try {
        // Use dynamic import to avoid static analysis issues with Bun
        // Only check if we're actually running in Node.js
        if (typeof global !== "undefined" && !global.Bun) {
            require("node:sqlite");
            return {
                runtime: "node" as const,
                hasBunSQLite: false,
                hasNodeSQLite: true,
                recommended: "node" as const,
            };
        }
        return {
            runtime: "node" as const,
            hasBunSQLite: false,
            hasNodeSQLite: false,
            recommended: null,
        };
    } catch {
        return {
            runtime: "node" as const,
            hasBunSQLite: false,
            hasNodeSQLite: false,
            recommended: null,
        };
    }
}

/**
 * Create a SQLite database instance using the best available runtime implementation
 */
export async function createSQLiteDatabase(
    path: string,
): Promise<SQLiteDatabase> {
    const capabilities = detectSQLiteCapabilities();

    if (capabilities.recommended === "bun") {
        // Use Bun's native SQLite with wrapper to add convenience methods
        const { Database } = await import("bun:sqlite");
        return new BunSQLiteWrapper(new Database(path, { strict: true }));
    }

    if (capabilities.recommended === "node") {
        // Use Node.js built-in SQLite
        const { DatabaseSync } = await import("node:sqlite");
        return new NodeSQLiteWrapper(DatabaseSync, path);
    }

    throw new Error(
        `No SQLite implementation available. ` +
            `Runtime: ${capabilities.runtime}. ` +
            `Please use Bun (>=1.3.2) or Node.js (>=22.12.0).`,
    );
}

/**
 * Wrapper class to normalize Bun's SQLite API to add convenience methods
 */
class BunSQLiteWrapper implements SQLiteDatabase {
    private db: any;

    constructor(db: any) {
        this.db = db;
    }

    run(sql: string, params?: any[]): void {
        this.db.prepare(sql).run(...(params || []));
    }

    get<T = any>(sql: string, params?: any[]): T | undefined {
        return this.db.prepare(sql).get(...(params || [])) as T;
    }

    all<T = any>(sql: string, params?: any[]): T[] {
        return this.db.prepare(sql).all(...(params || [])) as T[];
    }

    prepare(sql: string): SQLiteStatement {
        const stmt = this.db.prepare(sql);
        return new BunSQLiteStatementWrapper(stmt);
    }

    close(): void {
        this.db.close();
    }

    exec(sql: string): void {
        this.db.exec(sql);
    }
}

/**
 * Wrapper for Bun SQLite statements
 */
class BunSQLiteStatementWrapper implements SQLiteStatement {
    private stmt: any;

    constructor(stmt: any) {
        this.stmt = stmt;
    }

    run(params?: any[]): void {
        this.stmt.run(...(params || []));
    }

    get<T = any>(params?: any[]): T | undefined {
        return this.stmt.get(...(params || [])) as T;
    }

    all<T = any>(params?: any[]): T[] {
        return this.stmt.all(...(params || [])) as T[];
    }

    finalize(): void {
        this.stmt.finalize();
    }
}

/**
 * Wrapper class to normalize Node.js SQLite API to match Bun's interface
 */
class NodeSQLiteWrapper implements SQLiteDatabase {
    private db: any;

    constructor(DatabaseSyncClass: any, path: string) {
        this.db = new DatabaseSyncClass(path);
    }

    run(sql: string, params?: any[]): void {
        const stmt = this.db.prepare(sql);
        try {
            stmt.run(...(params || []));
        } finally {
            stmt.finalize();
        }
    }

    get<T = any>(sql: string, params?: any[]): T | undefined {
        const stmt = this.db.prepare(sql);
        try {
            return stmt.get(...(params || [])) as T;
        } finally {
            stmt.finalize();
        }
    }

    all<T = any>(sql: string, params?: any[]): T[] {
        const stmt = this.db.prepare(sql);
        try {
            return stmt.all(...(params || [])) as T[];
        } finally {
            stmt.finalize();
        }
    }

    prepare(sql: string): SQLiteStatement {
        const stmt = this.db.prepare(sql);
        return new NodeSQLiteStatementWrapper(stmt);
    }

    close(): void {
        this.db.close();
    }

    backup(destPath: string): SQLiteBackup {
        return this.db.backup(destPath);
    }
}

/**
 * Wrapper for Node.js SQLite statements to match Bun's API
 */
class NodeSQLiteStatementWrapper implements SQLiteStatement {
    private stmt: any;

    constructor(stmt: any) {
        this.stmt = stmt;
    }

    run(params?: any[]): void {
        this.stmt.run(...(params || []));
    }

    get<T = any>(params?: any[]): T | undefined {
        return this.stmt.get(...(params || [])) as T;
    }

    all<T = any>(params?: any[]): T[] {
        return this.stmt.all(...(params || [])) as T[];
    }

    finalize(): void {
        this.stmt.finalize();
    }
}
