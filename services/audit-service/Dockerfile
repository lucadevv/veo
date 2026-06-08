FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/audit-service/package.json ./services/audit-service/
RUN pnpm install --frozen-lockfile --filter @veo/audit-service...
COPY services/audit-service/ ./services/audit-service/
RUN pnpm --filter @veo/audit-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/audit-service/dist ./dist
COPY --from=builder /app/services/audit-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3009
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3009/health || exit 1
USER node
CMD ["node", "dist/main.js"]
