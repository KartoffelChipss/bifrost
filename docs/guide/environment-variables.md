# Environment Variables

Bifröst is configured entirely through environment variables, set in a `.env` file (or via Docker's `env_file` / `environment`). This page documents every variable it supports, including a few that aren't listed in [.env.example](https://github.com/KartoffelChipss/bifrost/blob/main/.env.example).

For the initial setup, see the [self-hosting guides](/guide/self-hosting/).

## Required

| Variable            | Description                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `BF_FLUXER_TOKEN`   | Bot token for your Fluxer application. Also accepts `BF_FLUXER_TOKEN_FILE`, see [Secrets from files](#secrets-from-files). |
| `BF_FLUXER_APP_ID`  | Application ID of your Fluxer bot.                                                                          |
| `BF_DISCORD_TOKEN`  | Bot token for your Discord application. Also accepts `BF_DISCORD_TOKEN_FILE`.                               |
| `BF_DISCORD_APP_ID` | Application ID of your Discord bot.                                                                         |

Bifröst exits on startup if `BF_FLUXER_TOKEN` or `BF_DISCORD_TOKEN` is missing.

## General

| Variable                | Default   | Description                                                                                                          |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BF_COMMAND_PREFIX`      | `!b `     | Prefix used for text commands on both Discord and Fluxer.                                                            |
| `BF_CONFIG_PATH`         | `./config`| Directory used for the SQLite database and log files. The Docker image sets this to `/config` automatically, so you normally don't need to set it yourself. |
| `BF_DELETE_INVOCATION`   | `false`   | Deletes the invoking command message after it runs when set to `true`, `1`, or `yes`.                               |
| `BF_DISCORD_OWNER_ID`    | –         | Discord user ID allowed to run owner-only debug commands (e.g. `!b list all`).                                       |
| `BF_FLUXER_OWNER_ID`     | –         | Fluxer user ID allowed to run owner-only debug commands.                                                             |

## Fluxer connection (self-hosted instances)

Only relevant if you're connecting to a self-hosted Fluxer instance instead of the officially hosted one. See [Using a Self-Hosted Fluxer Instance](/guide/self-hosting/custom-fluxer-instance) for a full walkthrough.

| Variable                       | Description                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BF_FLUXER_AUTODISCOVERY_DOMAIN` | Domain of a Fluxer instance that supports discovery (`GET /.well-known/fluxer`). When set, all endpoints below are resolved automatically and any manually-set URL variables are ignored for the connection. |
| `BF_FLUXER_BASE_URL`             | Base URL of your Fluxer instance, e.g. `https://chat.example.com`. Used to derive the URLs below when they aren't set individually, and to build the bot's invite links. |
| `BF_FLUXER_API_URL`              | Overrides the API URL. Defaults to `<BASE_URL>/api`.                                                                                                |
| `BF_FLUXER_MEDIA_URL`            | Overrides the media URL. Defaults to `<BASE_URL>/media`.                                                                                            |
| `BF_FLUXER_STATIC_CDN_URL`       | Overrides the static CDN URL. Defaults to `<BASE_URL>/static`.                                                                                      |
| `BF_FLUXER_INVITE_URL`           | Overrides the invite URL. Defaults to `<BASE_URL>/invite`.                                                                                          |

## Database

| Variable       | Default     | Description                                     |
| -------------- | ----------- | ------------------------------------------------ |
| `BF_DB_DIALECT` | `sqlite`   | `sqlite` or `postgres`.                          |
| `BF_DB_NAME`    | `bifrost`  | Database name. PostgreSQL only.                  |
| `BF_DB_USER`    | `root`     | Database user. PostgreSQL only.                  |
| `BF_DB_PASS`    | *(empty)*  | Database password. PostgreSQL only. Also accepts `BF_DB_PASS_FILE`. |
| `BF_DB_HOST`    | `localhost`| Database host. PostgreSQL only.                  |
| `BF_DB_PORT`    | `5432`     | Database port. PostgreSQL only.                  |

SQLite needs no further configuration. The database file is stored under `BF_CONFIG_PATH`. See the [docker-compose-aio.yml](https://github.com/KartoffelChipss/bifrost/blob/main/docker-compose-aio.yml) for a ready-made PostgreSQL setup.

## Health checks

Bifröst can push periodic up/down status to a push-style uptime monitor (e.g. Uptime Kuma, healthchecks.io). Leave these unset to disable health pushes entirely.

| Variable                     | Description                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `BF_DISCORD_HEALTH_URL`        | Push URL for the Discord bot's health status.                                                                            |
| `BF_DISCORD_HEALTH_TOKEN`      | Token appended to `BF_DISCORD_HEALTH_URL` as the final path segment. Only needed if your push URL doesn't already include the token. Also accepts `BF_DISCORD_HEALTH_TOKEN_FILE`. |
| `BF_FLUXER_HEALTH_URL`         | Push URL for the Fluxer bot's health status.                                                                             |
| `BF_FLUXER_HEALTH_TOKEN`       | Token appended to `BF_FLUXER_HEALTH_URL` as the final path segment. Also accepts `BF_FLUXER_HEALTH_TOKEN_FILE`.          |

## Metrics & queue

| Variable          | Default                  | Description                                                                                          |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `BF_METRICS_PORT`   | `9091`                     | Port for the Prometheus `/metrics` endpoint.                                                          |
| `BF_QUEUE_TTL_MS`   | `300000` (5 minutes)       | How long, in milliseconds, messages wait to be relayed during an outage before being dropped from the queue. |

## Secrets from files

Any of the following variables can be set via a `_FILE` suffix instead, pointing to a file whose contents are read and trimmed at startup. This is convenient for Docker/Kubernetes secrets:

- `BF_FLUXER_TOKEN_FILE`
- `BF_DISCORD_TOKEN_FILE`
- `BF_DB_PASS_FILE`
- `BF_DISCORD_HEALTH_TOKEN_FILE`
- `BF_FLUXER_HEALTH_TOKEN_FILE`

```env
BF_FLUXER_TOKEN_FILE="/run/secrets/fluxer_token"
```

If both a variable and its `_FILE` counterpart are set, the file wins.

## Set automatically by the Docker build

These are set by CI when building the official Docker image. You don't need to set them yourself:

| Variable      | Description                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`      | Set to `production` in the Docker image.                                                        |
| `GIT_COMMIT`    | Commit hash shown in bot status output. Falls back to `git rev-parse HEAD` if unset.            |
| `REPO_URL`      | Repository URL shown in bot status output. Falls back to the `origin` git remote if unset.      |
