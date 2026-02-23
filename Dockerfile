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

ENV CONFIG_PATH=/config
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]