FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/rating-service/package.json ./services/rating-service/
RUN pnpm install --frozen-lockfile --filter @veo/rating-service...
COPY services/rating-service/ ./services/rating-service/
# Regenera el cliente Prisma para el engine del contenedor (linux) y compila.
RUN pnpm --filter @veo/rating-service exec prisma generate
RUN pnpm --filter @veo/rating-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/rating-service/dist ./dist
# El cliente Prisma generado vive en src/generated y tsc no lo emite a dist: se copia aparte.
COPY --from=builder /app/services/rating-service/src/generated ./dist/generated
COPY --from=builder /app/services/rating-service/proto ./proto
COPY --from=builder /app/services/rating-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3010/health || exit 1
USER node
CMD ["node", "dist/main.js"]
