import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
    AuthorMembers,
    type GuildMembers,
    MAX_ABSENT_AUTHORS,
} from '../../src/guild-sync/authorMembers';
import {
    UpstreamBridge,
    type UpstreamServices,
} from '../../src/guild-sync/upstreamBridge';
import { installFidelity } from '../../src/relay-extras/fidelity';
import { FidelityService } from '../../src/relay-extras/fidelity/service';
import {
    discordMessage,
    FakePorts,
    LINK,
} from '../relay-extras/fidelity-fakes';

afterEach(() => installFidelity(null));

const notFound = () =>
    Object.assign(new Error('Unknown Member'), { status: 404 });

/** A guild's member cache whose fetch runs `fetched` and caches on success. */
function guild(
    fetched: (userId: string) => Promise<unknown> = async () => ({})
) {
    const cached = new Set<string>();
    const calls: string[] = [];
    const members: GuildMembers = {
        guildId: 'g1',
        isCached: (userId) => cached.has(userId),
        fetch: async (userId) => {
            calls.push(userId);
            const member = await fetched(userId);
            cached.add(userId);
            return member;
        },
    };
    return { members, calls, cached };
}

describe('AuthorMembers', () => {
    it('fetches an uncached author once, then uses the cache', async () => {
        const authors = new AuthorMembers(() => assert.fail('no warning'));
        const { members, calls } = guild();
        await authors.load(members, '101');
        await authors.load(members, '101');
        assert.deepEqual(calls, ['101']);
    });

    it('skips a cached author', async () => {
        const authors = new AuthorMembers(() => assert.fail('no warning'));
        const { members, calls, cached } = guild();
        cached.add('101');
        await authors.load(members, '101');
        assert.deepEqual(calls, []);
    });

    it('asks once about an author who left', async () => {
        const authors = new AuthorMembers(() => assert.fail('no warning'));
        const { members, calls } = guild(async () => {
            throw notFound();
        });
        await authors.load(members, '101');
        await authors.load(members, '101');
        assert.deepEqual(calls, ['101']);
    });

    it('logs any other failure and asks again next time', async () => {
        const warnings: string[] = [];
        const authors = new AuthorMembers((w) => warnings.push(w));
        const { members, calls } = guild(async () => {
            throw new Error('Service Unavailable');
        });
        await authors.load(members, '101');
        await authors.load(members, '101');
        assert.deepEqual(calls, ['101', '101']);
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /Member 101 not loaded.*Service Unavailable/);
    });

    it('does nothing without a guild or author', async () => {
        const authors = new AuthorMembers(() => assert.fail('no warning'));
        const { members, calls } = guild();
        await authors.load({ ...members, guildId: '' }, '101');
        await authors.load(members, '');
        assert.deepEqual(calls, []);
    });

    it('forgets absent authors when the set is full', async () => {
        const authors = new AuthorMembers(() => assert.fail('no warning'));
        const { members, calls } = guild(async () => {
            throw notFound();
        });
        for (let i = 0; i <= MAX_ABSENT_AUTHORS; i++) {
            await authors.load(members, `u${i}`);
        }
        // u0 was dropped when the set filled, so it is asked about again.
        await authors.load(members, 'u0');
        assert.equal(calls.length, MAX_ABSENT_AUTHORS + 2);
    });
});

describe('history payload author', () => {
    /** A message whose member resolves from `cache`, as discord.js does. */
    function uncachedAuthor() {
        const cache = new Map<string, unknown>();
        const nickname = {
            displayName: 'Jake',
            avatarURL: () => null,
        };
        const fetched: string[] = [];
        const message = discordMessage({
            guild: {
                id: LINK.discordGuildId,
                roles: { cache: { get: () => undefined } },
                members: {
                    cache,
                    fetch: async ({ user }: { user: string }) => {
                        fetched.push(user);
                        cache.set(user, nickname);
                        return nickname;
                    },
                },
            },
            author: {
                id: '101',
                username: 'ravenstryker',
                globalName: 'RavenStryker',
                avatarURL: () => 'https://cdn/global.png',
            },
        });
        Object.defineProperty(message, 'member', {
            get: () => cache.get('101') ?? null,
        });
        return { message, fetched };
    }

    const services = {
        linkService: { getGuildLinkById: async () => LINK },
        fluxerEntityResolver: { fetchEmojis: async () => [] },
        commandPrefix: '!',
    } as unknown as UpstreamServices;

    it('uses the server nickname of an author who was not cached', async () => {
        installFidelity(new FidelityService(new FakePorts()));
        const { message, fetched } = uncachedAuthor();
        const payload = await new UpstreamBridge(services).payload(
            message,
            LINK.id
        );
        assert.deepEqual(fetched, ['101']);
        assert.equal(payload.username, 'Jake');
    });
});
