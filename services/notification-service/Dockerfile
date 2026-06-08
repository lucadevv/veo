FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/notification-service/package.json ./services/notification-service/
RUN pnpm install --frozen-lockfile --filter @veo/notification-service...
COPY services/notification-service/ ./services/notification-service/
RUN pnpm --filter @veo/notification-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/notification-service/dist ./dist
COPY --from=builder /app/services/notification-service/proto ./proto
COPY --from=builder /app/services/notification-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3008
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3008/api/v1/health || exit 1
USER node
CMD ["node", "dist/main.js"]
