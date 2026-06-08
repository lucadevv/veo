FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/chat-service/package.json ./services/chat-service/
RUN pnpm install --frozen-lockfile --filter @veo/chat-service...
COPY services/chat-service/ ./services/chat-service/
RUN pnpm --filter @veo/chat-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/chat-service/dist ./dist
COPY --from=builder /app/services/chat-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3014
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3014/health || exit 1
USER node
CMD ["node", "dist/main.js"]
