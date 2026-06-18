FROM node:20-alpine AS builder
WORKDIR /app
# openssl: deteccion de plataforma prisma -> engines musl openssl-3.0.x (sin esto baja 1.1.x que no corre en alpine)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/places-service/package.json ./services/places-service/
RUN pnpm install --frozen-lockfile --filter @veo/places-service...
COPY services/places-service/ ./services/places-service/
RUN pnpm --filter @veo/places-service exec prisma generate
# Compila dependencias @veo/* en orden topologico y luego el servicio.
RUN pnpm --filter @veo/places-service... build
# node_modules de produccion autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/places-service deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
# openssl: deteccion de plataforma de prisma CLI (Job de migracion) y @prisma/client en runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
COPY --from=builder /prod/app/proto ./proto
# prisma/ (schema + migrations) en runtime: lo necesita `prisma migrate deploy` del deploy.
COPY --from=builder /prod/app/prisma ./prisma
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 3013
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3013/health || exit 1
USER node
CMD ["node", "dist/main.js"]
