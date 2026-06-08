FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/dispatch-service/package.json ./services/dispatch-service/
RUN pnpm install --frozen-lockfile --filter @veo/dispatch-service...
COPY services/dispatch-service/ ./services/dispatch-service/
RUN pnpm --filter @veo/dispatch-service exec prisma generate
RUN pnpm --filter @veo/dispatch-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/dispatch-service/dist ./dist
# El servidor gRPC carga el .proto en runtime (join(__dirname, '../proto/...')).
COPY --from=builder /app/services/dispatch-service/proto ./proto
COPY --from=builder /app/services/dispatch-service/prisma ./prisma
COPY --from=builder /app/services/dispatch-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3003/health || exit 1
USER node
CMD ["node", "dist/main.js"]
