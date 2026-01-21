import { BaseRepository } from "./base";
import type { EncryptionLogRotationParams, EncryptionUpdateStatusParams } from "../types/admin";

export class EncryptionRepository extends BaseRepository {
    async logRotation(params: import("../types").EncryptionLogRotationParams) {
        return await this.runAsync(
            `insert into ${this.tables.encryption_keys}(id, old_version, new_version, status, started_at) values(?,?,?,?,?)`,
            [params.id, params.oldVer, params.newVer, params.status, params.startedAt]
        );
    }

    async updateStatus(params: import("../types").EncryptionUpdateStatusParams) {
        return await this.runAsync(
            `update ${this.tables.encryption_keys} set status=?, completed_at=?, error=? where id=?`,
            [params.status, params.completedAt, params.error, params.id]
        );
    }

    async getLatestRotation() {
        return await this.getAsync(
            `select * from ${this.tables.encryption_keys} order by started_at desc limit 1`
        );
    }
}
