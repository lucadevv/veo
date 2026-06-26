FROM node:20-alpine AS builder
WORKDIR /app
# openssl: deteccion de plataforma prisma -> engines musl openssl-3.0.x (sin esto baja 1.1.x que no corre en alpine)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/media-service/package.json ./services/media-service/
RUN pnpm install --frozen-lockfile --filter @veo/media-service...
COPY services/media-service/ ./services/media-service/
RUN pnpm --filter @veo/media-service exec prisma generate
# Compila dependencias @veo/* en orden topologico y luego el servicio.
RUN pnpm --filter @veo/media-service... build
# node_modules de produccion autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/media-service deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
# openssl: deteccion de plataforma de prisma CLI (Job de migracion) y @prisma/client en runtime.
# ffmpeg + ttf-dejavu: quemado (burn-in) de watermark en video server-side (FfmpegWatermarkAdapter).
# El ffmpeg de alpine ya trae libfreetype -> drawtext funciona. ttf-dejavu instala la fuente en
# /usr/share/fonts/dejavu/DejaVuSans.ttf (= default de WATERMARK_FONT_PATH). Solo en RUNTIME, no en build.
RUN apk add --no-cache openssl ffmpeg ttf-dejavu
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
# El contrato gRPC se resuelve en runtime como ../proto/media.proto (relativo a dist/).
COPY --from=builder /prod/app/proto ./proto
COPY --from=builder /prod/app/prisma ./prisma
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 3007
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3007/health || exit 1
USER node
CMD ["node", "dist/main.js"]
