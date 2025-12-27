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

    const res = await client.query("SELECT id, sector, v FROM openmemory_vectors WHERE v_vector IS NULL OR v_vector = ''");
    console.log(`Found ${res.rows.length} rows to backfill`);
    for (const row of res.rows) {
        const buf: Buffer = row.v;
        if (!buf) continue;
        // convert buffer to Float32 array
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const arrStr = '[' + Array.from(f32).map(x => x.toString()).join(',') + ']';
        try {
            await client.query("UPDATE openmemory_vectors SET v_vector = $1::vector WHERE id = $2 AND sector = $3", [arrStr, row.id, row.sector]);
        } catch (e) {
            console.warn('Failed update for id', row.id, e.message);
        }
    }

    await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
