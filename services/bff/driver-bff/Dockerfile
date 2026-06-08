FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/bff/driver-bff/package.json ./services/bff/driver-bff/
RUN pnpm install --frozen-lockfile --filter @veo/driver-bff...
COPY services/bff/driver-bff/ ./services/bff/driver-bff/
RUN pnpm --filter @veo/driver-bff build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/bff/driver-bff/dist ./dist
COPY --from=builder /app/services/bff/driver-bff/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 4002
USER node
CMD ["node", "dist/main.js"]
