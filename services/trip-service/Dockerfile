FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/trip-service/package.json ./services/trip-service/
RUN pnpm install --frozen-lockfile --filter @veo/trip-service...
COPY services/trip-service/ ./services/trip-service/
RUN pnpm --filter @veo/trip-service exec prisma generate
RUN pnpm --filter @veo/trip-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/trip-service/dist ./dist
COPY --from=builder /app/services/trip-service/proto ./proto
COPY --from=builder /app/services/trip-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3002 50052
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3002/health || exit 1
USER node
CMD ["node", "dist/main.js"]
