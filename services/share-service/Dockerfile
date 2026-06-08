FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/share-service/package.json ./services/share-service/
RUN pnpm install --frozen-lockfile --filter @veo/share-service...
COPY services/share-service/ ./services/share-service/
RUN pnpm --filter @veo/share-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/share-service/dist ./dist
COPY --from=builder /app/services/share-service/proto ./proto
COPY --from=builder /app/services/share-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3011
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3011/health || exit 1
USER node
CMD ["node", "dist/main.js"]
