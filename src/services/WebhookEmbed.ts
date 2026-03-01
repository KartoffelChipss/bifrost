import { EmbedBuilder as FluxerEmbedBuilder } from '@fluxerjs/core';
import { Embed as DiscordEmbed, EmbedBuilder as DiscordEmbedBuilder } from 'discord.js';

export interface WebhookEmbedField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface WebhookEmbedFooter {
    text: string;
    iconURL?: string;
}

export interface WebhookEmbedAuthor {
    name: string;
    url?: string;
    iconURL?: string;
}

export interface WebhookEmbedImage {
    url: string;
    height?: number;
    width?: number;
}

export interface WebhookEmbedThumbnail {
    url: string;
    height?: number;
    width?: number;
}

export default class WebhookEmbed {
    private readonly fields: WebhookEmbedField[];
    private readonly footer: WebhookEmbedFooter | null;
    private readonly title: string | null;
    private readonly description: string | null;
    private readonly url: string | null;
    private readonly color: number | null;
    private readonly timestamp: Date | null;
    private readonly author: WebhookEmbedAuthor | null;
    private readonly image: WebhookEmbedImage | null;
    private readonly thumbnail: WebhookEmbedThumbnail | null;

    constructor(options?: {
        fields?: WebhookEmbedField[];
        footer?: WebhookEmbedFooter | null;
        title?: string | null;
        description?: string | null;
        url?: string | null;
        color?: number | null;
        timestamp?: Date | null;
        author?: WebhookEmbedAuthor | null;
        image?: WebhookEmbedImage | null;
        thumbnail?: WebhookEmbedThumbnail | null;
    }) {
        this.fields = options?.fields ?? [];
        this.footer = options?.footer ?? null;
        this.title = options?.title ?? null;
        this.description = options?.description ?? null;
        this.url = options?.url ?? null;
        this.color = options?.color ?? null;
        this.timestamp = options?.timestamp ?? null;
        this.author = options?.author ?? null;
        this.image = options?.image ?? null;
        this.thumbnail = options?.thumbnail ?? null;
    }

    public static fromDiscordEmbed(embed: DiscordEmbed): WebhookEmbed {
        return new WebhookEmbed({
            title: embed.title ?? null,
            description: embed.description ?? null,
            url: embed.url ?? null,
            color: embed.color ?? null,
            timestamp: embed.timestamp ? new Date(embed.timestamp) : null,
            fields:
                embed.fields?.map((f) => ({
                    name: f.name,
                    value: f.value,
                    inline: f.inline,
                })) ?? [],
            footer: embed.footer
                ? {
                      text: embed.footer.text,
                      iconURL: embed.footer.iconURL,
                  }
                : null,
            author: embed.author
                ? {
                      name: embed.author.name,
                      url: embed.author.url,
                      iconURL: embed.author.iconURL,
                  }
                : null,
            image: embed.image
                ? {
                      url: embed.image.url,
                      height: embed.image.height,
                      width: embed.image.width,
                  }
                : null,
            thumbnail: embed.thumbnail
                ? {
                      url: embed.thumbnail.url,
                      height: embed.thumbnail.height,
                      width: embed.thumbnail.width,
                  }
                : null,
        });
    }

    public static fromFluxerEmbed(embed: any): WebhookEmbed {
        return new WebhookEmbed({
            title: embed.title ?? null,
            description: embed.description ?? null,
            url: embed.url ?? null,
            color: embed.color ?? null,
            timestamp: embed.timestamp ? new Date(embed.timestamp) : null,
            fields:
                embed.fields?.map((f: any) => ({
                    name: f.name,
                    value: f.value,
                    inline: f.inline,
                })) ?? [],
            footer: embed.footer
                ? {
                      text: embed.footer.text,
                      iconURL: embed.footer.icon_url,
                  }
                : null,
            author: embed.author
                ? {
                      name: embed.author.name,
                      url: embed.author.url,
                      iconURL: embed.author.icon_url,
                  }
                : null,
            image: embed.image
                ? {
                      url: embed.image.url,
                      height: embed.image.height,
                      width: embed.image.width,
                  }
                : null,
            thumbnail: embed.thumbnail
                ? {
                      url: embed.thumbnail.url,
                      height: embed.thumbnail.height,
                      width: embed.thumbnail.width,
                  }
                : null,
        });
    }

    public toDiscordEmbed(): DiscordEmbedBuilder {
        const builder = new DiscordEmbedBuilder()
            .setTitle(this.title)
            .setDescription(this.description)
            .setURL(this.url)
            .setColor(this.color)
            .setTimestamp(this.timestamp ?? undefined);

        if (this.fields.length) {
            builder.addFields(
                ...this.fields.map((f) => ({
                    name: f.name,
                    value: f.value,
                    inline: f.inline,
                }))
            );
        }

        if (this.footer) {
            builder.setFooter({
                text: this.footer.text,
                iconURL: this.footer.iconURL,
            });
        }

        if (this.author) {
            builder.setAuthor({
                name: this.author.name,
                url: this.author.url,
                iconURL: this.author.iconURL,
            });
        }

        if (this.image) {
            builder.setImage(this.image.url);
        }

        if (this.thumbnail) {
            builder.setThumbnail(this.thumbnail.url);
        }

        return builder;
    }

    public toFluxerEmbed(): FluxerEmbedBuilder {
        const builder = new FluxerEmbedBuilder()
            .setTitle(this.title)
            .setDescription(this.description)
            .setURL(this.url)
            .setColor(this.color)
            .setTimestamp(this.timestamp ? this.timestamp.getTime() : null);

        if (this.fields.length) {
            builder.addFields(
                ...this.fields.map((f) => ({
                    name: f.name,
                    value: f.value,
                    inline: f.inline,
                }))
            );
        }

        if (this.footer) {
            builder.setFooter({
                text: this.footer.text,
                iconURL: this.footer.iconURL,
            });
        }

        if (this.author) {
            builder.setAuthor({
                name: this.author.name,
                url: this.author.url,
                iconURL: this.author.iconURL,
            });
        }

        if (this.image) {
            builder.setImage({
                url: this.image.url,
                width: this.image.width,
                height: this.image.height,
            });
        }

        if (this.thumbnail) {
            builder.setThumbnail({
                url: this.thumbnail.url,
                width: this.thumbnail.width,
                height: this.thumbnail.height,
            });
        }

        return builder;
    }
}
