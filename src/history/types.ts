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
    /**
     * Temporary errors in a row (5xx, 429, timeouts). Past MAX_RETRIES on
     * one message they count as lasting errors.
     */
    readonly retries: number;
    /**
     * What `failures` and `retries` count against: a Discord message ID,
     * or 'target' for errors outside any one message. Null when unknown.
     */
    readonly failingId: string | null;
    /** No run starts before this time, after an error. */
    readonly retryAt: Date | null;
    /** Messages given up on after repeated lasting errors. */
    readonly skipped: number;
    /** Messages skipped in a row; a copied message resets it. */
    readonly skipStreak: number;
    /**
     * The checkpoint from before the first skip of the current streak. A
     * job that fails mid-streak goes back there, so a retry tries the
     * skipped messages again.
     */
    readonly streakFromId: string | null;
    readonly messageCount: number | null;
    readonly attachmentCount: number | null;
    readonly surveyedAt: Date | null;
    /** A channel's own import webhook, used before the channel is bridged. */
    readonly importWebhook: WebhookRef | null;
    /**
     * Archive-thread mode: the Fluxer thread a big channel's history goes
     * to, through the import webhook. Such a channel is bridged at once.
     */
    readonly archiveThreadId: string | null;
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
        | 'failingId'
        | 'retryAt'
        | 'skipped'
        | 'skipStreak'
        | 'streakFromId'
        | 'messageCount'
        | 'attachmentCount'
        | 'surveyedAt'
        | 'importWebhook'
        | 'archiveThreadId'
        | 'lastError'
    >
>;

/** The columns of a job that planning and target mapping need. */
export type JobKey = Pick<HistoryJob, 'id' | 'kind' | 'discordId' | 'fluxerId'>;

/** A link's jobs in sum, for the end-of-import report. */
export interface JobTotals {
    readonly jobs: number;
    /** Jobs neither done nor failed. */
    readonly open: number;
    readonly imported: number;
    readonly skipped: number;
    readonly failed: number;
}

/** A thread's state on either platform. */
export interface ThreadFlags {
    readonly archived: boolean;
    readonly locked: boolean;
}

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
     * True when a webhook owned by this bot's application posted it, such
     * as an earlier Bifröst link's copy of a Fluxer message.
     */
    readonly ownWebhook: boolean;
    /**
     * For a reply: the author of the message it quotes, or null when that
     * message is gone or its author is unknown.
     */
    readonly reply: { readonly authorId: string | null } | null;
    readonly reactions: readonly Reaction[];
    /**
     * Discord users the copy renders as mentions (mentions.ts
     * renderedMentions), at most MAX_MENTIONS_PER_MESSAGE. Absent: none.
     */
    readonly mentionIds?: readonly string[];
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
    /** Set by the rewrite job: no date or reactions line (CopyStyle). */
    readonly native?: boolean;
    /** Set by the rewrite job: the copy is a Fluxer reply. */
    readonly nativeReply?: boolean;
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
    /**
     * One message of a channel or thread, or null when Discord no longer
     * has it. Other errors are thrown.
     */
    fetchMessage(
        discordId: string,
        messageId: string
    ): Promise<SourceMessage | null>;
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
    /** When the channel's bridge was made, or null when it has none. */
    linkCreatedAt(discordChannelId: string): Promise<Date | null>;
    /**
     * IDs of the channel's Discord webhooks that upstream's bridge made,
     * by name or by owner. Empty when the bot cannot list webhooks there.
     */
    bridgeWebhookIds(discordChannelId: string): Promise<Set<string>>;
    /** True when the relay already copied this message after the link. */
    relayedLive(discordMessageId: string): Promise<boolean>;
    /** The pinned messages of a Discord channel or thread, oldest pin first. */
    pinnedMessageIds(discordId: string): Promise<string[]>;
    /** Pins a message in a Fluxer channel or thread. */
    pinCopy(fluxerChannelId: string, fluxerMessageId: string): Promise<void>;
    /**
     * Gives the platform side history's opt-out check, for copies made
     * outside the importer (forum post starters). Null removes it.
     */
    useOptOuts?(
        check: ((discordUserId: string) => Promise<boolean>) | null
    ): void;
}
