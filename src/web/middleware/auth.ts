import { Request, Response, NextFunction } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { PermissionFlags as FluxerPermissionFlags } from '@fluxerjs/util';
import { guildPermissions as discordGuildPermissions } from '../oauth/discordOAuth';
import { guildPermissions as fluxerGuildPermissions } from '../oauth/fluxerOAuth';
import { DISCORD_OWNER_ID, FLUXER_OWNER_ID } from '../../utils/env';

export const DiscordManageGuild = PermissionFlagsBits.ManageGuild;
export const DiscordManageWebhooks = PermissionFlagsBits.ManageWebhooks;
export const FluxerManageGuild = FluxerPermissionFlags.ManageGuild;
export const FluxerManageWebhooks = FluxerPermissionFlags.ManageWebhooks;

export function requireDiscord(
    req: Request,
    res: Response,
    next: NextFunction
) {
    if (!req.session.discord) {
        res.status(401).json({ error: 'Not logged in with Discord' });
        return;
    }
    next();
}

export function requireFluxer(req: Request, res: Response, next: NextFunction) {
    if (!req.session.fluxer) {
        res.status(401).json({ error: 'Not logged in with Fluxer' });
        return;
    }
    next();
}

export function requireBoth(req: Request, res: Response, next: NextFunction) {
    if (!req.session.discord || !req.session.fluxer) {
        res.status(401).json({
            error: 'Must be logged in with both Discord and Fluxer',
        });
        return;
    }
    next();
}

export function isOwner(req: Request): boolean {
    const discordMatch =
        !!DISCORD_OWNER_ID && req.session.discord?.id === DISCORD_OWNER_ID;
    const fluxerMatch =
        !!FLUXER_OWNER_ID && req.session.fluxer?.id === FLUXER_OWNER_ID;
    return discordMatch || fluxerMatch;
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
    if (!isOwner(req)) {
        res.status(403).json({ error: 'Bot owner only' });
        return;
    }
    next();
}

export function hasDiscordGuildPermission(
    req: Request,
    guildId: string,
    bit: bigint
): boolean {
    const guild = req.session.discord?.guilds.find((g) => g.id === guildId);
    if (!guild) return false;
    return discordGuildPermissions(guild).has(bit);
}

export function hasFluxerGuildPermission(
    req: Request,
    guildId: string,
    bit: bigint
): boolean {
    const guild = req.session.fluxer?.guilds.find((g) => g.id === guildId);
    if (!guild) return false;
    return fluxerGuildPermissions(guild).has(bit);
}
