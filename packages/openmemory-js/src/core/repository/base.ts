import { runAsync, getAsync, allAsync, runUser, getUser, allUser, transaction } from "../db";
import { TABLES } from "../db";
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

    protected normalizeUid(uid?: string | null): string | null | undefined {
        return uid === undefined ? undefined : normalizeUserId(uid);
    }

    protected get isPg(): boolean {
        return env.metadataBackend === "postgres";
    }
}
