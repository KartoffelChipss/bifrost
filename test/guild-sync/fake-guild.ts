import type { ReadResult } from '../../src/guild-sync/health';
import type { GuildReader } from '../../src/guild-sync/readers/reader';
import type {
    ChannelSnap,
    GuildSnapshot,
    RoleSnap,
} from '../../src/guild-sync/snapshot';
import { layoutGroup } from '../../src/guild-sync/order';
import type {
    ChannelMove,
    ChannelPatch,
    ChannelSpec,
    EmojiSpec,
    GuildPatch,
    GuildWriter,
    OverwriteSpec,
    PositionSpec,
    RolePatch,
    RoleSpec,
    StickerPatch,
    StickerSpec,
    ThreadPatch,
    ThreadSpec,
} from '../../src/guild-sync/writers/writer';

const toSnaps = (overwrites: readonly OverwriteSpec[]) =>
    overwrites.map((o) => ({ ...o }));

/**
 * An in-memory destination server. It is both the reader and the writer, so
 * a second cycle reads what the first one wrote.
 */
export class FakeGuild implements GuildReader, GuildWriter {
    /** One line per write, in order. */
    readonly calls: string[] = [];
    /** Object names whose create fails while they are in this set. */
    readonly failCreates = new Set<string>();
    /** Object IDs whose updates fail while they are in this set. */
    readonly failUpdates = new Set<string>();
    /** What each created thread or post was given. */
    readonly posts: ThreadSpec[] = [];
    private seq = 0;

    constructor(public snapshot: GuildSnapshot) {}

    async read(): Promise<ReadResult> {
        return { ok: true, snapshot: this.snapshot };
    }

    async isGone() {
        return false;
    }

    private patch(next: Partial<GuildSnapshot>) {
        this.snapshot = { ...this.snapshot, ...next };
    }

    /** Throws a 404 like both platforms when the object is not there. */
    private mustHave(items: readonly { id: string }[], id: string) {
        if (!items.some((item) => item.id === id)) {
            throw Object.assign(new Error('Unknown'), { statusCode: 404 });
        }
    }

    private nextPosition(items: readonly { position: number }[]) {
        return items.reduce((max, i) => Math.max(max, i.position), 0) + 1;
    }

    async createRole(_guild: string, spec: RoleSpec): Promise<string> {
        if (this.failCreates.has(spec.name)) throw new Error('create refused');
        // Like Fluxer, the create call sets neither hoist nor mentionable.
        const role: RoleSnap = {
            ...spec,
            hoist: false,
            mentionable: false,
            id: `f-role-${++this.seq}`,
            position: this.nextPosition(this.snapshot.roles),
            managed: false,
        };
        this.patch({ roles: [...this.snapshot.roles, role] });
        this.calls.push(`create role ${spec.name}`);
        return role.id;
    }

    async updateRole(_guild: string, roleId: string, patch: RolePatch) {
        if (this.failUpdates.has(roleId)) throw new Error('update refused');
        this.patch({
            roles: this.snapshot.roles.map((r) =>
                r.id === roleId ? { ...r, ...patch } : r
            ),
        });
        this.calls.push(`update role ${roleId}`);
    }

    async setRolePositions(_guild: string, positions: readonly PositionSpec[]) {
        const next = new Map(positions.map((p) => [p.id, p.position]));
        this.patch({
            roles: this.snapshot.roles.map((r) => ({
                ...r,
                position: next.get(r.id) ?? r.position,
            })),
        });
        this.calls.push('role positions');
    }

    async createChannel(_guild: string, spec: ChannelSpec): Promise<string> {
        if (this.failCreates.has(spec.name)) throw new Error('create refused');
        const siblings = this.snapshot.channels.filter(
            (c) => c.parentId === spec.parentId
        );
        const { overwrites, ...fields } = spec;
        const channel: ChannelSnap = {
            ...fields,
            id: `f-ch-${++this.seq}`,
            position: this.nextPosition(siblings),
            overwrites: toSnaps(overwrites),
        };
        this.patch({ channels: [...this.snapshot.channels, channel] });
        this.calls.push(`create channel ${spec.name}`);
        return channel.id;
    }

    async updateChannel(_guild: string, id: string, patch: ChannelPatch) {
        const { overwrites, ...fields } = patch;
        this.patch({
            channels: this.snapshot.channels.map((c) =>
                c.id !== id
                    ? c
                    : {
                          ...c,
                          ...fields,
                          overwrites: overwrites
                              ? toSnaps(overwrites)
                              : c.overwrites,
                      }
            ),
        });
        this.calls.push(`update channel ${id}`);
    }

    /** Every channel-positions request, as sent. */
    readonly moves: ChannelMove[][] = [];

    /**
     * Applies moves one by one like Fluxer: each lands right after its
     * preceding sibling, and inside a category a voice channel directly
     * above a text-like one is refused.
     */
    async setChannelPositions(_guild: string, moves: readonly ChannelMove[]) {
        this.moves.push([...moves]);
        for (const move of moves) this.moveChannel(move);
        this.calls.push('channel positions');
    }

    private moveChannel(move: ChannelMove) {
        const target = this.snapshot.channels.find((c) => c.id === move.id);
        if (!target) throw new Error('unknown channel');
        const parent = target.parentId ?? null;
        const group = (c: ChannelSnap) =>
            parent === null ? 0 : layoutGroup(c.type);
        const siblings = this.snapshot.channels
            .filter((c) => (c.parentId ?? null) === parent && c.id !== move.id)
            .sort((a, b) => group(a) - group(b) || a.position - b.position);
        const at =
            move.precedingId === null
                ? 0
                : siblings.findIndex((c) => c.id === move.precedingId) + 1;
        if (at === 0 && move.precedingId !== null) {
            throw new Error('preceding sibling is not a sibling');
        }
        siblings.splice(at, 0, target);
        const prev = siblings[at - 1];
        const next = siblings[at + 1];
        if (
            parent !== null &&
            ((layoutGroup(target.type) === 0 && prev?.type === 2) ||
                (target.type === 2 && next && layoutGroup(next.type) === 0))
        ) {
            throw new Error('VOICE_CHANNELS_CANNOT_BE_ABOVE_TEXT_CHANNELS');
        }
        const position = new Map(siblings.map((c, i) => [c.id, i + 1]));
        this.patch({
            channels: this.snapshot.channels.map((c) => ({
                ...c,
                position: position.get(c.id) ?? c.position,
            })),
        });
    }

    async updateGuild(_guild: string, patch: GuildPatch) {
        const { name, ...settings } = patch;
        if (name !== undefined) this.patch({ name });
        if (Object.keys(settings).length > 0 && this.snapshot.settings) {
            this.patch({
                settings: { ...this.snapshot.settings, ...settings },
            });
        }
        this.calls.push(
            name !== undefined ? `rename guild ${name}` : 'update guild'
        );
    }

    /** Kept for tests that edit the destination by hand. */
    renameGuild(guildId: string, name: string) {
        return this.updateGuild(guildId, { name });
    }

    async createEmoji(_guild: string, spec: EmojiSpec): Promise<string> {
        if (this.failCreates.has(spec.name)) throw new Error('create refused');
        const id = `f-emoji-${++this.seq}`;
        const animated = spec.image.startsWith('data:image/gif');
        this.patch({
            emojis: [
                ...this.snapshot.emojis,
                { id, name: spec.name, animated },
            ],
        });
        this.calls.push(`create emoji ${spec.name}`);
        return id;
    }

    async renameEmoji(_guild: string, id: string, name: string) {
        this.patch({
            emojis: this.snapshot.emojis.map((e) =>
                e.id === id ? { ...e, name } : e
            ),
        });
        this.calls.push(`rename emoji ${name}`);
    }

    async createSticker(_guild: string, spec: StickerSpec): Promise<string> {
        const id = `f-sticker-${++this.seq}`;
        const sticker = {
            id,
            name: spec.name,
            description: spec.description,
            tags: spec.tags.join(','),
        };
        this.patch({ stickers: [...this.snapshot.stickers, sticker] });
        this.calls.push(`create sticker ${spec.name}`);
        return id;
    }

    async updateSticker(_guild: string, id: string, patch: StickerPatch) {
        this.patch({
            stickers: this.snapshot.stickers.map((s) =>
                s.id === id ? { ...s, ...patch } : s
            ),
        });
        this.calls.push(`update sticker ${id}`);
    }

    async deleteRole(_guild: string, id: string) {
        this.mustHave(this.snapshot.roles, id);
        this.patch({ roles: this.snapshot.roles.filter((r) => r.id !== id) });
        this.calls.push(`delete role ${id}`);
    }

    async deleteChannel(_guild: string, id: string) {
        this.mustHave(this.snapshot.channels, id);
        this.patch({
            channels: this.snapshot.channels.filter((c) => c.id !== id),
        });
        this.calls.push(`delete channel ${id}`);
    }

    async deleteEmoji(_guild: string, id: string) {
        this.mustHave(this.snapshot.emojis, id);
        this.patch({ emojis: this.snapshot.emojis.filter((e) => e.id !== id) });
        this.calls.push(`delete emoji ${id}`);
    }

    async deleteSticker(_guild: string, id: string) {
        this.mustHave(this.snapshot.stickers, id);
        this.patch({
            stickers: this.snapshot.stickers.filter((s) => s.id !== id),
        });
        this.calls.push(`delete sticker ${id}`);
    }

    async createThread(_guild: string, spec: ThreadSpec): Promise<string> {
        if (spec.parentType === 15 && (!spec.starter || !spec.webhook)) {
            throw new Error('a forum post needs its first message');
        }
        const id = `f-thread-${++this.seq}`;
        this.posts.push(spec);
        this.patch({
            threads: [
                ...this.snapshot.threads,
                {
                    id,
                    parentId: spec.parentId,
                    name: spec.name,
                    archived: false,
                    locked: false,
                    tags: [...spec.tags].sort(),
                },
            ],
        });
        this.calls.push(`create thread ${spec.name}`);
        return id;
    }

    async updateThread(_guild: string, id: string, patch: ThreadPatch) {
        if (this.failUpdates.has(id)) throw new Error('update refused');
        const { tags, ...fields } = patch;
        this.patch({
            threads: this.snapshot.threads.map((t) =>
                t.id !== id
                    ? t
                    : {
                          ...t,
                          ...fields,
                          tags: tags ? [...tags].sort() : t.tags,
                      }
            ),
        });
        this.calls.push(`update thread ${id}`);
    }

    async deleteThread(_guild: string, id: string) {
        this.patch({
            threads: this.snapshot.threads.filter((t) => t.id !== id),
        });
        this.calls.push(`delete thread ${id}`);
    }
}
