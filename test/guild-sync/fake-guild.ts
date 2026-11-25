import type { ReadResult } from '../../src/guild-sync/health';
import type { GuildReader } from '../../src/guild-sync/readers/reader';
import type {
    ChannelSnap,
    GuildSnapshot,
    RoleSnap,
} from '../../src/guild-sync/snapshot';
import type {
    ChannelPatch,
    ChannelSpec,
    EmojiSpec,
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

    private nextPosition(items: readonly { position: number }[]) {
        return items.reduce((max, i) => Math.max(max, i.position), 0) + 1;
    }

    async createRole(_guild: string, spec: RoleSpec): Promise<string> {
        if (this.failCreates.has(spec.name)) throw new Error('create refused');
        const role: RoleSnap = {
            ...spec,
            id: `f-role-${++this.seq}`,
            position: this.nextPosition(this.snapshot.roles),
            managed: false,
        };
        this.patch({ roles: [...this.snapshot.roles, role] });
        this.calls.push(`create role ${spec.name}`);
        return role.id;
    }

    async updateRole(_guild: string, roleId: string, patch: RolePatch) {
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

    async setChannelPositions(
        _guild: string,
        positions: readonly PositionSpec[]
    ) {
        const next = new Map(positions.map((p) => [p.id, p.position]));
        this.patch({
            channels: this.snapshot.channels.map((c) => ({
                ...c,
                position: next.get(c.id) ?? c.position,
            })),
        });
        this.calls.push('channel positions');
    }

    async renameGuild(_guild: string, name: string) {
        this.patch({ name });
        this.calls.push(`rename guild ${name}`);
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
        this.patch({ roles: this.snapshot.roles.filter((r) => r.id !== id) });
        this.calls.push(`delete role ${id}`);
    }

    async deleteChannel(_guild: string, id: string) {
        this.patch({
            channels: this.snapshot.channels.filter((c) => c.id !== id),
        });
        this.calls.push(`delete channel ${id}`);
    }

    async deleteEmoji(_guild: string, id: string) {
        this.patch({ emojis: this.snapshot.emojis.filter((e) => e.id !== id) });
        this.calls.push(`delete emoji ${id}`);
    }

    async deleteSticker(_guild: string, id: string) {
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
