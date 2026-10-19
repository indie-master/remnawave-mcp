FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json LICENSE ./
COPY --from=build /build/dist/client.js ./dist/client.js
COPY --from=build /build/node_modules ./node_modules
COPY apps/telegram-admin/admin-users.mjs ./apps/telegram-admin/
COPY apps/business/config.mjs ./apps/business/
COPY apps/business/store.mjs apps/business/portal.mjs apps/business/portal.html apps/business/faq.json apps/business/start.mjs ./apps/business/
COPY apps/business/account-cli.mjs ./apps/business/
COPY apps/business/reference-search.mjs ./apps/business/
COPY apps/business/media-client.mjs ./apps/business/
COPY apps/business/guides.mjs ./apps/business/
RUN chmod -R a+rX /app && mkdir /state /business-bridge /media-bridge && chown node:node /state /business-bridge /media-bridge
USER node
ENTRYPOINT ["node", "/app/apps/business/start.mjs"]
