FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/identity-service/package.json ./services/identity-service/
RUN pnpm install --frozen-lockfile --filter @veo/identity-service...
COPY services/identity-service/ ./services/identity-service/
RUN pnpm --filter @veo/identity-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/identity-service/dist ./dist
# El servidor gRPC carga el .proto en runtime (join(__dirname, '../proto/identity.proto')).
COPY --from=builder /app/services/identity-service/proto ./proto
COPY --from=builder /app/services/identity-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3001/health || exit 1
USER node
CMD ["node", "dist/main.js"]
