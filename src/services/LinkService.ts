import { MessageLinkRepository } from 'src/db/repositories/MessageLinkRepository';
import { ChannelLinkRepository } from '../db/repositories/ChannelLinkRepository';
import { GuildLinkRepository } from '../db/repositories/GuildLinkRepository';

export class LinkService {
    constructor(
        private guildRepo: GuildLinkRepository,
        private channelRepo: ChannelLinkRepository,
        private messageRepo: MessageLinkRepository
    ) {}

    async getGuildLinkForDiscordGuild(discordGuildId: string) {
        return this.guildRepo.findByDiscordGuildId(discordGuildId);
    }

    async getGuildLinkForFluxerGuild(fluxerGuildId: string) {
        return this.guildRepo.findByFluxerGuildId(fluxerGuildId);
    }

    async createGuildLink(discordGuildId: string, fluxerGuildId: string) {
        const existingDiscordLink = await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (existingDiscordLink) {
            throw new Error('Discord guild already linked');
        }

        const existingFluxerLink = await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (existingFluxerLink) {
            throw new Error('Fluxer guild already linked');
        }

        return this.guildRepo.create(discordGuildId, fluxerGuildId);
    }

    async removeGuildLinkFromDiscord(discordGuildId: string) {
        const existingLink = await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!existingLink) {
            throw new Error('Guild not linked');
        }

        await this.guildRepo.deleteById(existingLink.id);
    }

    async removeGuildLinkFromFluxer(fluxerGuildId: string) {
        const existingLink = await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!existingLink) {
            throw new Error('Guild not linked');
        }

        await this.guildRepo.deleteById(existingLink.id);
    }

    async createChannelLink({
        guildLinkId,
        discordChannelId,
        fluxerChannelId,
        discordWebhookId,
        discordWebhookToken,
        fluxerWebhookId,
        fluxerWebhookToken,
    }: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        discordWebhookId: string;
        discordWebhookToken: string;
        fluxerWebhookId: string;
        fluxerWebhookToken: string;
    }) {
        const existingDiscordChannelLink =
            await this.channelRepo.findByDiscordChannelId(discordChannelId);
        if (existingDiscordChannelLink) {
            throw new Error('Discord channel already linked');
        }

        const existingFluxerChannelLink =
            await this.channelRepo.findByFluxerChannelId(fluxerChannelId);
        if (existingFluxerChannelLink) {
            throw new Error('Fluxer channel already linked');
        }

        return this.channelRepo.create({
            guildLinkId,
            discordChannelId,
            fluxerChannelId,
            discordWebhookId,
            discordWebhookToken,
            fluxerWebhookId,
            fluxerWebhookToken,
        });
    }

    async removeChannelLinkForDiscord(discordGuildId: string, linkId: string) {
        const guildLink = await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        const channelLink = await this.channelRepo.findByGuildAndLinkId(guildLink.id, linkId);

        if (!channelLink) {
            throw new Error('Link not found');
        }

        await this.channelRepo.deleteById(channelLink.id);

        return channelLink;
    }

    async removeChannelLinkForFluxer(fluxerGuildId: string, linkId: string) {
        const guildLink = await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        const channelLink = await this.channelRepo.findByGuildAndLinkId(guildLink.id, linkId);

        if (!channelLink) {
            throw new Error('Link not found');
        }

        await this.channelRepo.deleteById(channelLink.id);

        return channelLink;
    }

    async getChannelLinksForDiscordGuild(discordGuildId: string) {
        const guildLink = await this.guildRepo.findByDiscordGuildId(discordGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        return this.channelRepo.findAllByGuild(guildLink.id);
    }

    async getChannelLinksForFluxerGuild(fluxerGuildId: string) {
        const guildLink = await this.guildRepo.findByFluxerGuildId(fluxerGuildId);
        if (!guildLink) {
            throw new Error('Guild not linked');
        }

        return this.channelRepo.findAllByGuild(guildLink.id);
    }

    async getChannelLinkById(id: string) {
        return this.channelRepo.findById(id);
    }

    async getChannelLinkByDiscordChannelId(discordChannelId: string) {
        return this.channelRepo.findByDiscordChannelId(discordChannelId);
    }

    async getChannelLinkByFluxerChannelId(fluxerChannelId: string) {
        return this.channelRepo.findByFluxerChannelId(fluxerChannelId);
    }

    async getMessageLinkByDiscordMessageId(discordMessageId: string) {
        return this.messageRepo.getMessageLinkByDiscordMessageId(discordMessageId);
    }

    async getMessageLinkByFluxerMessageId(fluxerMessageId: string) {
        return this.messageRepo.getMessageLinkByFluxerMessageId(fluxerMessageId);
    }

    async createMessageLink({
        discordMessageId,
        fluxerMessageId,
        guildLinkId,
        channelLinkId,
    }: {
        discordMessageId: string;
        fluxerMessageId: string;
        guildLinkId: string;
        channelLinkId: string;
    }) {
        return this.messageRepo.createMessageLink(
            guildLinkId,
            channelLinkId,
            discordMessageId,
            fluxerMessageId
        );
    }

    async deleteMessageLink(id: string) {
        return this.messageRepo.deleteMessageLink(id);
    }
}
