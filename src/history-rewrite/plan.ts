import { contentHash } from '../history/format';
import {
    bigintValue,
    bucketOf,
    messagePartitionKey,
    messageRowKey,
    reactionRowKey,
    snowflakeTime,
} from '../fluxer-db/keys';
import { nativeContent, withoutReplyQuote } from './content';

/** One history copy, as bifrost recorded it. */
export interface CopyRow {
    readonly discordMessageId: string;
    readonly fluxerMessageId: string;
    /** The Fluxer channel or thread the copy is in. */
    readonly fluxerTargetId: string;
    readonly webhookId: string;
}

/** What the Discord original says, from the archive's raw JSON. */
export interface Original {
    readonly editedAt: string | null;
    /** The message it replies to, for a reply (type 19). */
    readonly replyTo: string | null;
    readonly reactions: readonly OriginalReaction[];
}

export interface OriginalReaction {
    /** Null for a Unicode emoji. */
    readonly id: string | null;
    readonly name: string;
    readonly animated: boolean;
}

/** Where the copy of a replied-to message is, when it has one. */
export interface ReplyTarget {
    readonly fluxerChannelId: string;
    /** Its Fluxer ID after the rewrite. */
    readonly fluxerMessageId: string;
}

export interface PlanContext {
    readonly botUserId: string;
    /** Discord custom emoji ID → Fluxer emoji ID, for emojis guild-sync copied. */
    readonly emojis: ReadonlyMap<string, string>;
    /** Discord message ID → its copy's place after the rewrite. */
    readonly replyTarget: (discordMessageId: string) => ReplyTarget | null;
}

/** A row to write to fluxer_kv. */
export interface KvRow {
    readonly tableName: string;
    readonly partitionKey: string;
    readonly rowKey: string;
    readonly rowData: Record<string, unknown>;
    readonly sortId: string | null;
}

export interface CopyPlan {
    readonly copy: CopyRow;
    readonly oldRowKey: string;
    readonly message: KvRow;
    readonly reactions: readonly KvRow[];
    readonly nativeReply: boolean;
    readonly contentHash: string;
    /** The new bucket, for the channel's bucket index. */
    readonly bucket: number;
}

export type PlanResult =
    | { readonly ok: true; readonly plan: CopyPlan }
    | { readonly ok: false; readonly reason: string };

type RowData = Record<string, unknown>;

function webhookOf(row: RowData): string | null {
    const value = row.webhook_id as { value?: unknown } | undefined;
    return typeof value?.value === 'string' ? value.value : null;
}

function hasAuthor(row: RowData): boolean {
    return typeof row.author_id === 'object' && row.author_id !== null;
}

function reactionRows(
    copy: CopyRow,
    original: Original,
    context: PlanContext,
    at: string
): KvRow[] {
    const seen = new Set<string>();
    const rows: KvRow[] = [];
    for (const reaction of original.reactions) {
        const emojiId =
            reaction.id === null ? '0' : context.emojis.get(reaction.id);
        if (emojiId === undefined || seen.has(`${emojiId}:${reaction.name}`))
            continue;
        seen.add(`${emojiId}:${reaction.name}`);
        const fields = {
            channelId: copy.fluxerTargetId,
            messageId: copy.discordMessageId,
            emojiId,
            emojiName: reaction.name,
            userId: context.botUserId,
        };
        rows.push({
            tableName: 'message_reactions',
            partitionKey: messagePartitionKey(
                fields.channelId,
                fields.messageId
            ),
            rowKey: reactionRowKey(fields),
            rowData: {
                channel_id: bigintValue(fields.channelId),
                bucket: bucketOf(fields.messageId),
                message_id: bigintValue(fields.messageId),
                user_id: bigintValue(fields.userId),
                emoji_id: bigintValue(emojiId),
                emoji_name: reaction.name,
                emoji_animated: reaction.animated,
                created_at: { __fluxer_type: 'date', value: at },
            },
            sortId: fields.messageId,
        });
    }
    return rows;
}

function replyReference(
    copy: CopyRow,
    original: Original,
    context: PlanContext
): RowData | null {
    if (!original.replyTo) return null;
    const target = context.replyTarget(original.replyTo);
    if (!target || target.fluxerChannelId !== copy.fluxerTargetId) return null;
    return {
        type: 0,
        guild_id: null,
        channel_id: bigintValue(copy.fluxerTargetId),
        message_id: bigintValue(target.fluxerMessageId),
    };
}

/**
 * Plans the native form of one copy: its Discord ID as its Fluxer ID, no
 * date or reactions line, a Fluxer reply where the replied-to copy is in
 * the same channel, the original's edit time, and one bot reaction per
 * emoji. Refuses anything that is not exactly the copy bifrost posted.
 */
export function planCopy(
    copy: CopyRow,
    oldRow: RowData,
    original: Original,
    context: PlanContext
): PlanResult {
    if (webhookOf(oldRow) !== copy.webhookId) {
        return { ok: false, reason: 'webhook does not match' };
    }
    if (hasAuthor(oldRow))
        return { ok: false, reason: 'row has a user author' };
    const newId = copy.discordMessageId;
    if (BigInt(newId) >= BigInt(copy.fluxerMessageId)) {
        return { ok: false, reason: 'Discord ID is not older than the copy' };
    }
    const createdAt = snowflakeTime(newId);
    const oldContent = typeof oldRow.content === 'string' ? oldRow.content : '';
    const content = nativeContent(oldContent, createdAt);
    if (content === null) return { ok: false, reason: 'no date note' };
    const reference = replyReference(copy, original, context);
    const embeds = Array.isArray(oldRow.embeds) ? oldRow.embeds : null;
    const reactions = reactionRows(
        copy,
        original,
        context,
        createdAt.toISOString()
    );
    const bucket = bucketOf(newId);
    const rowData: RowData = {
        ...oldRow,
        message_id: bigintValue(newId),
        bucket,
        content,
        has_reaction: reactions.length > 0 || oldRow.has_reaction === true,
        ...(reference ? { message_reference: reference } : {}),
        ...(reference && embeds ? { embeds: withoutReplyQuote(embeds) } : {}),
        ...(original.editedAt
            ? {
                  edited_timestamp: {
                      __fluxer_type: 'date',
                      value: original.editedAt,
                  },
              }
            : {}),
    };
    return {
        ok: true,
        plan: {
            copy,
            oldRowKey: messageRowKey(copy.fluxerTargetId, copy.fluxerMessageId),
            message: {
                tableName: 'messages',
                partitionKey: messagePartitionKey(copy.fluxerTargetId, newId),
                rowKey: messageRowKey(copy.fluxerTargetId, newId),
                rowData,
                sortId: newId,
            },
            reactions,
            nativeReply: reference !== null,
            contentHash: contentHash(content),
            bucket,
        },
    };
}

/** Reads what the rewrite needs from an archived Discord message. */
export function originalFrom(raw: unknown): Original {
    const message = (raw ?? {}) as {
        type?: unknown;
        edited_timestamp?: unknown;
        message_reference?: { message_id?: unknown } | null;
        reactions?: unknown;
    };
    const replyId = message.message_reference?.message_id;
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    return {
        editedAt:
            typeof message.edited_timestamp === 'string'
                ? new Date(message.edited_timestamp).toISOString()
                : null,
        replyTo:
            message.type === 19 && typeof replyId === 'string' ? replyId : null,
        reactions: reactions.flatMap((r: unknown) => {
            const emoji = (
                r as {
                    emoji?: {
                        id?: unknown;
                        name?: unknown;
                        animated?: unknown;
                    };
                }
            ).emoji;
            if (typeof emoji?.name !== 'string' || emoji.name === '') return [];
            return [
                {
                    id: typeof emoji.id === 'string' ? emoji.id : null,
                    name: emoji.name,
                    animated: emoji.animated === true,
                },
            ];
        }),
    };
}
