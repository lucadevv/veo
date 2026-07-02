# VEO · Monorepo

**Plataforma de movilidad segura en Lima, Perú.** _Yo veo. Tú vas seguro._

Backend de microservicios, apps móviles (pasajero + conductor), webs (admin + familiar) e infraestructura, centralizados en un solo repositorio.

> Diferenciador no negociable: **seguridad**. Verificación biométrica del conductor por turno, cámara en vivo todo el viaje, pánico oculto con UI engañosa, compartir el viaje con la familia sin app.

## Estructura

```
veo/
├── apps/
│   ├── passenger/     App pasajero — React Native (iOS + Android)   [standalone]
│   ├── driver/        App conductor — React Native (Android)        [standalone]
│   ├── admin-web/     Dashboard de operaciones — Next.js
│   ├── family-web/    Vista pública de "seguir el viaje" — Next.js
│   └── web-hub/       @veo/web-hub — Next.js
├── services/          14 microservicios (NestJS, hexagonal) + BFFs (public/driver/admin)
├── packages/          Código compartido @veo/* (tipos, auth, rpc, utils, observability…)
├── infra/             Deploy en VPS único (Docker Compose + Cloudflare Tunnel + SSH)
├── dev-stack/         Orquestación local (boot de servicios desde dist + Docker)
├── docs/              STATUS, FOUNDATION, ADRs, runbooks
└── e2e/               Pruebas end-to-end del golden path
```

## Stack

- **Backend:** Node 20 · pnpm 9 · Turborepo · NestJS 10 · Postgres 16 + PostGIS · Redis · Kafka · gRPC + REST interno (HMAC)
- **Mobile:** React Native 0.75 (módulos nativos para pánico, biometría, WebRTC)
- **Web:** Next.js 14
- **Infra:** VPS único · Docker Compose · imágenes en GHCR · deploy por GitHub Actions (SSH) · ingreso por Cloudflare Tunnel · firewall del host default-deny · self-hosted (Postgres/Kafka/MinIO/Redis, **sin AWS managed** — soberanía Ley 29733)

## Workspace

El backend (`services/*`, `packages/*`, `apps/{admin-web,family-web,web-hub}`, `e2e`) es un workspace **pnpm + Turborepo**. Las apps móviles (`apps/passenger`, `apps/driver`) quedan **fuera** del workspace pnpm por ahora: tienen su propio toolchain (Metro/CocoaPods/Gradle) y `pnpm-lock.yaml`.

> ⚠️ **Estado de consolidación:** este repo centraliza el **código fuente** de los 4 repos originales (`veo-platform`, `veo-passenger-app`, `veo-driver-app`, `veo-infra`). La unificación del build (resolver las deps `file:` de las RN apps hacia `packages/` dentro del monorepo, un único `pnpm install` que buildee todo) es un paso posterior pendiente. Ver `../docs/STATUS.md`.

## Por dónde empezar

1. `../docs/STATUS.md` — qué se hizo, dónde quedamos, qué falta.
2. `../docs/FOUNDATION.md` — contrato técnico canónico (convenciones, soberanía, decisiones).
3. `CLAUDE.md` — reglas no negociables.
