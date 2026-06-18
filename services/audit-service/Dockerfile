FROM node:20-alpine AS builder
WORKDIR /app
# openssl: deteccion de plataforma prisma -> engines musl openssl-3.0.x (sin esto baja 1.1.x que no corre en alpine)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/audit-service/package.json ./services/audit-service/
RUN pnpm install --frozen-lockfile --filter @veo/audit-service...
COPY services/audit-service/ ./services/audit-service/
RUN pnpm --filter @veo/audit-service exec prisma generate
# Compila dependencias @veo/* en orden topologico y luego el servicio.
RUN pnpm --filter @veo/audit-service... build
# node_modules de produccion autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/audit-service deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
# openssl: deteccion de plataforma de prisma CLI (Job de migracion) y @prisma/client en runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
# El servidor gRPC carga el .proto en runtime (join(__dirname, '../proto/audit.proto')).
COPY --from=builder /prod/app/proto ./proto
COPY --from=builder /prod/app/prisma ./prisma
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 3009
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3009/health || exit 1
USER node
CMD ["node", "dist/main.js"]
