FROM node:20-alpine AS builder
WORKDIR /app

# shared-contracts must come first - service tsconfig.json includes it
COPY shared-contracts /app/shared-contracts
RUN cd /app/shared-contracts && npm install --omit=dev || true

COPY notification-service/package.json notification-service/package-lock.json* /app/notification-service/
WORKDIR /app/notification-service
RUN npm ci

COPY notification-service/tsconfig.json /app/notification-service/
COPY notification-service/src /app/notification-service/src
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/shared-contracts /app/shared-contracts
COPY --from=builder /app/notification-service/node_modules /app/notification-service/node_modules
COPY --from=builder /app/notification-service/dist /app/notification-service/dist
COPY --from=builder /app/notification-service/package.json /app/notification-service/package.json

WORKDIR /app/notification-service
EXPOSE 8082
CMD ["node", "dist/notification-service/src/index.js"]
