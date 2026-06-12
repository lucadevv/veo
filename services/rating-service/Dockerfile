FROM node:20-alpine AS builder
WORKDIR /app
# openssl: deteccion de plataforma prisma -> engines musl openssl-3.0.x (sin esto baja 1.1.x que no corre en alpine)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/rating-service/package.json ./services/rating-service/
RUN pnpm install --frozen-lockfile --filter @veo/rating-service...
COPY services/rating-service/ ./services/rating-service/
# Regenera el cliente Prisma para el engine del contenedor (linux) y compila.
RUN pnpm --filter @veo/rating-service exec prisma generate
# Compila dependencias @veo/* en orden topologico y luego el servicio.
RUN pnpm --filter @veo/rating-service... build
# node_modules de produccion autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/rating-service deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
# openssl: deteccion de plataforma de prisma CLI (Job de migracion) y @prisma/client en runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
# El cliente Prisma generado vive en src/generated y tsc no lo emite a dist: se copia aparte.
COPY --from=builder /prod/app/src/generated ./dist/generated
COPY --from=builder /prod/app/proto ./proto
COPY --from=builder /prod/app/prisma ./prisma
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3010/health || exit 1
USER node
CMD ["node", "dist/main.js"]
