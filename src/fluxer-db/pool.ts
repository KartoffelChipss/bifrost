import { QueryTypes, Sequelize } from 'sequelize';

/** BF_FLUXER_DB_*: the connection to Fluxer's Postgres. */
export interface FluxerDbSettings {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
}

/** Every query stops after this long. */
export const FLUXER_DB_STATEMENT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
/** Name sync works one author at a time; two connections are plenty. */
const MAX_CONNECTIONS = 2;

/** Runs one parameterised query and returns its rows. */
export interface FluxerDb {
    rows<T extends object>(sql: string, bind: readonly unknown[]): Promise<T[]>;
    close(): Promise<void>;
}

/**
 * A small, bounded connection to Fluxer's database, for bifrost's few
 * writes there. It uses Sequelize, which bifrost already depends on.
 */
export function openFluxerDb(
    settings: FluxerDbSettings,
    applicationName: string
): FluxerDb {
    if (settings.password === '') {
        throw new Error('Fluxer database password is empty');
    }
    const db = new Sequelize(
        settings.database,
        settings.user,
        settings.password,
        {
            host: settings.host,
            port: settings.port,
            dialect: 'postgres',
            logging: false,
            pool: {
                max: MAX_CONNECTIONS,
                min: 0,
                acquire: CONNECT_TIMEOUT_MS,
                idle: IDLE_TIMEOUT_MS,
            },
            dialectOptions: {
                statement_timeout: FLUXER_DB_STATEMENT_TIMEOUT_MS,
                connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
                application_name: applicationName,
            },
        }
    );
    return {
        rows: <T extends object>(sql: string, bind: readonly unknown[]) =>
            db.query<T>(sql, { bind: [...bind], type: QueryTypes.SELECT }),
        close: () => db.close(),
    };
}
