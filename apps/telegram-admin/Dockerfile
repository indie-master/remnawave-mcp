FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json LICENSE ./
COPY --from=build /build/dist/client.js ./dist/client.js
COPY apps/telegram-admin/panel-service.mjs apps/telegram-admin/configured-service.mjs apps/telegram-admin/dashboard.mjs apps/telegram-admin/intent.mjs apps/telegram-admin/server-config.mjs apps/telegram-admin/server-loop.mjs apps/telegram-admin/start-server.mjs apps/telegram-admin/healthcheck.mjs ./apps/telegram-admin/
COPY apps/telegram-client/telegram-api.mjs ./apps/telegram-client/
RUN mkdir /state && chown node:node /state
USER node
ENTRYPOINT ["node", "/app/apps/telegram-admin/start-server.mjs"]
