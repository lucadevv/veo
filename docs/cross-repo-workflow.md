# Workflow cross-repo — DEPRECADO

> ⚠️ **Este documento ya no aplica.** VEO se consolidó en un **monorepo único**
> (`github.com/lucadevv/veo`). Ya no hay 4 repos hermanos, ni `file:` deps entre
> repos, ni publicación a GitHub Packages para compartir tipos.

## Qué reemplazó a esto

| Antes (4 repos) | Ahora (monorepo) |
|---|---|
| `veo-platform`, `veo-passenger-app`, `veo-driver-app`, `veo-infra` clonados como hermanos | un solo `git clone` → `apps/`, `services/`, `packages/`, `infra/` |
| `@veo/*` consumidos vía `file:../veo-platform/packages/*` | `workspace:*` (pnpm workspace) — Metro resuelve desde `packages/` |
| Cambio en `@veo/shared-types` → publicar a GitHub Packages → bumpear versión en cada app | un solo PR; el cambio en `packages/*` se ve al instante en todo el workspace |
| Deploy vía repo externo `veo-deploy` (nunca existió de verdad) | ArgoCD apunta al propio monorepo (`infra/argocd/`) |

## Dónde está ahora la verdad

- Estructura y build del monorepo: [`README.md`](../README.md) raíz.
- Reglas y convenciones: [`CLAUDE.md`](../CLAUDE.md) raíz.
- Estado/handoff: [`docs/STATUS.md`](./STATUS.md).
- Infra (Terraform + K8s + ArgoCD): [`infra/`](../infra/).
