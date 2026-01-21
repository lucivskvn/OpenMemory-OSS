import { runAsync, getAsync, allAsync, runUser, getUser, allUser, transaction } from "../db_access";
import { TABLES } from "../db_access";
import { normalizeUserId } from "../../utils";
import { env } from "../cfg";

export abstract class BaseRepository {
    protected tables = TABLES;
    protected runAsync = runAsync;
    protected getAsync = getAsync;
    protected allAsync = allAsync;
    protected runUser = runUser;
    protected getUser = getUser;
    protected allUser = allUser;
    protected transaction = transaction;

    constructor(deps?: {
        runAsync?: typeof runAsync;
        getAsync?: typeof getAsync;
        allAsync?: typeof allAsync;
        runUser?: typeof runUser;
        getUser?: typeof getUser;
        allUser?: typeof allUser;
        transaction?: typeof transaction;
    }) {
        if (deps) {
            if (deps.runAsync) this.runAsync = deps.runAsync;
            if (deps.getAsync) this.getAsync = deps.getAsync;
            if (deps.allAsync) this.allAsync = deps.allAsync;
            if (deps.runUser) this.runUser = deps.runUser;
            if (deps.getUser) this.getUser = deps.getUser;
            if (deps.allUser) this.allUser = deps.allUser;
            if (deps.transaction) this.transaction = deps.transaction;
        }
    }

    protected normalizeUid(uid?: string | null): string | null | undefined {
        return uid === undefined ? undefined : normalizeUserId(uid);
    }

    protected get isPg(): boolean {
        return env.metadataBackend === "postgres";
    }
}
