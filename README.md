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

## Community

Join out community Fluxer server for support, updates and to share your feedback: https://fluxer.gg/TN8FkpdQ

## Getting Started

### Hosted Bot

> [!NOTE]  
> The hosted instance isn't running 24/7 yet!

1. Invite the Bifröst bot to your Fluxer server using [this link](https://web.fluxer.app/oauth2/authorize?client_id=1475208219145040215&scope=bot&permissions=536939520) and to your Discord server using [this link](https://discord.com/oauth2/authorize?client_id=1475436995697180845&permissions=536939520&integration_type=0&scope=bot).
2. Use the `!b linkguild <discordGuildId>` command in your Fluxer server to link your Discord server. 
   
   You can find your Discord Guild ID by enabling Developer Mode in Discord settings and right-clicking on your server name. (Alternatively you can also use `!b linkguild <fluxerGuildId>` on your Discord server to link your Fluxer server)
3. Use the `!b linkchannel <discordChannelId> ` command in a Fluxer channel to link it to a Discord channel. You can also do this from Discord using `!b linkchannel <fluxerChannelId>` to link a Fluxer channel to the current Discord channel.
   
   You can find your Discord Channel ID by enabling Developer Mode in Discord settings and right-clicking on the channel name.
4. That's it! Your channels are now linked and messages will be synced between them. 🎉

### Self-Hosting with Docker

#### 1. Clone the repository

```bash
git clone https://github.com/Kartoffelchipss/bifrost.git
cd bifrost
```

---

#### 2. Create a Fluxer Bot

1. Open **Fluxer**.
2. Go to **User Settings → Applications**.
3. Click **Create Application**.
4. Copy the **Bot Token** and **Application ID**, you’ll need it for the `.env` file.

---

#### 3. Create a Discord Bot

1. Go to the **Discord Developer Portal**:  
   https://discord.com/developers/applications
2. Click **New Application**.
3. Go to **Bot -> Add Bot**.
4. Copy the **Bot Token**.
5. Under **Privileged Gateway Intents**, enable:
   - Message Content Intent
6. Copy the **Bot Token** and **Application ID**, you’ll need it for the `.env` file.

---

#### 4. Create the `.env` file

Create a `.env` file in the project root:

```bash
touch .env
```

Open it and add your credentials:

```env
# Fluxer
FLUXER_BOT_TOKEN="Your Fluxer Bot Token"
FLUXER_APPLICATION_ID="Your Fluxer Application ID"

# Discord
DISCORD_BOT_TOKEN="Your Discord Bot Token"
DISCORD_APPLICATION_ID="Your Discord Application ID"
```

You can also use `.env.example` as a reference for all environment variables.

---

#### 5. Build and Start the Container

```bash
docker compose up -d --build
```

---

#### 6. Invite the Discord and Fluxer Bot

After starting the container, the invite link for both the Discord and Fluxer bot will be printed in the logs. Use these links to invite the bots to your respective servers.

You can view the logs with:

```bash
docker compose logs -f
```

Or find the log files in the `config/logs` directory.

---

### 7. Link Servers and Channels

Follow the same linking steps as the hosted bot to connect your Fluxer and Discord servers.

## License

This project is licensed under the GPL-3.0 License. See the [LICENSE](LICENSE) file for details.
