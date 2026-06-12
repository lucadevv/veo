FROM node:20-alpine AS builder
WORKDIR /app
# openssl: deteccion de plataforma prisma -> engines musl openssl-3.0.x (sin esto baja 1.1.x que no corre en alpine)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/notification-service/package.json ./services/notification-service/
RUN pnpm install --frozen-lockfile --filter @veo/notification-service...
COPY services/notification-service/ ./services/notification-service/
RUN pnpm --filter @veo/notification-service exec prisma generate
# Compila dependencias @veo/* en orden topológico y luego el servicio.
RUN pnpm --filter @veo/notification-service... build
# node_modules de producción autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/notification-service deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
# openssl: deteccion de plataforma de prisma CLI (Job de migracion) y @prisma/client en runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
COPY --from=builder /prod/app/prisma ./prisma
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 3008
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3008/health || exit 1
USER node
CMD ["node", "dist/main.js"]
