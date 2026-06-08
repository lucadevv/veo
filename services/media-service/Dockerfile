FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/media-service/package.json ./services/media-service/
RUN pnpm install --frozen-lockfile --filter @veo/media-service...
COPY services/media-service/ ./services/media-service/
RUN pnpm --filter @veo/media-service exec prisma generate
RUN pnpm --filter @veo/media-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/media-service/dist ./dist
# El contrato gRPC se resuelve en runtime como ../proto/media.proto (relativo a dist/).
COPY --from=builder /app/services/media-service/proto ./proto
COPY --from=builder /app/services/media-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3007
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3007/health || exit 1
USER node
CMD ["node", "dist/main.js"]
