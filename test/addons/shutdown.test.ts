import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    registerAddonShutdown,
    signalExitCode,
    type ShutdownProcess,
    type ShutdownSignal,
} from '../../src/addons/shutdown';
import { createRecordingLogger } from './fakes';

function fakeProcess() {
    const listeners = new Map<ShutdownSignal, () => void>();
    const log: string[] = [];
    const proc: ShutdownProcess = {
        pid: 42,
        once: (signal, listener) => listeners.set(signal, listener),
        kill: (pid, signal) => log.push(`kill ${pid} ${signal}`),
        exit: (code) => log.push(`exit ${code}`),
    };
    return { proc, listeners, log };
}

describe('registerAddonShutdown', () => {
    it('stops the add-ons, then ends by the same signal', async () => {
        const { proc, listeners, log } = fakeProcess();
        const addons = { stop: async () => void log.push('stop') };
        registerAddonShutdown(addons, createRecordingLogger(), proc);
        assert.deepEqual([...listeners.keys()], ['SIGTERM', 'SIGINT']);
        listeners.get('SIGTERM')?.();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(log, ['stop', 'kill 42 SIGTERM']);
    });

    it('still ends when stopping fails', async () => {
        const { proc, listeners, log } = fakeProcess();
        const logger = createRecordingLogger();
        const addons = {
            stop: async () => {
                throw new Error('stuck');
            },
        };
        registerAddonShutdown(addons, logger, proc);
        listeners.get('SIGINT')?.();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(log, ['kill 42 SIGINT']);
        assert.ok(logger.entries.some((e) => e.level === 'error'));
    });

    it('reports the exit status of a signal kill', () => {
        assert.equal(signalExitCode('SIGTERM'), 143);
        assert.equal(signalExitCode('SIGINT'), 130);
    });
});
