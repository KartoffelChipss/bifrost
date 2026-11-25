import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
    IsolationBoundary,
    LIVE_FAILURE_LIMIT,
    LIVE_FAILURE_WINDOW_MS,
    LIVE_PAUSE_MS,
    LiveFailurePolicy,
    UnrecordedWriteError,
} from '../../src/addons/isolation';
import { AddonModeController } from '../../src/addons/mode';
import { createRecordingLogger } from './fakes';

function setup() {
    const mode = new AddonModeController('apply');
    const logger = createRecordingLogger();
    return { mode, logger, boundary: new IsolationBoundary(mode, logger) };
}

describe('IsolationBoundary.run', () => {
    it('returns the value and keeps the mode on success', async () => {
        const { mode, boundary } = setup();
        const result = await boundary.run('test', 'task', async () => 42);
        assert.deepEqual(result, { ok: true, value: 42 });
        assert.equal(mode.mode, 'apply');
    });

    it('catches a thrown error and switches to read-only', async () => {
        const { mode, logger, boundary } = setup();
        const result = await boundary.run('test', 'task', () => {
            throw new Error('boom');
        });
        assert.equal(result.ok, false);
        assert.equal(mode.mode, 'read-only');
        assert.match(mode.readOnlyReason ?? '', /test\/task/);
        assert.ok(logger.entries.some((entry) => entry.level === 'error'));
    });

    it('catches a rejected promise and switches to read-only', async () => {
        const { mode, boundary } = setup();
        const result = await boundary.run('test', 'task', () =>
            Promise.reject(new Error('boom'))
        );
        assert.equal(result.ok, false);
        assert.equal(mode.mode, 'read-only');
    });
});

describe('IsolationBoundary.handler', () => {
    it('keeps other listeners on the emitter running after an add-on error', async () => {
        const { mode, boundary } = setup();
        const emitter = new EventEmitter();
        const relayed: string[] = [];
        let unhandled = 0;
        const onUnhandled = () => unhandled++;
        process.on('unhandledRejection', onUnhandled);

        // Stands in for the relay listener, registered before the add-on.
        emitter.on('message', (content: string) => relayed.push(content));
        emitter.on(
            'message',
            boundary.handler('identity', 'dm', async () => {
                throw new Error('boom');
            })
        );

        assert.doesNotThrow(() => emitter.emit('message', 'one'));
        await new Promise((resolve) => setImmediate(resolve));
        emitter.emit('message', 'two');
        await new Promise((resolve) => setImmediate(resolve));
        process.off('unhandledRejection', onUnhandled);

        assert.deepEqual(relayed, ['one', 'two']);
        // A live handler error never switches every add-on to read-only.
        assert.equal(mode.mode, 'apply');
        assert.equal(unhandled, 0);
    });
});

describe('IsolationBoundary.handler live failure policy', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    function liveSetup() {
        const mode = new AddonModeController('apply');
        const logger = createRecordingLogger();
        const clock = { now: 0 };
        const live = new LiveFailurePolicy(() => clock.now);
        const boundary = new IsolationBoundary(mode, logger, live);
        let calls = 0;
        const failing = boundary.handler('relay', 'pin', async () => {
            calls++;
            throw new Error('boom');
        });
        return { mode, logger, clock, boundary, failing, calls: () => calls };
    }

    it('pauses only the failing feature after repeated errors', async () => {
        const { mode, boundary, failing, calls } = liveSetup();
        let other = 0;
        const healthy = boundary.handler('relay', 'reaction', () => {
            other++;
        });
        for (let i = 0; i < LIVE_FAILURE_LIMIT + 2; i++) {
            failing();
            healthy();
            await flush();
        }
        assert.equal(calls(), LIVE_FAILURE_LIMIT);
        assert.equal(other, LIVE_FAILURE_LIMIT + 2);
        assert.equal(boundary.live.isPaused('relay/pin'), true);
        assert.equal(mode.mode, 'apply');
    });

    it('resumes a paused feature after the pause', async () => {
        const { clock, boundary, failing, calls, logger } = liveSetup();
        for (let i = 0; i < LIVE_FAILURE_LIMIT; i++) {
            failing();
            await flush();
        }
        clock.now = LIVE_PAUSE_MS;
        failing();
        await flush();
        assert.equal(calls(), LIVE_FAILURE_LIMIT + 1);
        assert.equal(boundary.live.isPaused('relay/pin'), false);
        assert.ok(logger.entries.some((e) => /resumed/.test(e.message)));
    });

    it('forgets errors older than the window', async () => {
        const { clock, boundary, failing } = liveSetup();
        for (let i = 0; i < LIVE_FAILURE_LIMIT - 1; i++) {
            failing();
            await flush();
        }
        clock.now = LIVE_FAILURE_WINDOW_MS;
        failing();
        await flush();
        assert.equal(boundary.live.isPaused('relay/pin'), false);
    });

    it('still trips read-only for an unrecorded structure write', async () => {
        const { mode, boundary } = liveSetup();
        boundary.handler('guild-sync', 'thread-message', async () => {
            throw new UnrecordedWriteError('thread not recorded');
        })();
        await flush();
        assert.equal(mode.mode, 'read-only');
    });
});
