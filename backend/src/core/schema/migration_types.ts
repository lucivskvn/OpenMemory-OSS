export interface Migration {
    version: string;
    desc: string;
    sqlite: string[];
    postgres: string[];
}
