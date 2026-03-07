# Self-Hosting Bifröst

This guide will walk you through the steps to self-host Bifröst, the bridge between Discord and Fluxer. By following this guide, you can run Bifröst on your own server using Docker for full control over your deployment.

## 1. Create a Project Directory

```bash
mkdir bifrost
cd bifrost
```

## 2. Create a Fluxer Bot

1. Open **Fluxer**.
2. Go to **User Settings → Applications**.
3. Click **Create Application**.
4. Copy the **Bot Token** and **Application ID**, you’ll need it for the `.env` file.

## 3. Create a Discord Bot

1. Go to the **Discord Developer Portal**:  
   https://discord.com/developers/applications
2. Click **New Application**.
3. Go to **Bot -> Add Bot**.
4. Copy the **Bot Token**.
5. Under **Privileged Gateway Intents**, enable:
    - Message Content Intent
6. Copy the **Bot Token** and **Application ID**, you’ll need it for the `.env` file.

## 4. Create the `.env` file

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

## 5. Create the docker-compose.yml

Create a `docker-compose.yml` file:

```yml
services:
    bifrost:
        image: kartoffelchipss/bifrost:latest
        container_name: bifrost
        restart: unless-stopped
        env_file:
            - .env
        volumes:
            - ./config:/config
```

Alternative: Download the compose file from GitHub

Instead of creating the file manually, you can download the official compose file from the repository:

```bash
curl -O https://raw.githubusercontent.com/KartoffelChipss/bifrost/main/docker-compose.yml
```

Alternative: All-in-one setup with PostgreSQL

If you want a complete setup with PostgreSQL included, you can use the all-in-one compose file:

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/Kartoffelchipss/bifrost/main/docker-compose-aio.yml
```

This version automatically starts:

- Bifröst
- PostgreSQL database

## 6. Start the Container

Run:

```bash
docker compose up -d
```

Docker will automatically pull the latest Bifröst image from Docker Hub and start the container.

You can view the logs with:

```bash
docker compose logs -f
```

Or find the log files in the `config/logs` directory.

## 7. Invite the Discord and Fluxer Bot

After the container starts, the invite links for both the Discord and Fluxer bots will be printed in the logs.

Use these links to invite the bots to your servers.
