/**
 * Fork: attachments for a Fluxer webhook copy.
 *
 * `@fluxerjs/core` downloads each `url` file with a 30 s limit and uploads
 * the message within its 15 s request limit, so a large video fails the
 * whole copy. Fluxer also refuses any file over its bot limit
 * (ATTACHMENT_MAX_SIZE_BOT, 50 MiB, in packages/constants LimitConstants),
 * which Discord files often exceed. This module downloads files with a
 * longer limit and leaves out files too large for Fluxer, or no longer
 * served by Discord (a deleted sticker, an expired file), listing them in
 * the text instead, so the rest of the message still arrives.
 */

/** Fluxer's per-file limit for bots (LimitConstants.ts). */
export const FLUXER_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Time allowed to download one file from Discord. */
export const FILE_DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * Fluxer's filename limit, counted in UTF-16 code units (FilenameType in
 * fluxer packages/schema/src/primitives/FileValidators.ts). A longer name
 * fails the whole send with FILENAME_LENGTH_INVALID; Discord files can
 * have longer names.
 */
export const FLUXER_MAX_FILENAME_LENGTH = 255;
/** The ending kept as an extension when a name is shortened. */
const EXTENSION = /\.[^.]{1,16}$/;

/**
 * A filename Fluxer accepts: an empty name becomes "attachment", and one
 * over FLUXER_MAX_FILENAME_LENGTH is cut short, keeping its extension and
 * whole characters.
 */
export function fluxerFilename(name: string): string {
    if (name.length === 0) return 'attachment';
    if (name.length <= FLUXER_MAX_FILENAME_LENGTH) return name;
    const extension = EXTENSION.exec(name)?.[0] ?? '';
    const budget = FLUXER_MAX_FILENAME_LENGTH - extension.length;
    let stem = '';
    // Bounded by the name's length: one step per code point.
    for (const char of name.slice(0, name.length - extension.length)) {
        if (stem.length + char.length > budget) break;
        stem += char;
    }
    const shortened = stem + extension;
    return shortened.length > 0 ? shortened : 'attachment';
}

/** Fluxer's message content limit (MAX_CONTENT_LENGTH in history). */
const MAX_CONTENT_LENGTH = 4_000;

export interface CopyFile {
    readonly url: string;
    readonly name: string;
    /** Bytes, when the source said. */
    readonly size?: number;
}

export interface DownloadedFile {
    readonly name: string;
    readonly filename: string;
    readonly data: ArrayBuffer;
}

export type FetchFile = (
    url: string,
    timeoutMs: number
) => Promise<ArrayBuffer>;

/** A source file the CDN no longer serves (FileGoneError). */
export class FileGoneError extends Error {
    constructor(
        readonly url: string,
        readonly status: number
    ) {
        super(`Failed to fetch file from ${url}: ${status}`);
        this.name = 'FileGoneError';
    }
}

/** Statuses for a file that is gone for good, such as a deleted sticker. */
const GONE_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

/** Downloads a file, or rejects on a bad status or the time limit. */
export const fetchFile: FetchFile = async (url, timeoutMs) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (GONE_STATUSES.has(res.status)) throw new FileGoneError(url, res.status);
    if (!res.ok) {
        throw new Error(`Failed to fetch file from ${url}: ${res.status}`);
    }
    return res.arrayBuffer();
};

const isTooLarge = (bytes: number | undefined) =>
    bytes !== undefined && bytes > FLUXER_MAX_FILE_BYTES;

function megabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line that stands in for a file Discord no longer serves. */
export function goneLine(file: CopyFile): string {
    return `📎 ${file.name} is no longer available on Discord`;
}

/** The line that stands in for a file Fluxer cannot take. */
export function tooLargeLine(file: CopyFile, bytes: number): string {
    return `📎 ${file.name} (${megabytes(bytes)}) is too large to copy to Fluxer: ${file.url}`;
}

/**
 * Downloads the files Fluxer can take. A file over the limit, by its
 * declared or downloaded size, is left out and listed in `lines`.
 */
export async function prepareFiles(
    files: readonly CopyFile[],
    fetcher: FetchFile = fetchFile
): Promise<{ files: DownloadedFile[]; lines: string[]; kept: number[] }> {
    const out: DownloadedFile[] = [];
    const lines: string[] = [];
    const kept: number[] = [];
    for (const [index, file] of files.entries()) {
        if (isTooLarge(file.size)) {
            lines.push(tooLargeLine(file, file.size ?? 0));
            continue;
        }
        const data = await download(file, fetcher);
        if (data === null) {
            lines.push(goneLine(file));
            continue;
        }
        if (isTooLarge(data.byteLength)) {
            lines.push(tooLargeLine(file, data.byteLength));
            continue;
        }
        out.push({ name: file.name, filename: file.name, data });
        kept.push(index);
    }
    return { files: out, lines, kept };
}

/** The file's bytes, or null when Discord no longer serves it. */
async function download(
    file: CopyFile,
    fetcher: FetchFile
): Promise<ArrayBuffer | null> {
    try {
        return await fetcher(file.url, FILE_DOWNLOAD_TIMEOUT_MS);
    } catch (error) {
        if (error instanceof FileGoneError) return null;
        throw error;
    }
}

/** The content with the lines below it, within Fluxer's limit. */
export function withLines(content: string, lines: readonly string[]): string {
    if (lines.length === 0) return content;
    const joined = [content, ...lines].filter((part) => part !== '').join('\n');
    return joined.length <= MAX_CONTENT_LENGTH
        ? joined
        : `${joined.slice(0, MAX_CONTENT_LENGTH - 1)}…`;
}
