import { createHash, randomInt } from 'node:crypto';
import type { HistoryEditor } from '../history/editor';
import type { AccountPair, IdentityStore, Side } from './store';

/**
 * Account linking by DM (design: Linking flow). A member asks for a code on
 * one platform, sends it to the bot on the other, and the code's owner
 * confirms the exact account it links to. Codes and replies travel only in
 * DMs, and only a hash of each code is stored.
 */

export const CODE_LENGTH = 8;
/** No 0/O or 1/I, so a code is easy to type. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_FAILURES_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const MESSAGE_ID = /^\d{5,25}$/;

export interface DmReply {
    readonly side: Side;
    readonly userId: string;
    readonly text: string;
}

export interface DmInput {
    readonly side: Side;
    readonly userId: string;
    readonly text: string;
}

export interface FlowDeps {
    readonly store: IdentityStore;
    /** A display name, for the confirmation question. */
    readonly nameOf: (side: Side, userId: string) => Promise<string>;
    /** Present when history import is on. */
    readonly history: {
        readonly editor: HistoryEditor;
        setOptOut(
            discordUserId: string,
            out: boolean,
            now: Date
        ): Promise<void>;
    } | null;
    /** Called after a pair is saved, so roles can sync at once. */
    readonly onLinked: (pair: AccountPair) => Promise<void>;
    readonly now: () => Date;
    readonly newCode?: () => string;
}

export function generateCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

export function hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
}

const other = (side: Side): Side => (side === 'discord' ? 'fluxer' : 'discord');
const label = (side: Side) => (side === 'discord' ? 'Discord' : 'Fluxer');

export const HELP = [
    'Commands (send them here, in this DM):',
    '`link`: get a code to link this account to your account on the other platform',
    '`link <code>`: use a code from the other platform',
    '`yes` or `no`: answer a link request',
    '`unlink`: remove the link',
    '`history-optout` or `history-optin`: hide or show your name and text in imported history',
    '`edit <message-id> <text>` or `delete <message-id>`: change your imported message on Fluxer',
].join('\n');

const reply = (input: DmInput, text: string): DmReply[] => [
    { side: input.side, userId: input.userId, text },
];

async function locked(input: DmInput, deps: FlowDeps): Promise<boolean> {
    const since = new Date(deps.now().getTime() - HOUR_MS);
    const failures = await deps.store.failuresSince(
        input.side,
        input.userId,
        since
    );
    return failures >= MAX_FAILURES_PER_HOUR;
}

async function startLink(input: DmInput, deps: FlowDeps): Promise<DmReply[]> {
    if (await deps.store.pairFor(input.side, input.userId)) {
        return reply(
            input,
            'This account is already linked. Send `unlink` first to link another one.'
        );
    }
    if (await locked(input, deps)) {
        return reply(input, 'Too many failed attempts. Try again in an hour.');
    }
    const code = (deps.newCode ?? generateCode)();
    const expiresAt = new Date(deps.now().getTime() + CODE_TTL_MS);
    await deps.store.saveCode(
        hashCode(code),
        input.side,
        input.userId,
        expiresAt
    );
    return reply(
        input,
        `Your code is \`${code}\`. Within 10 minutes, DM the bot on ${label(other(input.side))}: \`link ${code}\`. Never post this code in a channel.`
    );
}

async function redeem(
    input: DmInput,
    code: string,
    deps: FlowDeps
): Promise<DmReply[]> {
    const { store, now } = deps;
    if (await locked(input, deps)) {
        return reply(input, 'Too many failed attempts. Try again in an hour.');
    }
    const origin = other(input.side);
    const ownerId = CODE_PATTERN.test(code)
        ? await store.takeCode(hashCode(code), origin, now())
        : null;
    if (!ownerId) {
        await store.recordFailure(input.side, input.userId, now());
        return reply(input, 'That code is unknown, used or expired.');
    }
    if (
        (await store.pairFor(input.side, input.userId)) ||
        (await store.pairFor(origin, ownerId))
    ) {
        return reply(
            input,
            'One of the two accounts is already linked. Send `unlink` first.'
        );
    }
    const pair: AccountPair =
        input.side === 'discord'
            ? { discordUserId: input.userId, fluxerUserId: ownerId }
            : { discordUserId: ownerId, fluxerUserId: input.userId };
    await store.savePending({
        ...pair,
        confirmSide: origin,
        confirmUserId: ownerId,
        expiresAt: new Date(now().getTime() + CODE_TTL_MS),
    });
    const name = await deps.nameOf(input.side, input.userId);
    return [
        ...reply(
            input,
            `Almost done. Confirm in your DM with the bot on ${label(origin)}.`
        ),
        {
            side: origin,
            userId: ownerId,
            text: `Link this account to ${label(input.side)} user **${name}**? Reply \`yes\` or \`no\`.`,
        },
    ];
}

async function confirm(
    input: DmInput,
    yes: boolean,
    deps: FlowDeps
): Promise<DmReply[]> {
    const { store, now } = deps;
    const pending = await store.takePending(input.side, input.userId, now());
    if (!pending) return reply(input, 'There is nothing to confirm.');
    const otherUser =
        input.side === 'discord' ? pending.fluxerUserId : pending.discordUserId;
    const both = (text: string): DmReply[] => [
        ...reply(input, text),
        { side: other(input.side), userId: otherUser, text },
    ];
    if (!yes) return both('The link was cancelled.');
    const pair = {
        discordUserId: pending.discordUserId,
        fluxerUserId: pending.fluxerUserId,
    };
    if (
        (await store.pairFor('discord', pair.discordUserId)) ||
        (await store.pairFor('fluxer', pair.fluxerUserId))
    ) {
        return both(
            'One of the two accounts was linked in the meantime. Nothing changed.'
        );
    }
    await store.savePair(pair, now());
    await deps.onLinked(pair);
    return both('Your accounts are linked. Your synced roles will follow you.');
}

async function unlink(input: DmInput, deps: FlowDeps): Promise<DmReply[]> {
    const pair = await deps.store.deletePair(input.side, input.userId);
    if (!pair) return reply(input, 'This account is not linked.');
    const text =
        'Your accounts are unlinked. Roles already given stay, but stop syncing.';
    return [
        { side: 'discord', userId: pair.discordUserId, text },
        { side: 'fluxer', userId: pair.fluxerUserId, text },
    ];
}

/** The member's Discord ID: their own on Discord, or through their link. */
async function discordIdOf(
    input: DmInput,
    deps: FlowDeps
): Promise<string | null> {
    if (input.side === 'discord') return input.userId;
    return (
        (await deps.store.pairFor('fluxer', input.userId))?.discordUserId ??
        null
    );
}

async function optOut(
    input: DmInput,
    out: boolean,
    deps: FlowDeps
): Promise<DmReply[]> {
    if (!deps.history) return reply(input, 'History import is not running.');
    const discordId = await discordIdOf(input, deps);
    if (!discordId)
        return reply(
            input,
            'Link your accounts first, or send this to the bot on Discord.'
        );
    await deps.history.setOptOut(discordId, out, deps.now());
    return reply(
        input,
        out
            ? 'Done. Messages imported from now on show no name, avatar or text. Copies already made stay; use `delete` to remove one.'
            : 'Done. Your messages are imported with your name again.'
    );
}

async function changeCopy(
    input: DmInput,
    words: string[],
    deps: FlowDeps
): Promise<DmReply[]> {
    if (!deps.history) return reply(input, 'History import is not running.');
    const [verb, messageId, ...rest] = words;
    if (
        !messageId ||
        !MESSAGE_ID.test(messageId) ||
        (verb === 'edit' && rest.length === 0)
    ) {
        return reply(
            input,
            'Use `edit <message-id> <text>` or `delete <message-id>`, with the Fluxer message ID.'
        );
    }
    const discordId = await discordIdOf(input, deps);
    if (!discordId) return reply(input, 'Link your accounts first.');
    const copy = await deps.history.editor.ownCopy(messageId, discordId);
    if (!copy)
        return reply(
            input,
            'That message was not imported from one of your messages.'
        );
    if (verb === 'edit') await deps.history.editor.edit(copy, rest.join(' '));
    else await deps.history.editor.remove(copy);
    return reply(
        input,
        verb === 'edit' ? 'The message was edited.' : 'The message was deleted.'
    );
}

/** Handles one DM to the bot. Returns the DMs to send back. */
export async function handleDm(
    input: DmInput,
    deps: FlowDeps
): Promise<DmReply[]> {
    const words = input.text.trim().split(/\s+/);
    const verb = (words[0] ?? '').toLowerCase();
    switch (verb) {
        case 'link':
            return words.length === 1
                ? startLink(input, deps)
                : redeem(input, (words[1] ?? '').toUpperCase(), deps);
        case 'yes':
        case 'no':
            return confirm(input, verb === 'yes', deps);
        case 'unlink':
            return unlink(input, deps);
        case 'history-optout':
        case 'history-optin':
            return optOut(input, verb === 'history-optout', deps);
        case 'edit':
        case 'delete':
            return changeCopy(input, [verb, ...words.slice(1)], deps);
        default:
            return reply(input, HELP);
    }
}
