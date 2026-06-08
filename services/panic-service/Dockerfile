FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/panic-service/package.json ./services/panic-service/
RUN pnpm install --frozen-lockfile --filter @veo/panic-service...
COPY services/panic-service/ ./services/panic-service/
RUN pnpm --filter @veo/panic-service exec prisma generate
RUN pnpm --filter @veo/panic-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/panic-service/dist ./dist
# El gRPC server carga el .proto en runtime (join(__dirname, '../proto/panic.proto')).
COPY --from=builder /app/services/panic-service/proto ./proto
COPY --from=builder /app/services/panic-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3006 50056
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3006/health || exit 1
USER node
CMD ["node", "dist/main.js"]
