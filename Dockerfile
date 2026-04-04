FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --unsafe-perm --ignore-scripts=false

COPY . .

RUN pnpm build

RUN mkdir -p /config

ARG GIT_COMMIT
ARG REPO_URL
ARG APP_VERSION

ENV GIT_COMMIT=$GIT_COMMIT
ENV REPO_URL=$REPO_URL
ENV APP_VERSION=$APP_VERSION
ENV CONFIG_PATH=/config
ENV NODE_ENV=production

# Build-time metadata — pass via: docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) ...
ARG GIT_COMMIT
ARG REPO_URL
ENV GIT_COMMIT=$GIT_COMMIT
ENV REPO_URL=$REPO_URL

CMD ["node", "dist/index.js"]