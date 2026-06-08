## Resumen

<!-- ¿Qué cambia y por qué? 1-3 oraciones. Si solo necesitas el diff, este PR es muy chico para PR. -->

## Tipo

- [ ] feat — nueva funcionalidad
- [ ] fix — bug fix
- [ ] refactor — sin cambio de comportamiento
- [ ] perf — mejora de performance
- [ ] docs — documentación
- [ ] test — tests
- [ ] chore — infra, build, deps
- [ ] security — cambio relacionado con seguridad

## Scope

`passenger | driver | admin | family | identity | trip | dispatch | tracking | media | payment | panic | notification | audit | rating | share | bff | infra | docs | shared`

## Checklist

- [ ] Tests unitarios pasan localmente (`pnpm test`)
- [ ] Typecheck pasa (`pnpm typecheck`)
- [ ] Lint pasa (`pnpm lint`)
- [ ] Cambios en API documentados en OpenAPI/GraphQL schema
- [ ] Migraciones de DB revisadas (rollback safe)
- [ ] ADR escrito si la decisión arquitectónica es nueva
- [ ] Runbook actualizado si afecta operación
- [ ] Secrets revisados (no hay .env, keys, tokens en el diff)
- [ ] Compliance: si toca PII / video / audit, mencionar reviewer de seguridad

## Cómo probarlo

<!-- Pasos manuales o E2E. Si pasa CI, puede ser "ver CI". -->

## Risk / Rollback

<!-- ¿Qué pasa si esto rompe? ¿Cómo se revierte? -->
