/**
 * The one-time rewrite of history copies (docs/design/history-rewrite.md).
 *
 *   node dist/history-rewrite/cli.js            # dry run: plans, writes nothing
 *   node dist/history-rewrite/cli.js --apply    # writes; bifrost and Fluxer must be stopped
 *
 * Bifrost's database: BF_DB_HOST, BF_DB_PORT, BF_DB_NAME, BF_DB_USER and
 * BF_DB_PASS (or BF_DB_PASS_FILE). Fluxer's database: BF_FLUXER_DB_HOST,
 * _PORT, _NAME, _USER and _PASS (or _PASS_FILE), as the owner of fluxer_kv.
 * BF_FLUXER_APP_ID is the Fluxer bot's user ID, for its reactions.
 * The report holds counts only: no message text.
 */
import { readFileSync } from 'node:fs';
import { QueryTypes, Sequelize, type Transaction } from 'sequelize';
import { snowflake } from '../fluxer-db/keys';
import { RewriteJob, type FluxerSide } from './job';
import { BifrostSource, otherSessions } from './sources';

const STATEMENT_TIMEOUT_MS = 300_000;
const KEYS_PER_READ = 5_000;

function env(name: string, fallback?: string): string {
    const file = process.env[`${name}_FILE`];
    const value = file ? readFileSync(file, 'utf8').trim() : process.env[name];
    const out = value ?? fallback;
    if (out === undefined || out === '') throw new Error(`${name} is not set`);
    return out;
}

function connect(prefix: string, name: string): Sequelize {
    return new Sequelize(
        env(`${prefix}_NAME`),
        env(`${prefix}_USER`),
        env(`${prefix}_PASS`),
        {
            host: env(`${prefix}_HOST`),
            port: Number(env(`${prefix}_PORT`, '5432')),
            dialect: 'postgres',
            logging: false,
            pool: { max: 2, min: 0, acquire: 30_000, idle: 10_000 },
            dialectOptions: {
                statement_timeout: STATEMENT_TIMEOUT_MS,
                application_name: name,
            },
        }
    );
}

function fluxerSide(db: Sequelize): FluxerSide {
    const tx = (t: Transaction) => ({
        rows: <T extends object>(sql: string, bind: readonly unknown[]) =>
            db.query<T>(sql, {
                bind: [...bind],
                type: QueryTypes.SELECT,
                transaction: t,
            }),
        run: async (sql: string, bind: readonly unknown[]) => {
            await db.query(sql, { bind: [...bind], transaction: t });
        },
    });
    return {
        threadIds: async () => {
            const rows = await db.query<{ id: string }>(
                `SELECT row_data->'thread_id'->>'value' AS id FROM fluxer_kv
                 WHERE table_name = 'thread_state'`,
                { type: QueryTypes.SELECT }
            );
            return new Set(rows.map((r) => r.id));
        },
        messageRows: async (keys) => {
            const out = new Map<string, Record<string, unknown>>();
            for (let i = 0; i < keys.length; i += KEYS_PER_READ) {
                const rows = await db.query<{
                    row_key: string;
                    row_data: Record<string, unknown>;
                }>(
                    `SELECT row_key, row_data FROM fluxer_kv
                     WHERE table_name = 'messages' AND row_key = ANY($1::text[])`,
                    {
                        bind: [keys.slice(i, i + KEYS_PER_READ)],
                        type: QueryTypes.SELECT,
                    }
                );
                for (const row of rows) out.set(row.row_key, row.row_data);
            }
            return out;
        },
        transaction: (work) => db.transaction((t) => work(tx(t))),
    };
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const botUserId = env('BF_FLUXER_APP_ID');
    snowflake(botUserId);
    const bifrostDb = connect('BF_DB', 'bifrost-history-rewrite');
    const fluxerDb = connect('BF_FLUXER_DB', 'bifrost-history-rewrite');
    try {
        if (apply) {
            const busy = [
                ...(await otherSessions(bifrostDb)).map((a) => `bifrost:${a}`),
                ...(await otherSessions(fluxerDb)).map((a) => `fluxer:${a}`),
            ];
            if (busy.length > 0) {
                throw new Error(
                    `Stop bifrost and Fluxer first. Open sessions: ${busy.join(', ')}`
                );
            }
        }
        const job = new RewriteJob({
            bifrost: new BifrostSource(bifrostDb),
            fluxer: fluxerSide(fluxerDb),
            botUserId,
            apply,
            log: (line) => console.log(line),
            now: () => new Date(),
        });
        const report = await job.run();
        console.log(
            JSON.stringify(
                { mode: apply ? 'apply' : 'dry-run', ...report },
                null,
                2
            )
        );
    } finally {
        await bifrostDb.close();
        await fluxerDb.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
