<p align="center">
  <img height="100px" width="100px" src="./.github/readme-assets/logo_readme.svg" alt="logo">
  <h1 align="center"><b>Bifröst - A Fluxer Discord Bridge</b></h3>

  <p align="center" >Bifröst is a Discord and Fluxer Bot that allows you bridge your Discord and Fluxer server</p>
</p>

## Features

- Link channels between Discord and Fluxer
- Sync messages between linked channels
- Support for messgages, attachements, stickers and polls
- Easy setup using our hosted bot or self-hosting with Docker
- Customizable bot prefix and settings

## Getting Started

### Hosted Bot

1. Invite the Bifröst bot to your Discord server using [this link](https://web.fluxer.app/oauth2/authorize?client_id=1475208219145040215&scope=bot&permissions=536939520).
2. Use the `!b linkguild <discordGuildId>` command in your Fluxer server to link your Discord server. 
   
   You can find your Discord Guild ID by enabling Developer Mode in Discord settings and right-clicking on your server name. (Alternatively you can also use `!b linkguild <fluxerGuildId>` on your Discord server to link your Fluxer server)
3. Use the `!b linkchannel <discordChannelId> ` command in a Fluxer channel to link it to a Discord channel. You can also do this from Discord using `!b linkchannel <fluxerChannelId>` to link a Fluxer channel to the current Discord channel.
   
   You can find your Discord Channel ID by enabling Developer Mode in Discord settings and right-clicking on the channel name.
4. That's it! Your channels are now linked and messages will be synced between them. 🎉

### Self-Hosting with Docker

1. Clone the repository: `git clone https://github.com/Kartoffelchipss/bifrost.git`
2. Navigate to the project directory: `cd bifrost`
3. Crete a Fluxer Bot in your user settings under "Applications".
4. Create a `.env` file in the root directory and add your configuration variables (see `.env.example` for reference).
5. Build and run the Docker container: `docker-compose up -d`
6. Invite the bot to your Discord using the OAuth2 URL logged in the console after starting the container.
7. Follow the same linking steps as the hosted bot to link your servers and channels

## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for details.