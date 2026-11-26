import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    STATUS_TITLE,
    renderStatus,
    statusColor,
    type StatusView,
} from '../../src/guild-sync/status';
import { EmbedColors } from '../../src/utils/embeds';
import { DEFAULT_SETTINGS } from './fake-store';

const AT = new Date('2026-11-25T12:00:00Z');
const UNIX = Math.floor(AT.getTime() / 1000);

function view(overrides: Partial<StatusView> = {}): StatusView {
    return {
        settings: { ...DEFAULT_SETTINGS, mode: 'apply' },
        mode: { mode: 'apply', reason: null },
        allowApply: true,
        commandPrefix: '!b ',
        plan: {
            id: 'plan-1',
            status: 'dry-run',
            abortReason: null,
            deferred: 0,
            at: AT,
        },
        apply: {
            planId: 'plan-1',
            at: AT,
            applied: 50,
            failed: 0,
            notApplied: 2,
            stopped: null,
        },
        mapped: { role: 12, channel: 1234, emoji: 3 },
        history: null,
        updatedAt: AT,
        ...overrides,
    };
}

describe('renderStatus', () => {
    it('shows a healthy apply link in green', () => {
        const embed = renderStatus(view());
        assert.equal(embed.title, STATUS_TITLE);
        assert.equal(embed.color, EmbedColors.Success);
        const lines = embed.description.split('\n');
        assert.deepEqual(lines, [
            '**Mode:** **apply** · kill switch off · discord-to-fluxer',
            `**Last plan:** \`plan-1\` (dry-run), <t:${UNIX}:R>`,
            `**Last apply:** 50 written, 0 failed, 2 not applied, <t:${UNIX}:R>`,
            '**Mapped:** 12 roles · 1,234 channels · 3 emojis',
            '',
            `Updated <t:${UNIX}:R>`,
        ]);
    });

    it('shows deferred changes and history progress', () => {
        const embed = renderStatus(
            view({
                plan: {
                    id: 'plan-2',
                    status: 'dry-run',
                    abortReason: null,
                    deferred: 230,
                    at: AT,
                },
                history: {
                    jobs: 30,
                    open: 9,
                    failed: 1,
                    imported: 12345,
                    skipped: 12,
                },
            })
        );
        assert.match(
            embed.description,
            /\*\*Deferred:\*\* 230 changes wait for later cycles/
        );
        assert.match(
            embed.description,
            /\*\*History:\*\* 30 jobs: 20 done, 9 open, 1 failed/
        );
        assert.match(
            embed.description,
            /\*\*Messages:\*\* 12,345 copied, 12 skipped/
        );
    });

    it('shows a read-only link and why in red', () => {
        const embed = renderStatus(
            view({
                settings: { ...DEFAULT_SETTINGS, killSwitch: true },
                mode: { mode: 'read-only', reason: 'kill switch is on' },
                apply: null,
            })
        );
        assert.equal(embed.color, EmbedColors.Error);
        assert.match(
            embed.description,
            /\*\*read-only\*\* \(kill switch is on\) · kill switch on/
        );
        assert.match(embed.description, /Last apply:\*\* none since/);
    });

    it('shows a plan waiting for approval in yellow, with the command', () => {
        const embed = renderStatus(
            view({
                plan: {
                    id: 'plan-3',
                    status: 'pending-approval',
                    abortReason: null,
                    deferred: 0,
                    at: null,
                },
            })
        );
        assert.equal(embed.color, EmbedColors.Warning);
        assert.match(embed.description, /\(pending-approval\)\n/);
        assert.match(embed.description, /`!b sync approve plan-3`/);
    });

    it('says why a link set to apply stays a dry-run', () => {
        const embed = renderStatus(
            view({ mode: { mode: 'dry-run', reason: null }, allowApply: false })
        );
        assert.equal(embed.color, EmbedColors.Warning);
        assert.match(embed.description, /BF_ADDONS_ALLOW_APPLY/);
    });

    it('shows failures and an early stop of the latest plan in red', () => {
        const failed = view({
            apply: {
                planId: 'plan-1',
                at: AT,
                applied: 3,
                failed: 2,
                notApplied: 0,
                stopped: 'the leader lock was lost',
            },
        });
        assert.equal(statusColor(failed), EmbedColors.Error);
        const text = renderStatus(failed).description;
        assert.match(text, /3 written, 2 failed/);
        assert.match(text, /\*\*Stopped early:\*\* the leader lock was lost/);
    });

    it('does not stay red for a failure an earlier plan had', () => {
        const old = view({
            apply: {
                planId: 'plan-0',
                at: AT,
                applied: 0,
                failed: 2,
                notApplied: 0,
                stopped: null,
            },
        });
        assert.equal(statusColor(old), EmbedColors.Success);
    });

    it('shows an aborted plan and its reason in red', () => {
        const embed = renderStatus(
            view({
                plan: {
                    id: 'plan-4',
                    status: 'aborted',
                    abortReason: 'destination error: 503',
                    deferred: 0,
                    at: AT,
                },
            })
        );
        assert.equal(embed.color, EmbedColors.Error);
        assert.match(embed.description, /\*\*Aborted:\*\* destination error/);
    });

    it('says when nothing is mapped or planned yet', () => {
        const embed = renderStatus(
            view({ plan: null, apply: null, mapped: {} })
        );
        assert.match(embed.description, /Last plan:\*\* none saved yet/);
        assert.match(embed.description, /Mapped:\*\* nothing yet/);
    });
});
