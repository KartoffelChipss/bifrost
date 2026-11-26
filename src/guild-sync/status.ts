import { OBJECT_KINDS, type ObjectKind } from '../addons/db/schema';
import type { PlanStatus } from '../addons/db/schema';
import type { JobTotals } from '../history/types';
import { EmbedColors } from '../utils/embeds';
import type { resolveMode } from './cycle';
import type { MappedCounts, SyncSettings } from './store';

/**
 * What the live status message says. Pure, so tests need no Discord client;
 * statusBoard.ts gathers the view and posts or edits the message.
 */

/** The link's latest plan, and when this process saved it, if it did. */
export interface PlanInfo {
    readonly id: string;
    readonly status: PlanStatus;
    readonly abortReason: string | null;
    /** Ops over the write cap, waiting for later cycles. */
    readonly deferred: number;
    /** Null for a plan saved before this process started. */
    readonly at: Date | null;
}

/** What the last apply run in this process did. */
export interface ApplyInfo {
    readonly planId: string;
    readonly at: Date;
    readonly applied: number;
    readonly failed: number;
    readonly notApplied: number;
    readonly stopped: string | null;
}

export interface StatusView {
    readonly settings: SyncSettings;
    readonly mode: ReturnType<typeof resolveMode>;
    readonly allowApply: boolean;
    readonly commandPrefix: string;
    readonly plan: PlanInfo | null;
    readonly apply: ApplyInfo | null;
    readonly mapped: MappedCounts;
    /** Null when history import is off. */
    readonly history: JobTotals | null;
    readonly updatedAt: Date;
}

/** An embed as plain data: the Discord port turns it into a real one. */
export interface StatusEmbed {
    readonly title: string;
    readonly description: string;
    readonly color: number;
}

export const STATUS_TITLE = 'Guild sync status';

const KIND_LABELS: Readonly<Record<ObjectKind, string>> = {
    guild: 'server',
    role: 'roles',
    category: 'categories',
    channel: 'channels',
    overwrite: 'overwrites',
    emoji: 'emojis',
    sticker: 'stickers',
    thread: 'threads',
};

const count = (n: number) => n.toLocaleString('en-US');

/** A Discord timestamp that reads as "5 minutes ago". */
export function relativeTime(at: Date): string {
    return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
}

function modeLine(view: StatusView): string {
    const { mode, settings, allowApply } = view;
    let label = `**${mode.mode}**`;
    if (mode.reason) label += ` (${mode.reason})`;
    else if (mode.mode === 'dry-run' && settings.mode === 'apply') {
        if (!allowApply) label += ' (`BF_ADDONS_ALLOW_APPLY` is not true)';
    }
    const kill = settings.killSwitch ? 'on' : 'off';
    return `**Mode:** ${label} · kill switch ${kill} · ${settings.direction}`;
}

function planLines(view: StatusView): string[] {
    const { plan, commandPrefix } = view;
    if (!plan) return ['**Last plan:** none saved yet'];
    const when = plan.at ? `, ${relativeTime(plan.at)}` : '';
    const lines = [`**Last plan:** \`${plan.id}\` (${plan.status})${when}`];
    if (plan.abortReason) lines.push(`**Aborted:** ${plan.abortReason}`);
    if (plan.status === 'pending-approval') {
        lines.push(
            `**Waiting for approval:** \`${commandPrefix}sync approve ${plan.id}\``
        );
    }
    if (plan.deferred > 0) {
        lines.push(
            `**Deferred:** ${count(plan.deferred)} changes wait for later cycles`
        );
    }
    return lines;
}

function applyLines(apply: ApplyInfo | null): string[] {
    if (!apply) return ['**Last apply:** none since the bot started'];
    const lines = [
        `**Last apply:** ${count(apply.applied)} written, ${count(apply.failed)} failed, ${count(apply.notApplied)} not applied, ${relativeTime(apply.at)}`,
    ];
    if (apply.stopped) lines.push(`**Stopped early:** ${apply.stopped}`);
    return lines;
}

function mappedLine(mapped: MappedCounts): string {
    const parts = OBJECT_KINDS.flatMap((kind) => {
        const n = mapped[kind] ?? 0;
        return n > 0 ? [`${count(n)} ${KIND_LABELS[kind]}`] : [];
    });
    return `**Mapped:** ${parts.join(' · ') || 'nothing yet'}`;
}

function historyLines(history: JobTotals | null): string[] {
    if (!history) return [];
    const { jobs, open, failed, imported, skipped } = history;
    const done = Math.max(jobs - open - failed, 0);
    return [
        `**History:** ${count(jobs)} jobs: ${count(done)} done, ${count(open)} open, ${count(failed)} failed`,
        `**Messages:** ${count(imported)} copied, ${count(skipped)} skipped`,
    ];
}

/** True when the last apply belongs to the latest plan and went wrong. */
function applyFailed(view: StatusView): boolean {
    const { apply, plan } = view;
    if (!apply || !plan || apply.planId !== plan.id) return false;
    return apply.failed > 0 || apply.stopped !== null;
}

/** Red for read-only or trouble, yellow while not writing, green for apply. */
export function statusColor(view: StatusView): number {
    if (view.mode.mode === 'read-only') return EmbedColors.Error;
    if (view.plan?.status === 'aborted' || applyFailed(view)) {
        return EmbedColors.Error;
    }
    if (view.mode.mode === 'dry-run') return EmbedColors.Warning;
    if (view.plan?.status === 'pending-approval') return EmbedColors.Warning;
    return EmbedColors.Success;
}

/** Everything but the time of the update, for telling two views apart. */
export function statusBody(view: StatusView): string {
    return [
        modeLine(view),
        ...planLines(view),
        ...applyLines(view.apply),
        mappedLine(view.mapped),
        ...historyLines(view.history),
    ].join('\n');
}

/** Discord cuts an embed description at 4096 characters. */
const MAX_BODY_LENGTH = 3_800;

export function renderStatus(view: StatusView): StatusEmbed {
    const body = statusBody(view);
    const cut =
        body.length > MAX_BODY_LENGTH
            ? `${body.slice(0, MAX_BODY_LENGTH)}\n…`
            : body;
    return {
        title: STATUS_TITLE,
        description: `${cut}\n\nUpdated ${relativeTime(view.updatedAt)}`,
        color: statusColor(view),
    };
}
