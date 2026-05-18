FROM node:20-alpine AS builder
WORKDIR /app

# shared-contracts must come first — service tsconfig.json includes it
COPY shared-contracts /app/shared-contracts
RUN cd /app/shared-contracts && npm install --omit=dev || true

COPY product-service/package.json product-service/package-lock.json* /app/product-service/
WORKDIR /app/product-service
RUN npm ci

COPY product-service/tsconfig.json /app/product-service/
COPY product-service/src /app/product-service/src
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/shared-contracts /app/shared-contracts
COPY --from=builder /app/product-service/node_modules /app/product-service/node_modules
COPY --from=builder /app/product-service/dist /app/product-service/dist
COPY --from=builder /app/product-service/package.json /app/product-service/package.json

WORKDIR /app/product-service
EXPOSE 8080
CMD ["node", "dist/product-service/src/index.js"]
