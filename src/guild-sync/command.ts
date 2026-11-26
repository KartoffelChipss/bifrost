import { SYNC_MODES, type SyncMode } from '../addons/db/schema';
import type { LinkedGuild } from './cycle';
import { summarizePlan, type Plan } from './plan';
import type { GuildSyncStore, SyncSettings } from './store';
import {
    describeResetPreview,
    resetBlocked,
    resetTargets,
    targetSetKey,
    type PendingResets,
} from './threadReset';
import type { ThreadResetLauncher } from './threadResetJob';

/**
 * Parsing and wording for the `sync` admin command. Kept apart from the
 * Discord handler (commandHandler.ts) so it loads without upstream's
 * environment checks.
 */

export type SyncCommand =
    | { readonly type: 'status' }
    | { readonly type: 'mode'; readonly mode: SyncMode }
    | { readonly type: 'kill'; readonly on: boolean }
    | { readonly type: 'enforce'; readonly on: boolean }
    | { readonly type: 'history-retry' }
    | { readonly type: 'channel'; readonly here: boolean }
    | { readonly type: 'approve'; readonly planId: string }
    | { readonly type: 'reject'; readonly planId: string }
    /** The preview, or with `confirm` the reset of what was previewed. */
    | { readonly type: 'reset-threads'; readonly confirm: boolean }
    | { readonly type: 'error'; readonly message: string };

export const SYNC_USAGE = [
    'Usage:',
    '`sync status`',
    '`sync mode <dry-run|apply|read-only>`',
    '`sync kill <on|off>`',
    '`sync enforce <on|off>`',
    '`sync history retry`',
    '`sync channel <here|off>`',
    '`sync approve <plan-id>`',
    '`sync reject <plan-id>`',
    '`sync reset-threads` (then `sync reset-threads confirm`)',
].join('\n');

const PLAN_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses the words after `sync`. Unknown input is an error, never a guess. */
export function parseSyncCommand(args: readonly string[]): SyncCommand {
    const [verb = 'status', value = ''] = args.map((a) => a.toLowerCase());
    if (verb === 'status' && args.length <= 1) return { type: 'status' };
    if (verb === 'mode' && args.length === 2) {
        const mode = SYNC_MODES.find((candidate) => candidate === value);
        if (mode) return { type: 'mode', mode };
    }
    if (verb === 'kill' && args.length === 2) {
        if (value === 'on') return { type: 'kill', on: true };
        if (value === 'off') return { type: 'kill', on: false };
    }
    if (verb === 'enforce' && args.length === 2) {
        if (value === 'on') return { type: 'enforce', on: true };
        if (value === 'off') return { type: 'enforce', on: false };
    }
    if (verb === 'history' && value === 'retry' && args.length === 2) {
        return { type: 'history-retry' };
    }
    if (verb === 'channel' && args.length === 2) {
        if (value === 'here') return { type: 'channel', here: true };
        if (value === 'off') return { type: 'channel', here: false };
    }
    if ((verb === 'approve' || verb === 'reject') && args.length === 2) {
        if (PLAN_ID.test(value)) return { type: verb, planId: value };
    }
    if (verb === 'reset-threads') return parseReset(args);
    return { type: 'error', message: SYNC_USAGE };
}

/** `reset-threads` alone, or `reset-threads confirm`. */
function parseReset(args: readonly string[]): SyncCommand {
    if (args.length === 1) return { type: 'reset-threads', confirm: false };
    if (args.length === 2 && args[1].toLowerCase() === 'confirm') {
        return { type: 'reset-threads', confirm: true };
    }
    return { type: 'error', message: SYNC_USAGE };
}

/** Discord cuts an embed description at 4096 characters. */
const MAX_STATUS_LENGTH = 3_800;

/** What the status reply says. Pure, so tests need no Discord client. */
export function describeStatus(
    settings: SyncSettings,
    allowApply: boolean,
    plan: Plan | null
): string {
    const lines = [
        `Mode: **${settings.mode}**, direction ${settings.direction}`,
        `Kill switch: **${settings.killSwitch ? 'on' : 'off'}**`,
        settings.enforceDrift
            ? 'Drift: **enforced**. Fluxer edits to synced fields are reverted.'
            : 'Drift: **reported**. Fluxer edits to synced fields are kept.',
        settings.adminChannelId
            ? `Admin channel: <#${settings.adminChannelId}>`
            : 'Admin channel: not set. Plans are only logged.',
    ];
    if (settings.mode === 'apply' && !allowApply) {
        lines.push(
            'Apply is set, but `BF_ADDONS_ALLOW_APPLY` is not true. Plans stay dry-runs.'
        );
    }
    lines.push('', plan ? summarizePlan(plan) : 'No plan saved yet.');
    const text = lines.join('\n');
    return text.length > MAX_STATUS_LENGTH
        ? `${text.slice(0, MAX_STATUS_LENGTH)}\n…`
        : text;
}

export interface SyncCommandContext {
    readonly store: Pick<
        GuildSyncStore,
        | 'loadSettings'
        | 'setMode'
        | 'setKillSwitch'
        | 'setEnforceDrift'
        | 'setAdminChannel'
        | 'setApprovedPlan'
        | 'setPlanStatus'
        | 'getPlan'
        | 'loadObjectMap'
        | 'lastSnapshot'
    >;
    /** `sync reset-threads`. Absent where guild-sync cannot run it. */
    readonly threadReset?: ThreadResetCommandDeps;
    /**
     * Puts the link's failed history imports back to work, returning how
     * many. Absent when history import is off.
     */
    readonly retryHistory?: (guildLinkId: string, now: Date) => Promise<number>;
    /** True for a channel the relay bridges. Notices must not go there. */
    readonly isChannelLinked: (channelId: string) => Promise<boolean>;
    /**
     * Called after a command changed something, so the link's status
     * message is updated now rather than after the next cycle.
     */
    readonly changed?: (guildLinkId: string) => void;
    readonly now: () => Date;
}

/** What `sync reset-threads` needs besides the store. */
export interface ThreadResetCommandDeps {
    readonly pending: PendingResets;
    readonly launcher: ThreadResetLauncher;
    /** BF_ADDONS_ALLOW_APPLY. */
    readonly allowApply: boolean;
    /**
     * BF_ADDONS_RESET_USER_ID: the only user who may run the command, not
     * even the server owner otherwise. Null turns the command off.
     */
    readonly userId: string | null;
}

/**
 * Why this author may not run `sync reset-threads`, or null. The other
 * subcommands keep the owner check in commandHandler.ts.
 */
export function resetRefusal(
    reset: ThreadResetCommandDeps | undefined,
    authorId: string
): string | null {
    if (!reset?.userId) {
        return '`sync reset-threads` is not set up: `BF_ADDONS_RESET_USER_ID` is unset or invalid.';
    }
    if (authorId !== reset.userId) {
        return 'Only the user named in `BF_ADDONS_RESET_USER_ID` can reset threads.';
    }
    return null;
}

/** Finds a plan that still waits for approval on this link. */
async function pendingPlan(
    planId: string,
    link: LinkedGuild,
    ctx: SyncCommandContext
): Promise<Plan | null> {
    const plan = await ctx.store.getPlan(planId);
    const waiting =
        plan?.guildLinkId === link.id && plan.status === 'pending-approval';
    return waiting ? plan : null;
}

/** A command that worked and has something to say besides the status. */
export interface SyncCommandNote {
    readonly note: string;
    /** Shown without the status after it. */
    readonly alone?: boolean;
}

async function retryHistory(
    link: LinkedGuild,
    ctx: SyncCommandContext
): Promise<string | SyncCommandNote> {
    if (!ctx.retryHistory) return 'History import is not switched on.';
    const count = await ctx.retryHistory(link.id, ctx.now());
    return {
        note:
            count === 0
                ? 'No history import had failed.'
                : `Restarted ${count} failed history import${count === 1 ? '' : 's'}.`,
    };
}

type RunnableCommand = Exclude<SyncCommand, { type: 'error' }>;

/**
 * Carries out one command for `authorId`. Returns an error text, null when
 * it worked, or a note to show with the status. Once an admin channel is
 * set, every command must come from it. A command that worked and changed
 * something reports it through `ctx.changed`.
 */
export async function runSyncCommand(
    command: RunnableCommand,
    link: LinkedGuild,
    channelId: string,
    ctx: SyncCommandContext,
    authorId = ''
): Promise<string | SyncCommandNote | null> {
    if (command.type === 'reset-threads') {
        const refused = resetRefusal(ctx.threadReset, authorId);
        if (refused) return refused;
    }
    const result = await carryOut(command, link, channelId, ctx, authorId);
    if (typeof result !== 'string' && changesState(command)) {
        ctx.changed?.(link.id);
    }
    return result;
}

/** False for a command that only shows something. */
function changesState(command: RunnableCommand): boolean {
    if (command.type === 'status') return false;
    return command.type !== 'reset-threads' || command.confirm;
}

/** The link's reset targets and why a reset may not run now. */
async function resetState(
    link: LinkedGuild,
    settings: SyncSettings,
    ctx: SyncCommandContext,
    reset: ThreadResetCommandDeps
) {
    const rows = await ctx.store.loadObjectMap(link.id);
    const discord = await ctx.store.lastSnapshot(link.id, 'discord', true);
    const threads = resetTargets(rows, discord);
    const blocked = resetBlocked(settings, reset.allowApply);
    return {
        threads,
        blocked,
        setKey: targetSetKey(link.id, threads.targets),
    };
}

/** Who runs a reset command, where, and with what. */
interface ResetCall {
    readonly link: LinkedGuild;
    readonly settings: SyncSettings;
    readonly authorId: string;
    readonly ctx: SyncCommandContext;
    readonly reset: ThreadResetCommandDeps;
}

/**
 * `sync reset-threads`: the preview. When the reset may run, it is
 * remembered for this user and link, bound to the exact set shown.
 */
async function previewReset(call: ResetCall): Promise<SyncCommandNote> {
    const { link, settings, ctx, reset } = call;
    const state = await resetState(link, settings, ctx, reset);
    if (!state.blocked && state.threads.targets.length > 0) {
        reset.pending.remember(link.id, call.authorId, state.setKey, ctx.now());
    }
    return {
        note: describeResetPreview(state.threads, state.blocked),
        alone: true,
    };
}

const CONFIRM_REFUSALS = {
    missing:
        'No reset preview is waiting for you. Run `sync reset-threads` first; a preview can be confirmed for 10 minutes.',
    changed:
        'The threads changed since your preview. Run `sync reset-threads` again to see the new set.',
} as const;

/** `sync reset-threads confirm`: starts the previewed reset in the background. */
async function confirmReset(
    call: ResetCall
): Promise<string | SyncCommandNote> {
    const { link, settings, ctx, reset, authorId } = call;
    const state = await resetState(link, settings, ctx, reset);
    if (state.blocked) return state.blocked;
    const { targets } = state.threads;
    if (targets.length === 0) return 'No thread copies to reset.';
    const check = reset.pending.check(
        link.id,
        authorId,
        state.setKey,
        ctx.now()
    );
    if (check !== 'ok') return CONFIRM_REFUSALS[check];
    const started = reset.launcher.start(link, targets);
    if (started === 'busy') return 'A thread reset is already running.';
    if (started === 'unavailable') {
        return 'Guild sync is not running, so the reset cannot start.';
    }
    reset.pending.clear(link.id, authorId);
    return {
        note: `Resetting ${targets.length} thread copies in the background, about one per second. A notice in this channel reports the result.`,
        alone: true,
    };
}

async function runReset(
    command: Extract<RunnableCommand, { type: 'reset-threads' }>,
    call: Omit<ResetCall, 'reset'>
): Promise<string | SyncCommandNote> {
    const reset = call.ctx.threadReset;
    if (!reset) return 'Thread reset is not available here.';
    return command.confirm
        ? confirmReset({ ...call, reset })
        : previewReset({ ...call, reset });
}

async function carryOut(
    command: RunnableCommand,
    link: LinkedGuild,
    channelId: string,
    ctx: SyncCommandContext,
    authorId: string
): Promise<string | SyncCommandNote | null> {
    const { store, now } = ctx;
    const settings = await store.loadSettings(link.id);
    const admin = settings.adminChannelId;
    if (admin && admin !== channelId && command.type !== 'channel') {
        return `Use this command in the admin channel, <#${admin}>.`;
    }
    switch (command.type) {
        case 'status':
            return null;
        case 'mode':
            if (command.mode === 'apply' && !admin) {
                return 'Set the admin channel first: run `sync channel here` in a private channel.';
            }
            await store.setMode(link.id, command.mode, now());
            return null;
        case 'kill':
            await store.setKillSwitch(link.id, command.on, now());
            return null;
        case 'enforce':
            await store.setEnforceDrift(link.id, command.on, now());
            return null;
        case 'history-retry':
            return retryHistory(link, ctx);
        case 'reset-threads':
            return runReset(command, { link, settings, authorId, ctx });
        case 'channel':
            if (command.here && (await ctx.isChannelLinked(channelId))) {
                return 'This channel is bridged. Notices here would be copied to the other server. Pick a channel that is not linked.';
            }
            await store.setAdminChannel(
                link.id,
                command.here ? channelId : null,
                now()
            );
            return null;
        case 'approve':
        case 'reject': {
            const plan = await pendingPlan(command.planId, link, ctx);
            if (!plan) return 'No plan with that ID is waiting for approval.';
            if (command.type === 'approve') {
                await store.setApprovedPlan(link.id, plan.id, now());
                return null;
            }
            await store.setPlanStatus(
                plan.id,
                'aborted',
                'rejected by an admin',
                now()
            );
            if (settings.approvedPlanId === plan.id) {
                await store.setApprovedPlan(link.id, null, now());
            }
            return null;
        }
    }
}
