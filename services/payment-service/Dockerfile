FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/payment-service/package.json ./services/payment-service/
RUN pnpm install --frozen-lockfile --filter @veo/payment-service...
COPY services/payment-service/ ./services/payment-service/
RUN pnpm --filter @veo/payment-service exec prisma generate
RUN pnpm --filter @veo/payment-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/payment-service/dist ./dist
# El servidor gRPC carga el .proto en runtime (join(__dirname, '../proto/...')).
COPY --from=builder /app/services/payment-service/proto ./proto
COPY --from=builder /app/services/payment-service/prisma ./prisma
COPY --from=builder /app/services/payment-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3005 50055
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3005/health || exit 1
USER node
CMD ["node", "dist/main.js"]
