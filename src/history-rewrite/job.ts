import { contentHash } from '../history/format';
import { messageRowKey } from '../fluxer-db/keys';
import {
    fixLastMessage,
    lowerCreatedBucket,
    moveReplyReferences,
} from './channelState';
import {
    guardBatch,
    indexBuckets,
    moveAttachmentLookups,
    movePins,
    moveReactions,
    writeCopies,
    type Tx,
} from './fluxerWrites';
import {
    originalFrom,
    planCopy,
    type CopyPlan,
    type PlanContext,
} from './plan';
import type { BifrostSource, DoneCopy, PendingCopy } from './sources';

/** Copies planned and written together, in one Fluxer transaction. */
export const BATCH_SIZE = 1_000;
/** Channels handled per run at most. */
export const MAX_CHANNELS = 5_000;
/** Batches per channel at most: well above the largest channel's 56,000 copies. */
const MAX_BATCHES = 1_000;

export interface FluxerSide {
    /** Thread channel IDs: their copies cannot take older IDs. */
    threadIds(): Promise<Set<string>>;
    /** row_data of the given messages rows, by row key. */
    messageRows(
        keys: readonly string[]
    ): Promise<Map<string, Record<string, unknown>>>;
    transaction(work: (tx: Tx) => Promise<void>): Promise<void>;
}

export interface JobDeps {
    readonly bifrost: Pick<
        BifrostSource,
        'channels' | 'batch' | 'replyTargets' | 'emojis' | 'recordDone'
    >;
    readonly fluxer: FluxerSide;
    readonly botUserId: string;
    readonly apply: boolean;
    readonly log: (line: string) => void;
    readonly now: () => Date;
}

export interface JobReport {
    channels: number;
    threadChannelsSkipped: number;
    copiesInThreadsSkipped: number;
    planned: number;
    written: number;
    recovered: number;
    nativeReplies: number;
    reactions: number;
    edited: number;
    skipped: Record<string, number>;
}

function emptyReport(): JobReport {
    return {
        channels: 0,
        threadChannelsSkipped: 0,
        copiesInThreadsSkipped: 0,
        planned: 0,
        written: 0,
        recovered: 0,
        nativeReplies: 0,
        reactions: 0,
        edited: 0,
        skipped: {},
    };
}

function skip(report: JobReport, reason: string): void {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
}

/** A copy whose new row exists and old row is gone: written by a run that stopped. */
function recoveredCopy(
    copy: PendingCopy,
    row: Record<string, unknown>
): DoneCopy {
    const content = typeof row.content === 'string' ? row.content : '';
    return {
        discordMessageId: copy.discordMessageId,
        oldFluxerMessageId: copy.fluxerMessageId,
        nativeReply:
            typeof row.message_reference === 'object' &&
            row.message_reference !== null,
        contentHash: contentHash(content),
    };
}

/** Rewrites the history copies of every non-thread channel. */
export class RewriteJob {
    private readonly report = emptyReport();

    constructor(private readonly deps: JobDeps) {}

    async run(): Promise<JobReport> {
        const { bifrost, fluxer } = this.deps;
        const threads = await fluxer.threadIds();
        const targets = await bifrost.replyTargets(threads);
        const context: PlanContext = {
            botUserId: this.deps.botUserId,
            emojis: await bifrost.emojis(),
            replyTarget: (id) => targets.get(id) ?? null,
        };
        const channels = await bifrost.channels(MAX_CHANNELS);
        for (const channelId of channels) {
            await this.channel(channelId, threads, context);
        }
        return this.report;
    }

    private async channel(
        channelId: string,
        threads: ReadonlySet<string>,
        context: PlanContext
    ): Promise<void> {
        const thread = threads.has(channelId);
        if (thread) this.report.threadChannelsSkipped++;
        else this.report.channels++;
        let after = '0';
        for (let i = 0; i < MAX_BATCHES; i++) {
            const batch = await this.deps.bifrost.batch(
                channelId,
                after,
                BATCH_SIZE
            );
            const last = batch[batch.length - 1];
            if (!last) return;
            after = last.discordMessageId;
            if (thread) this.report.copiesInThreadsSkipped += batch.length;
            else await this.batch(channelId, batch, context);
        }
        throw new Error(
            `Channel ${channelId} has more than ${MAX_BATCHES} batches`
        );
    }

    private async batch(
        channelId: string,
        batch: readonly PendingCopy[],
        context: PlanContext
    ): Promise<void> {
        const keys = batch.flatMap((c) => [
            messageRowKey(c.fluxerTargetId, c.fluxerMessageId),
            messageRowKey(c.fluxerTargetId, c.discordMessageId),
        ]);
        const rows = await this.deps.fluxer.messageRows(keys);
        const plans: CopyPlan[] = [];
        const recovered: DoneCopy[] = [];
        for (const copy of batch) {
            const oldRow = rows.get(
                messageRowKey(copy.fluxerTargetId, copy.fluxerMessageId)
            );
            const newRow = rows.get(
                messageRowKey(copy.fluxerTargetId, copy.discordMessageId)
            );
            if (!oldRow && newRow) recovered.push(recoveredCopy(copy, newRow));
            else if (!oldRow) skip(this.report, 'copy not on Fluxer');
            else this.planOne(copy, oldRow, context, plans);
        }
        this.report.recovered += recovered.length;
        if (!this.deps.apply) return;
        if (plans.length > 0) await this.write(channelId, plans);
        await this.deps.bifrost.recordDone([
            ...recovered,
            ...plans.map(doneOf),
        ]);
        this.report.written += plans.length;
        this.deps.log(`channel ${channelId}: ${plans.length} written`);
    }

    private planOne(
        copy: PendingCopy,
        oldRow: Record<string, unknown>,
        context: PlanContext,
        plans: CopyPlan[]
    ): void {
        const original = originalFrom(copy.raw);
        const result = planCopy(copy, oldRow, original, context);
        if (!result.ok) {
            skip(this.report, result.reason);
            return;
        }
        plans.push(result.plan);
        this.report.planned++;
        if (result.plan.nativeReply) this.report.nativeReplies++;
        if (original.editedAt) this.report.edited++;
        this.report.reactions += result.plan.reactions.length;
    }

    private async write(
        channelId: string,
        plans: readonly CopyPlan[]
    ): Promise<void> {
        const idMap = new Map(
            plans.map((p) => [p.copy.fluxerMessageId, p.copy.discordMessageId])
        );
        const minBucket = Math.min(...plans.map((p) => p.bucket));
        await this.deps.fluxer.transaction(async (tx) => {
            await guardBatch(tx, plans);
            await writeCopies(tx, plans);
            await moveReactions(tx, channelId, idMap);
            await movePins(tx, channelId, idMap);
            await moveAttachmentLookups(tx, channelId, idMap);
            await moveReplyReferences(tx, channelId, idMap);
            await indexBuckets(
                tx,
                channelId,
                plans.map((p) => p.bucket),
                this.deps.now()
            );
            await lowerCreatedBucket(tx, channelId, minBucket);
            await fixLastMessage(tx, channelId, [...idMap.keys()]);
        });
    }
}

function doneOf(plan: CopyPlan): DoneCopy {
    return {
        discordMessageId: plan.copy.discordMessageId,
        oldFluxerMessageId: plan.copy.fluxerMessageId,
        nativeReply: plan.nativeReply,
        contentHash: plan.contentHash,
    };
}
