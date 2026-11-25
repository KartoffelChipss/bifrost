import { SYNC_MODES, type SyncMode } from '../addons/db/schema';
import type { LinkedGuild } from './cycle';
import { summarizePlan, type Plan } from './plan';
import type { GuildSyncStore, SyncSettings } from './store';

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
    | { readonly type: 'channel'; readonly here: boolean }
    | { readonly type: 'approve'; readonly planId: string }
    | { readonly type: 'reject'; readonly planId: string }
    | { readonly type: 'error'; readonly message: string };

export const SYNC_USAGE = [
    'Usage:',
    '`sync status`',
    '`sync mode <dry-run|apply|read-only>`',
    '`sync kill <on|off>`',
    '`sync enforce <on|off>`',
    '`sync channel <here|off>`',
    '`sync approve <plan-id>`',
    '`sync reject <plan-id>`',
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
    if (verb === 'channel' && args.length === 2) {
        if (value === 'here') return { type: 'channel', here: true };
        if (value === 'off') return { type: 'channel', here: false };
    }
    if ((verb === 'approve' || verb === 'reject') && args.length === 2) {
        if (PLAN_ID.test(value)) return { type: verb, planId: value };
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
    >;
    /** True for a channel the relay bridges. Notices must not go there. */
    readonly isChannelLinked: (channelId: string) => Promise<boolean>;
    readonly now: () => Date;
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

/**
 * Carries out one command. Returns an error text, or null when it worked.
 * Once an admin channel is set, every command must come from it.
 */
export async function runSyncCommand(
    command: Exclude<SyncCommand, { type: 'error' }>,
    link: LinkedGuild,
    channelId: string,
    ctx: SyncCommandContext
): Promise<string | null> {
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
