
export interface CliFlags {
    userId?: string;
    type?: string;
    limit?: string;
    host?: string;
    tags?: string;
    sector?: string;
    minSalience?: string;
    force?: string;
    namespace?: string;
    rate?: string;
    // Common
    help?: string;
    [key: string]: string | undefined;
}

export interface CommandHandler {
    (args: string[], flags: CliFlags): Promise<void>;
}
