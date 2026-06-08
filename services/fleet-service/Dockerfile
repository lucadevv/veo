FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/fleet-service/package.json ./services/fleet-service/
RUN pnpm install --frozen-lockfile --filter @veo/fleet-service...
COPY services/fleet-service/ ./services/fleet-service/
RUN pnpm --filter @veo/fleet-service exec prisma generate
RUN pnpm --filter @veo/fleet-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/fleet-service/dist ./dist
COPY --from=builder /app/services/fleet-service/proto ./proto
COPY --from=builder /app/services/fleet-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3012
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3012/health || exit 1
USER node
CMD ["node", "dist/main.js"]
