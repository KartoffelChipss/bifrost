# Self-Hosting Bifröst using Docker on Windows

This guide will walk you through the steps to self-host Bifröst using Docker on a Windows system.

## Prerequisites

- Docker Desktop installed on your system. You can download it from the [official Docker Desktop page](https://www.docker.com/products/docker-desktop/). During installation, ensure **WSL 2** is enabled when prompted (recommended) or use the Hyper-V backend.
- Basic knowledge of using the terminal (PowerShell or Command Prompt) and Docker.

## 1. Create a Project Directory

Open PowerShell or Command Prompt and run:

```powershell
mkdir bifrost
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

Create a `.env` file in the project root:

```powershell
New-Item -Name .env -ItemType File
```

Open it in your preferred text editor (e.g., Notepad) and add your credentials:

```env
# Fluxer
BF_FLUXER_TOKEN="Your Fluxer Bot Token"
BF_FLUXER_APP_ID="Your Fluxer Application ID"

# Discord
BF_DISCORD_TOKEN="Your Discord Bot Token"
BF_DISCORD_APP_ID="Your Discord Application ID"
```

You can also use [.env.example](https://github.com/KartoffelChipss/bifrost/blob/main/.env.example) as a reference for all available environment variables.

## 5. Create the `docker-compose.yml`

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

### Alternative: Download the compose file from GitHub

Instead of creating the file manually, you can download the official compose file using PowerShell:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/KartoffelChipss/bifrost/main/docker-compose.yml" -OutFile "docker-compose.yml"
```

### Alternative: All-in-one setup with PostgreSQL

If you want a complete setup with PostgreSQL included, you can download the all-in-one compose file:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/KartoffelChipss/bifrost/main/docker-compose-aio.yml" -OutFile "docker-compose.yml"
```

This version automatically starts:

- Bifröst
- PostgreSQL database

## 6. Start the Container

Make sure Docker Desktop is running, then execute:

```powershell
docker compose up -d
```

Docker will automatically pull the latest Bifröst image from Docker Hub and start the container.

You can view the logs with:

```powershell
docker compose logs -f
```

Or find the log files in the `config\logs` directory.

## 7. Invite the Discord and Fluxer Bot

After the container starts, the invite links for both the Discord and Fluxer bots will be printed in the logs.

Use these links to invite the bots to your servers.
