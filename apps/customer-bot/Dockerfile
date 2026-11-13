FROM node:24-bookworm-slim
WORKDIR /app
COPY LICENSE ./
COPY apps/customer-bot/config.mjs apps/customer-bot/gateway-client.mjs apps/customer-bot/handler.mjs apps/customer-bot/receiver.mjs apps/customer-bot/start.mjs ./apps/customer-bot/
COPY apps/telegram-client/telegram-api.mjs ./apps/telegram-client/
COPY apps/telegram-admin/run-safety.mjs apps/telegram-admin/healthcheck.mjs apps/telegram-admin/state-control.mjs ./apps/telegram-admin/
RUN chmod -R a+rX /app && mkdir /state /customer-bridge && chown node:node /state /customer-bridge
USER node
ENTRYPOINT ["node", "/app/apps/customer-bot/start.mjs"]
