# The website, built for one network. Railway passes the service's variables in as these build arguments.
# Everything here ends up in public JavaScript: never put a secret in a VITE_ variable.
FROM node:24-bookworm-slim AS build
ARG VITE_PRIVY_APP_ID
ARG VITE_RELAYER_URL
ARG VITE_MINTENT_CONTRACT
ARG VITE_TESTNET_URL
ARG VITE_MAINNET_URL
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@mintent/web..."
RUN test -n "$VITE_RELAYER_URL" || (echo "VITE_RELAYER_URL must be set" && exit 1)
RUN pnpm --filter @mintent/web build

FROM node:24-bookworm-slim
WORKDIR /site
COPY --from=build /app/apps/web/dist ./dist
COPY deploy/serve.mjs ./serve.mjs
CMD ["node", "serve.mjs"]
