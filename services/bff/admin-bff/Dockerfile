FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/bff/admin-bff/package.json ./services/bff/admin-bff/
RUN pnpm install --frozen-lockfile --filter @veo/admin-bff...
COPY services/bff/admin-bff/ ./services/bff/admin-bff/
RUN pnpm --filter @veo/admin-bff build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/bff/admin-bff/dist ./dist
COPY --from=builder /app/services/bff/admin-bff/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 4003
USER node
CMD ["node", "dist/main.js"]
