declare module 'connect-session-sequelize' {
    import type { Store } from 'express-session';
    import type { Sequelize } from 'sequelize';

    interface SequelizeStoreOptions {
        db: Sequelize;
        table?: string;
        tableName?: string;
        modelKey?: string;
        checkExpirationInterval?: number;
        expiration?: number;
        disableTouch?: boolean;
    }

    class SequelizeStore extends Store {
        constructor(options: SequelizeStoreOptions);
        sync(): Promise<unknown>;
    }

    export default function SequelizeSessionInit(
        store: typeof Store
    ): typeof SequelizeStore;
}
