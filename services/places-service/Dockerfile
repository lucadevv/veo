FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/places-service/package.json ./services/places-service/
RUN pnpm install --frozen-lockfile --filter @veo/places-service...
COPY services/places-service/ ./services/places-service/
RUN pnpm --filter @veo/places-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/places-service/dist ./dist
COPY --from=builder /app/services/places-service/proto ./proto
COPY --from=builder /app/services/places-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3013
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3013/health || exit 1
USER node
CMD ["node", "dist/main.js"]
