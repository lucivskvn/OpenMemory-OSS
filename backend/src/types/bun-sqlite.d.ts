declare module "bun:sqlite" {
    // Minimal but more complete typings for Bun's sqlite Database surface used in this repo.

    export interface Statement {
        run(...args: any[]): any;
        get<T = any>(...args: any[]): T | undefined;
        all<T = any>(...args: any[]): T[];
        finalize?(): void;
    }

    export class Database {
        constructor(path?: string);

        // Execute a non-select SQL statement. Returns driver-specific result.
        run(sql: string, ...args: any[]): any;

        // Execute a query and return the first row (or undefined).
        get<T = any>(sql: string, ...args: any[]): T | undefined;

        // Execute a query and return all rows.
        all<T = any>(sql: string, ...args: any[]): T[];

        // Prepare a statement for repeated execution.
        prepare(sql: string): Statement;

        // Execute a batch of SQL; left here for compatibility though prefer run/prepare.
        exec?(sql: string): void;

        // Close the database connection.
        close(): void;

        // Optional convenience helpers that some bun builds provide.
        transaction?<T = any>(fn: (db: Database) => T): T;
    }

    export { Database, Statement };
}
