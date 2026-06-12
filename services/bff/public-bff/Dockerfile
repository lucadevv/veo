FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY services/bff/public-bff/package.json ./services/bff/public-bff/
RUN pnpm install --frozen-lockfile --filter @veo/public-bff...
COPY services/bff/public-bff/ ./services/bff/public-bff/
# Compila dependencias @veo/* en orden topologico y luego el servicio.
RUN pnpm --filter @veo/public-bff... build
# node_modules de produccion autocontenido (sin devDeps, workspace packages empaquetados).
RUN pnpm --filter @veo/public-bff deploy --prod /prod/app

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod/app/dist ./dist
COPY --from=builder /prod/app/package.json ./
COPY --from=builder /prod/app/node_modules ./node_modules
EXPOSE 4001
USER node
CMD ["node", "dist/main.js"]
