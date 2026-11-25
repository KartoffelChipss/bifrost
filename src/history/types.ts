import type { RelayPayload, WebhookRef } from '../guild-sync/links';

/**
 * Shapes shared by the history importer, its store and the platform ports.
 * IDs are platform snowflakes as strings.
 */

export type JobKind = 'channel' | 'thread';

/**
 * - pending: known, nothing copied yet
 * - importing: copying past messages up to the cutoff
 * - ready: a channel copied up to now and waiting to be bridged
 * - done: finished; new messages come through the relay
 * - failed: stopped after repeated errors outside any one message, see
 *   lastError. An admin can retry it (HistoryStore.retryFailed).
 */
export type JobStatus = 'pending' | 'importing' | 'ready' | 'done' | 'failed';

export interface HistoryJob {
    readonly id: string;
    readonly guildLinkId: string;
    readonly kind: JobKind;
    /** The Discord channel or thread whose messages are copied. */
    readonly discordId: string;
    /** For a thread: its Discord parent channel. */
    readonly parentDiscordId: string | null;
    /** The Fluxer channel or thread the copies go to, once it exists. */
    readonly fluxerId: string | null;
    readonly status: JobStatus;
    /** The newest Discord message the import copies up to. */
    readonly cutoffId: string | null;
    /** The last Discord message handled. Starts at '0'. */
    readonly checkpointId: string;
    readonly catchUps: number;
    readonly imported: number;
    /** Failed runs in a row with a lasting error, such as a 4xx. */
    readonly failures: number;
    /** Temporary errors in a row (5xx, 429, timeouts); never fail a job. */
    readonly retries: number;
    /** No run starts before this time, after an error. */
    readonly retryAt: Date | null;
    /** Messages given up on after repeated lasting errors. */
    readonly skipped: number;
    readonly messageCount: number | null;
    readonly attachmentCount: number | null;
    readonly surveyedAt: Date | null;
    /** A channel's own import webhook, used before the channel is bridged. */
    readonly importWebhook: WebhookRef | null;
    readonly lastError: string | null;
}

export type JobPatch = Partial<
    Pick<
        HistoryJob,
        | 'fluxerId'
        | 'status'
        | 'cutoffId'
        | 'checkpointId'
        | 'catchUps'
        | 'imported'
        | 'failures'
        | 'retries'
        | 'retryAt'
        | 'skipped'
        | 'messageCount'
        | 'attachmentCount'
        | 'surveyedAt'
        | 'importWebhook'
        | 'lastError'
    >
>;

/** One reaction on a Discord message: the emoji as text, and its count. */
export interface Reaction {
    readonly name: string;
    readonly count: number;
}

/** One Discord message, as the importer reads it. */
export interface SourceMessage {
    readonly id: string;
    readonly authorId: string;
    readonly createdAt: Date;
    /** Written by a person or an app command. System messages are never copied. */
    readonly copyable: boolean;
    readonly attachments: number;
    /** Set when a webhook posted the message. */
    readonly webhookId: string | null;
    /**
     * For a reply: the author of the message it quotes, or null when that
     * message is gone or its author is unknown.
     */
    readonly reply: { readonly authorId: string | null } | null;
    readonly reactions: readonly Reaction[];
    /** The platform message, for the payload builder. */
    readonly raw: unknown;
}

export interface PayloadOptions {
    /** Leaves out the quote of the message replied to. */
    readonly withoutReply?: boolean;
}

/** Where a copy is sent: a channel, or a thread inside the webhook's channel. */
export interface SendTarget {
    readonly webhook: WebhookRef;
    readonly threadId: string | null;
}

/** One imported message, as stored. */
export interface ImportedMessage {
    readonly discordMessageId: string;
    readonly jobId: string;
    readonly discordAuthorId: string;
    readonly fluxerMessageId: string | null;
    readonly fluxerTargetId: string;
    readonly inThread: boolean;
    readonly webhookId: string;
    /**
     * A hash of the content sent (see contentHash), so crash recovery can
     * tell this copy from other posts by the same webhook. Null for rows
     * written before it was recorded.
     */
    readonly contentHash?: string | null;
}

/** A recent Fluxer message, for crash recovery. */
export interface FluxerCopy {
    readonly id: string;
    readonly webhookId: string | null;
    readonly content: string;
}

/** Reads Discord history and writes copies to Fluxer. */
export interface HistoryPorts {
    /** Up to `limit` messages after `afterId`, oldest first. */
    listMessages(
        discordId: string,
        afterId: string,
        limit: number
    ): Promise<SourceMessage[]>;
    /** The newest message in a channel or thread, or null when empty. */
    newestMessageId(discordId: string): Promise<string | null>;
    /** The relay's payload for a message: text, author name and avatar. */
    payload(
        raw: unknown,
        guildLinkId: string,
        options?: PayloadOptions
    ): Promise<RelayPayload>;
    /** Reads a platform message from a gateway event, as listMessages does. */
    describe(raw: unknown): SourceMessage;
    /** Sends a copy. Returns the new Fluxer message ID. */
    sendCopy(target: SendTarget, payload: RelayPayload): Promise<string>;
    /** Edits or deletes a copy through the webhook that sent it. */
    editCopy(
        target: SendTarget,
        messageId: string,
        content: string
    ): Promise<void>;
    deleteCopy(target: SendTarget, messageId: string): Promise<void>;
    /** Up to `limit` newest messages in a Fluxer channel or thread. */
    recentFluxerMessages(
        fluxerId: string,
        limit: number
    ): Promise<FluxerCopy[]>;
    /** True when the live relay sent this Fluxer message (message_links). */
    relayedLiveFluxer(fluxerMessageId: string): Promise<boolean>;
    createImportWebhook(fluxerChannelId: string): Promise<WebhookRef>;
    /** Whether a Discord thread is archived and locked right now. */
    threadState(
        discordThreadId: string
    ): Promise<{ archived: boolean; locked: boolean }>;
    /** True when the relay already copied this message after the link. */
    relayedLive(discordMessageId: string): Promise<boolean>;
    /** The pinned messages of a Discord channel or thread, oldest pin first. */
    pinnedMessageIds(discordId: string): Promise<string[]>;
    /** Pins a message in a Fluxer channel or thread. */
    pinCopy(fluxerChannelId: string, fluxerMessageId: string): Promise<void>;
}
