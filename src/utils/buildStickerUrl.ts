export const buildFluxerStickerUrl = (id: string, animated: boolean, size?: number) => {
    const url = `https://fluxerusercontent.com/stickers/${id}?size=${size || 320}&animated=${animated}`;
    return url;
};

export const buildDiscordStickerUrl = (id: string, size?: number) => {
    return `https://media.discordapp.net/stickers/${id}.webp?size=${size || 320}&quality=lossless`;
};
