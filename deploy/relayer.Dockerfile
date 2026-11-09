# The relayer: order pipeline, card operations and the HTTP API. One image for both networks; NEAR_NETWORK picks.
# Keys come from Railway variables (RELAYER_PRIVATE_KEY, DEMO_FUNDER_PRIVATE_KEY), never from the image.
FROM node:24-bookworm-slim
ENV NODE_ENV=production CI=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@mintent/relayer..."
WORKDIR /app/services/relayer
# Railway sets PORT. RELAYER_DB should point at the mounted volume, e.g. /data/relayer.sqlite.
CMD ["pnpm", "start"]
