import type { AddonLogger } from '../addons/isolation';
import { FileGoneError } from '../services/fluxerFiles';
import { describe } from './members';
import type { PostgresArchiveStore } from './store';
import type { ArchiveFileStore, FileRef } from './types';

export type FileOutcome = 'stored' | 'gone' | 'failed' | 'skipped' | 'held';

export interface FileFetchDeps {
    readonly store: Pick<
        PostgresArchiveStore,
        'fileWanted' | 'fileStored' | 'fileGone' | 'fileFailed' | 'fileHeld'
    >;
    readonly files: ArchiveFileStore;
    /** Downloads stop while the volume has less free space than this. */
    readonly minFreeBytes: number;
    readonly logger: AddonLogger;
    readonly now: () => Date;
}

/**
 * Downloads one file into the file store and records how it went. A file
 * already stored, gone or given up on is skipped. While the volume is low
 * on space, files are held as pending and fetched later.
 */
export class FileFetcher {
    private lowSpaceLogged = false;

    constructor(private readonly deps: FileFetchDeps) {}

    async fetch(ref: FileRef): Promise<FileOutcome> {
        const { store, now } = this.deps;
        if (!(await store.fileWanted(ref.kind, ref.sourceId))) return 'skipped';
        if (!(await this.roomFor(ref))) {
            await store.fileHeld(ref.kind, ref.sourceId, now());
            return 'held';
        }
        try {
            const stored = await this.deps.files.put(ref.url);
            await store.fileStored(ref.kind, ref.sourceId, stored, now());
            return 'stored';
        } catch (error) {
            if (error instanceof FileGoneError) {
                await store.fileGone(ref.kind, ref.sourceId, now());
                return 'gone';
            }
            await store.fileFailed(ref.kind, ref.sourceId, now());
            this.deps.logger.warn(
                `[archive] File ${ref.kind} ${ref.sourceId} not stored: ${describe(error)}`
            );
            return 'failed';
        }
    }

    /** True when the volume keeps its reserve after this file. */
    private async roomFor(ref: FileRef): Promise<boolean> {
        const free = await this.deps.files.freeBytes();
        if (free - (ref.size ?? 0) >= this.deps.minFreeBytes) {
            this.lowSpaceLogged = false;
            return true;
        }
        if (!this.lowSpaceLogged) {
            this.lowSpaceLogged = true;
            this.deps.logger.warn(
                `[archive] Volume has ${Math.floor(free / 1024 ** 3)} GiB free, under the ${Math.floor(this.deps.minFreeBytes / 1024 ** 3)} GiB reserve. File downloads are paused; messages are still archived.`
            );
        }
        return false;
    }
}
