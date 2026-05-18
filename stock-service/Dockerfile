FROM node:20-alpine AS builder
WORKDIR /app

# shared-contracts must come first — service tsconfig.json includes it
COPY shared-contracts /app/shared-contracts
RUN cd /app/shared-contracts && npm install --omit=dev || true

COPY stock-service/package.json stock-service/package-lock.json* /app/stock-service/
WORKDIR /app/stock-service
RUN npm ci

COPY stock-service/tsconfig.json /app/stock-service/
COPY stock-service/src /app/stock-service/src
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/shared-contracts /app/shared-contracts
COPY --from=builder /app/stock-service/node_modules /app/stock-service/node_modules
COPY --from=builder /app/stock-service/dist /app/stock-service/dist
COPY --from=builder /app/stock-service/package.json /app/stock-service/package.json

WORKDIR /app/stock-service
# EXPOSE is documentation-only; the service binds SERVER_PORT=${STOCK_SERVICE_PORT}
# (8081 by default), so document 8081 to match the real listen port (CR-01).
EXPOSE 8081
CMD ["node", "dist/stock-service/src/index.js"]
