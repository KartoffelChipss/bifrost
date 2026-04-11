# Self-Hosting Bifröst from Source

This guide will walk you through the steps to self-host Bifröst by cloning the repository and running it directly with Node.js.

## Prerequisites

- **Git** installed on your system. You can download it from [git-scm.com](https://git-scm.com/).
- **Node.js** (v20 or higher recommended) installed on your system. You can download it from [nodejs.org](https://nodejs.org/).
- **pnpm** installed globally. You can install it by running:
    ```bash
    npm install -g pnpm
    ```
- Basic knowledge of using the terminal.

## 1. Clone the Repository

```bash
git clone https://github.com/KartoffelChipss/bifrost.git
cd bifrost
```

## 2. Create a Fluxer Bot

1. Open **Fluxer**.
2. Go to **User Settings → Applications**.
3. Click **Create Application**.
4. Copy the **Bot Token** and **Application ID** — you'll need them for the `.env` file.

## 3. Create a Discord Bot

1. Go to the **Discord Developer Portal**:  
   https://discord.com/developers/applications
2. Click **New Application**.
3. Go to **Bot → Add Bot**.
4. Copy the **Bot Token**.
5. Under **Privileged Gateway Intents**, enable:
    - Message Content Intent
6. Copy the **Bot Token** and **Application ID** — you'll need them for the `.env` file.

## 4. Create the `.env` File

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Open the `.env` file in your preferred text editor and add your credentials:

```env
# Fluxer
BF_FLUXER_TOKEN="Your Fluxer Bot Token"
BF_FLUXER_APP_ID="Your Fluxer Application ID"

# Discord
BF_DISCORD_TOKEN="Your Discord Bot Token"
BF_DISCORD_APP_ID="Your Discord Application ID"
```

See [.env.example](https://github.com/KartoffelChipss/bifrost/blob/main/.env.example) for all available environment variables.

## 5. Install Dependencies

```bash
pnpm install
```

## 6. Start Bifröst

```bash
pnpm start
```

You should see the bot starting up in your terminal. The invite links for both the Discord and Fluxer bots will be printed in the logs.

## 7. Invite the Discord and Fluxer Bot

Use the invite links from the logs to invite the bots to your servers.
