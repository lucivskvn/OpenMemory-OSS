declare module 'bun:sqlite' {
    export class Database {
        constructor(path?: string)
        exec(sql: string): void
        run(sql: string, ...args: any[]): void
        prepare(sql: string): {
            run: (...args: any[]) => void
            get: (...args: any[]) => any
            all: (...args: any[]) => any[]
        }
        query(sql: string): { get: (...args: any[]) => any; all: (...args: any[]) => any[] }
        transaction(fn: () => void): void
        close(): void
    }
    export default Database
}

declare namespace sqlite3 {
    class Database {
        constructor(path?: string)
        get(sql: string, ...args: any[]): any
        run(sql: string, ...args: any[]): any
        all(sql: string, ...args: any[]): any[]
        close(cb?: () => void): void
    }
}

declare module 'sqlite3' {
    export = sqlite3
}

declare module 'node:fs' {
    import fs from 'fs'
    export * from 'fs'
}

declare module 'node:path' {
    import path from 'path'
    export * from 'path'
}
