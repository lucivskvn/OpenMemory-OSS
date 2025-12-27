/**
 * Backfill script to migrate bytea vector 'v' to 'v_vector' (pgvector)
 * Usage: bun run tools/backfill_pgvector.ts
 * WARNING: Run with an admin DB backup and ensure 'v_vector' column is created with proper dimension
 */
import { Client } from "pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
    const client = new Client({
        host: process.env.OM_PG_HOST || '127.0.0.1',
        port: +process.env.OM_PG_PORT || 5432,
        user: process.env.OM_PG_USER || 'postgres',
        password: process.env.OM_PG_PASSWORD || 'postgres',
        database: process.env.OM_PG_DB || 'postgres',
    });
    await client.connect();

    const batch = process.env.BACKFILL_BATCH ? parseInt(process.env.BACKFILL_BATCH, 10) : 1000;
    let offset = 0;
    let total = 0;
    const expectedDim = process.env.OM_VEC_DIM ? parseInt(process.env.OM_VEC_DIM, 10) : undefined;

    while (true) {
        const res = await client.query("SELECT id, sector, v FROM openmemory_vectors WHERE v_vector IS NULL LIMIT $1 OFFSET $2", [batch, offset]);
        if (!res.rows || res.rows.length === 0) break;
        console.log(`Processing batch: offset=${offset}, size=${res.rows.length}`);

        for (const row of res.rows) {
            const buf: Buffer = row.v;
            if (!buf) continue;

            if (buf.length % 4 !== 0) {
                console.warn(`Skipping id ${row.id}: vector byte length ${buf.length} is not divisible by 4`);
                continue;
            }

            // convert buffer to Float32 array
            const arrLen = buf.length / 4;
            if (expectedDim && arrLen !== expectedDim) {
                console.warn(`Skipping id ${row.id}: vector length ${arrLen} != expected ${expectedDim}`);
                continue;
            }

            const f32 = new Float32Array(buf.buffer, buf.byteOffset, arrLen);
            const arrStr = '[' + Array.from(f32).map(x => x.toString()).join(',') + ']';
            try {
                await client.query("UPDATE openmemory_vectors SET v_vector = $1::vector WHERE id = $2 AND sector = $3", [arrStr, row.id, row.sector]);
                total++;
            } catch (e) {
                console.warn('Failed update for id', row.id, e.message);
            }
        }

        offset += res.rows.length;
    }

    console.log(`Backfill complete. Updated ${total} rows.`);

    await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
