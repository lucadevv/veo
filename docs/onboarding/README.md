# Onboarding · Nuevo ingreso al equipo VEO

> Lee esto en orden. Si algo no funciona, abre un issue con label `onboarding` para que arreglemos las instrucciones.

## Día 1 · Setup local

1. Crea cuenta en GitHub VEO org (te invita el Tech Lead)
2. Pide acceso a:
   - 1Password vault `VEO Engineering`
   - Slack workspace `#veo-eng`, `#veo-incidents`, `#veo-deploys`
   - AWS SSO (cuenta `veo-dev` para todos; `staging` / `prod` solo SRE y Tech Lead)
   - Sentry, Grafana Cloud, Datadog (si aplica), PagerDuty

3. Clona y arranca:
   ```bash
   git clone git@github.com:veo/veo-platform.git
   cd veo-platform
   nvm use && corepack enable
   pnpm install
   cp .env.example .env
   pnpm infra:up
   pnpm dev
   ```

4. Lee:
   - [`README.md`](../../README.md) raíz
   - [`CLAUDE.md`](../../CLAUDE.md)
   - El [Blueprint maestro](../../../VEO_Blueprint.pdf) completo (1 hora)
   - ADRs vigentes (`docs/adr/`)

## Día 2-5 · Primer PR

Tarea estándar: agregar un endpoint nuevo en el servicio que te tocó. Pair programming con el Tech Lead. Tu primer PR debe:

- [ ] Pasar CI (lint + typecheck + tests + security)
- [ ] Tener test unitario de la lógica de negocio
- [ ] Tener documentación de evento si publica/consume Kafka
- [ ] Estar bajo 300 líneas (sino, partir en varios PRs)
- [ ] Tener mensaje conventional commit con scope correcto

## Cosas que NO sabes pero deberías

- **Ley 29733 es estricta.** Antes de tocar PII o video, lee `docs/compliance/ley-29733/`.
- **Panic flow es sagrado.** Latencia objetivo p99 < 3s ack. Cualquier cambio aquí requiere security review.
- **Cancelar viaje es financiero.** Hay reglas de penalidad. No las cambies sin product.
- **El equipo del cliente NO es técnico.** Cuando hagas algo que afecte el dashboard, agrégale tooltips.

## Onboarding security

- [ ] Generar GPG key y agregarla a GitHub
- [ ] Setup MFA (YubiKey idealmente) para AWS SSO, GitHub, 1Password
- [ ] Firmar acuerdo de confidencialidad (NDA)
- [ ] Curso de privacy training (1h) — material en `docs/compliance/training/`

## Lecturas recomendadas

- "Designing Data-Intensive Applications" — Martin Kleppmann
- "Site Reliability Engineering" — Google
- "Domain-Driven Design Distilled" — Vaughn Vernon
- Posts del blog de Uber Engineering sobre H3 y dispatch
- Posts del blog de Cabify Tech sobre LATAM mobility
