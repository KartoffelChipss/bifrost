# Getting Started with Bifröst

This guide will help you get started with Bifröst, the bridge between Discord and Fluxer. Follow the instructions below to set up and configure Bifröst for your communities.

::: tip
For a guide to self host Bifröst, check out the [Self Hosting Guide](/guide/self-hosting).
:::

## Installation

To install Bifröst, you can add it to your Discord and Fluxer servers using the following links:

- [Add to Discord](https://discord.com/oauth2/authorize?client_id=1475436995697180845&permissions=536947712&integration_type=0&scope=bot)
- [Add to Fluxer](https://web.fluxer.app/oauth2/authorize?client_id=1475208219145040215&scope=bot&permissions=536947712)

## Configuration

### Linking Your Servers

After adding Bifröst to your servers, you first have to link your Discord and Fluxer server. To do this, use the `!b linkguild <discord_guild_id>` command in any channel on your Fluxer server. You can find your Discord guild ID by enabling Developer Mode in Discord's settings and right-clicking on your server.

Alternatively, you can link it from your Discord server by using the `!b linkguild <fluxer_guild_id>` command.

### Linking Channels

Once your servers are linked, you can link specific channels between the two platforms. Use the `!b linkchannel <discord_channel_id>` command to link the current Fluxer channel to a Discord channel. You can find the Discord channel ID by right-clicking on the channel in Discord and selecting "Copy ID".

Alternatively, you can link it from your Discord server by using the `!b linkchannel <fluxer_channel_id>` command in the desired Discord channel.
