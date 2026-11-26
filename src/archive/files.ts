import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { FileGoneError } from '../services/fluxerFiles';
import type { ArchiveFileStore } from './types';

/** Time allowed for one download; Discord files go up to 500 MiB. */
export const FILE_TIMEOUT_MS = 10 * 60_000;
/** Refuses anything larger, well above Discord's own 500 MiB limit. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Statuses for a file Discord no longer serves (fluxerFiles.ts). */
const GONE_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);
const SHA256 = /^[0-9a-f]{64}$/;

export type Fetch = (
    url: string,
    init: { signal: AbortSignal }
) => Promise<Response>;

export class FileTooLargeError extends Error {
    constructor(readonly url: string) {
        super(`File at ${url} is over ${MAX_FILE_BYTES} bytes`);
        this.name = 'FileTooLargeError';
    }
}

/** Hashes and counts bytes as they pass, refusing more than the cap. */
class Digest extends Transform {
    readonly hash = createHash('sha256');
    size = 0;

    constructor(private readonly url: string) {
        super();
    }

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        done: TransformCallback
    ): void {
        this.size += chunk.length;
        if (this.size > MAX_FILE_BYTES) {
            done(new FileTooLargeError(this.url));
            return;
        }
        this.hash.update(chunk);
        done(null, chunk);
    }
}

/**
 * Stores files on a local volume by SHA-256: `files/ab/<sha256>`. A
 * download goes to `tmp/` first and is renamed into place once complete,
 * so a crash never leaves a partial file under its hash.
 */
export class DiskFileStore implements ArchiveFileStore {
    constructor(
        private readonly root: string,
        private readonly fetcher: Fetch = fetch
    ) {}

    /** Makes the store's folders. Call once before use. */
    async init(): Promise<void> {
        await mkdir(join(this.root, 'tmp'), { recursive: true });
        await mkdir(join(this.root, 'files'), { recursive: true });
    }

    async put(url: string): Promise<{ sha256: string; size: number }> {
        const res = await this.fetcher(url, {
            signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
        });
        if (GONE_STATUSES.has(res.status))
            throw new FileGoneError(url, res.status);
        if (!res.ok || !res.body) {
            throw new Error(`Failed to fetch file from ${url}: ${res.status}`);
        }
        const temp = join(this.root, 'tmp', randomUUID());
        try {
            const digest = new Digest(url);
            const body = Readable.fromWeb(res.body as WebReadableStream);
            await pipeline(body, digest, createWriteStream(temp));
            const sha256 = digest.hash.digest('hex');
            await this.place(temp, sha256);
            return { sha256, size: digest.size };
        } finally {
            await rm(temp, { force: true });
        }
    }

    async remove(sha256: string): Promise<void> {
        if (!SHA256.test(sha256)) throw new Error(`not a SHA-256: ${sha256}`);
        await rm(this.pathOf(sha256), { force: true });
    }

    async freeBytes(): Promise<number> {
        const fs = await statfs(this.root);
        return fs.bavail * fs.bsize;
    }

    /** Moves a finished download under its hash, unless already there. */
    private async place(temp: string, sha256: string): Promise<void> {
        const target = this.pathOf(sha256);
        if (await exists(target)) return;
        await mkdir(join(this.root, 'files', sha256.slice(0, 2)), {
            recursive: true,
        });
        await rename(temp, target);
    }

    private pathOf(sha256: string): string {
        return join(this.root, 'files', sha256.slice(0, 2), sha256);
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}
