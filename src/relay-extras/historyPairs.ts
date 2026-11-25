import { QueryTypes, type Sequelize } from 'sequelize';
import { TABLES } from '../addons/db/schema';
import type { MessagePair, Side } from './types';

/**
 * Pairs of imported history messages. The history add-on records each
 * copy in addon_history_messages: the Discord original (in its job's
 * Discord channel or thread) and the Fluxer copy (in `fluxerTargetId`).
 * Reactions and pins on these pairs are mirrored like live ones.
 *
 * Read-only, and kept here rather than in src/history so the history
 * add-on's store stays its own.
 */

type Row = Record<string, unknown>;

function text(row: Row, field: string): string | null {
    const value = row[field];
    return typeof value === 'string' && value !== '' ? value : null;
}

/** A pair from one joined row, or null when the copy is unfinished. */
export function historyPair(row: Row): MessagePair | null {
    const guildLinkId = text(row, 'guildLinkId');
    const discordChannelId = text(row, 'discordId');
    const discordMessageId = text(row, 'discordMessageId');
    const fluxerChannelId = text(row, 'fluxerTargetId');
    const fluxerMessageId = text(row, 'fluxerMessageId');
    if (
        !guildLinkId ||
        !discordChannelId ||
        !discordMessageId ||
        !fluxerChannelId ||
        !fluxerMessageId
    ) {
        return null;
    }
    return {
        guildLinkId,
        discord: { channelId: discordChannelId, messageId: discordMessageId },
        fluxer: { channelId: fluxerChannelId, messageId: fluxerMessageId },
    };
}

export class PostgresHistoryPairs {
    constructor(private readonly db: Sequelize) {}

    async historyMessage(
        side: Side,
        messageId: string
    ): Promise<MessagePair | null> {
        const column =
            side === 'discord' ? 'discordMessageId' : 'fluxerMessageId';
        const rows = await this.db.query<Row>(
            `SELECT j."guildLinkId", j."discordId", m."discordMessageId",
                    m."fluxerTargetId", m."fluxerMessageId"
             FROM ${TABLES.historyMessages} m
             JOIN ${TABLES.historyJobs} j ON j.id = m."jobId"
             WHERE m."${column}" = $1
             LIMIT 1`,
            { bind: [messageId], type: QueryTypes.SELECT }
        );
        const row = rows[0];
        return row ? historyPair(row) : null;
    }
}
