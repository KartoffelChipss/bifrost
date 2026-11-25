import type { Side } from './store';

/** Who a user is, for the link confirmation question. */
export interface UserInfo {
    readonly id: string;
    /** The unique account name, with a Fluxer discriminator if it has one. */
    readonly username: string;
    /** The display name, if the user set one. */
    readonly displayName: string | null;
}

/** A member's synced state on one server. */
export interface MemberState {
    readonly roleIds: readonly string[];
    /** The server nickname, or null when the member has none. */
    readonly nick: string | null;
}

/** The platform calls account linking needs. */
export interface IdentityPorts {
    sendDm(side: Side, userId: string, text: string): Promise<void>;
    userInfo(side: Side, userId: string): Promise<UserInfo>;
    /** Null when the user is not a member of the server. */
    discordMember(guildId: string, userId: string): Promise<MemberState | null>;
    fluxerMember(guildId: string, userId: string): Promise<MemberState | null>;
    setFluxerMemberRoles(
        guildId: string,
        userId: string,
        roleIds: string[]
    ): Promise<void>;
    /** Sets the Fluxer server nickname; null clears it. */
    setFluxerMemberNick(
        guildId: string,
        userId: string,
        nick: string | null
    ): Promise<void>;
}
