# ADR-001 · Monorepo con pnpm + Turborepo

**Estado:** Aceptado · **Fecha:** 2026-05-27

## Contexto
Necesitamos coordinar 4 frontends + 14 servicios + 9 paquetes compartidos sin que cada uno sea un repo separado (overhead de versionado y sync).

## Decisión
Monorepo único `veo-platform/` con **pnpm workspaces** + **Turborepo** para orquestación.

## Alternativas
- **Nx**: más features pero más opinionado y pesado. Talent pool LATAM menor.
- **Multi-repo + Renovate**: alto overhead de sync entre paquetes compartidos.
- **Yarn workspaces + Lerna**: Lerna deprecado de hecho.

## Consecuencias
+ Cambios atómicos cross-package
+ Refactors de tipos compartidos en un solo commit
+ CI cache eficiente con Turborepo
- Repo crece (mitigado con sparse-checkout)
- Permisos finos requieren `CODEOWNERS`
