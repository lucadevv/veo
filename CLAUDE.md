# CLAUDE.md · Contexto para futuras sesiones

> Este archivo se carga automáticamente al inicio de cualquier sesión de Claude Code dentro de este repo.
> Mantén este archivo conciso (< 200 líneas) y actualizado.

## Proyecto

**VEO** — Plataforma de movilidad segura en Lima, Perú. Tres productos: passenger app (RN), driver app (RN Android), admin dashboard (Next.js) + family-web (vista pública).

**Estructura multi-repo (4 repos hermanos):**

| Repo | Qué vive ahí |
|---|---|
| `veo-platform` (este) | Backend (14 servicios) + admin-web + family-web + packages compartidos + dev-stack docker-compose |
| `veo-passenger-app` | App pasajero React Native iOS+Android |
| `veo-driver-app` | App conductor React Native Android |
| `veo-infra` | Terraform + K8s + ArgoCD (producción) |

Las apps móviles consumen `@veo/*` packages vía `file:../veo-platform/packages/*` en dev y vía GitHub Packages en CI/prod. Ver `docs/cross-repo-workflow.md`.

**Diferenciador no negociable:** seguridad. Verificación biométrica del conductor en cada turno, cámara en vivo todo el viaje, pánico oculto con UI engañosa, compartir con familia sin app.

Lee `/Users/jaxximize/Desktop/ecritrorio/00_Proyectos/VEO/VEO_Blueprint.pdf` o `VEO_Blueprint.html` para el blueprint maestro (lógica de negocio + arquitectura completa). Ese documento es la fuente de verdad para decisiones estratégicas.

> 🟢 **ANTES DE CODEAR, LEE EN ORDEN:**
> 1. **`docs/STATUS.md`** — qué se hizo, dónde quedamos y qué falta (handoff actualizado; punto de entrada para cualquier agente/Cursor).
> 2. **`docs/FOUNDATION.md`** — contrato técnico canónico (convenciones, anatomía de servicio, §0.7 soberanía, §14 todas las decisiones).
> 3. Este `CLAUDE.md` — reglas no negociables.
>
> **Regla maestra del cliente:** soberanía tecnológica = **control del DATO y el CÓMPUTO sensibles** (seguridad/privacidad Ley 29733): biometría, video en vivo, pánico, audit, PII → **propios/self-hosted, jamás a un tercero**. Los **rieles de transporte externos inevitables** (push FCM/APNs, red de pagos Yape/Plin, SMS de operador, APNs de Apple) **SÍ se usan**, detrás de un puerto propio intercambiable y **sin PII en el payload** (IDs/deep-links, el contenido se resuelve en el cliente). Soberanía es seguridad del dato, NO “cero proveedores”. (ver FOUNDATION §0.7).
> **Estado (2026-05-28):** Ola 0 (fundación, 5 paquetes `@veo/*`) ✅ + `identity-service` ✅ (plantilla de referencia). Resto de Ola 1 y Olas 2–5 pendientes. git aún sin inicializar.

## Stack

- Node 20 + pnpm 9 + Turborepo
- NestJS 10 (backend), Next.js 14 (web), React Native 0.75 (mobile)
- Postgres 16 + PostGIS, Redis 7, Kafka (MSK), ClickHouse, S3
- LiveKit (WebRTC), AWS IoT Core (MQTT)
- EKS multi-AZ, Terraform, ArgoCD

## Reglas no negociables

1. **Compliance Ley 29733 desde el día 1.** Cifrado AES-256 reposo, TLS 1.3 + mTLS interno, audit inmutable en S3 Object Lock, doble auth para acceso a video, derecho al olvido implementado.
2. **Microservicios desacoplados.** Cada servicio tiene su propia base de datos (schema). NO compartir tablas entre servicios. Comunicación por eventos Kafka o gRPC, no por joins cross-servicio.
3. **Idempotencia financiera obligatoria.** Toda mutación de pago lleva `dedup_key`. Outbox pattern para publicar eventos.
4. **Native modules para panic, biometría, WebRTC.** No reinventar — usar FaceTec/Onfido SDK oficiales, `react-native-webrtc` oficial.
5. **JWT corto + refresh largo.** Access 15m, refresh 30d. Firma con jose (no jsonwebtoken).
6. **Observabilidad antes de features.** Cada nuevo endpoint requiere métrica + log estructurado + tracing.
7. **Tests obligatorios para reglas de negocio.** No tests para getters/setters, sí para máquina de estados de trip, dispatch matching, panic fan-out, payment idempotencia.
8. **No `any` en TypeScript.** ESLint lo bloquea. Si necesitas escape, usa `unknown` + narrowing.
9. **Commits con scope obligatorio.** Conventional Commits, scopes definidos en `commitlint.config.cjs`.
10. **Secrets en AWS Secrets Manager o `.env` local — nunca en git.** El `.env.example` es la única referencia commitada.

## Estructura mental

```
apps/        ←  Lo que ven los usuarios (3 frontends)
services/    ←  Lo que NO ven los usuarios (12 backends + 3 BFFs)
packages/    ←  Código compartido (tipos, utils, eslint, prisma)
infra/       ←  Cómo todo corre en AWS (Terraform, K8s, ArgoCD)
docs/        ←  Por qué decidimos lo que decidimos (ADRs, runbooks)
```

## Cuando agregues un nuevo servicio

1. Crea carpeta en `services/<name>-service/` siguiendo plantilla existente
2. Asigna puerto en `.env.example` (rango 3001-3099 para microservicios, 4001-4099 BFFs, 5000+ frontends)
3. Agrega manifest K8s desde `infra/k8s/base/_template-service.yaml`
4. Si publica eventos, schemas en `packages/events/`
5. Si toca PII, documentar en `docs/compliance/ley-29733/`
6. Runbook esqueleto en `docs/runbooks/<name>-service.md`
7. ADR si la decisión es no-trivial (`docs/adr/NNN-<title>.md`)

## Cuando toques pánico, video o KYC

- Pair review obligatorio con security engineer
- Tests E2E con casos adversariales (timeouts, retries, red flaky)
- Verificar audit log dispara correctamente
- Latencia p99 < 3s para pánico — medir con synthetic monitoring por deploy

## Cuándo NO hacer algo

- **No usar Redis Streams para eventos de dominio.** Usar Kafka. Redis Streams para hot indexes y dispatch, sí.
- **No mockear DB en tests críticos** (payments, panic, audit). Usar testcontainers.
- **No agregar dependencias sin revisar Snyk.** El CI lo bloquea pero también verificar manualmente packages de pago, biometría y WebRTC.
- **No deployar a prod un viernes** salvo emergencia. Política humana, no técnica — pero la respetamos.
- **No commitear binarios.** Imágenes, fuentes, mockups van en S3 referenciados. PRs grandes con binarios se rechazan.

## Comandos que más vas a usar

```bash
pnpm infra:up                        # levantar stack Docker local
pnpm --filter @veo/<svc> dev         # un servicio específico
pnpm --filter @veo/<svc> test --watch
pnpm typecheck                        # antes de PR
pnpm format                           # antes de PR
docker compose -f infra/docker/dev/docker-compose.yml logs -f <svc>
```

## Documentos de referencia

- Blueprint maestro: `../VEO_Blueprint.pdf` (19 páginas, capacity + arquitectura + costos)
- Presentación original: `../VEO_Presentacion.pdf`
- Propuesta inicial: `../Propuesta_Movilidad_Segura.pdf`
- Roadmap 30 días: `../Roadmap_30_Dias_Marketrix.pdf`

## Equipo (Fase build)

10.5 FTE durante ~30 semanas:
- 1 Staff Engineer / Tech Lead
- 2 Backend seniors
- 2 Mobile seniors (RN + módulos nativos)
- 1 Frontend (Next.js)
- 1 SRE / DevOps
- 1 QA / Automation
- 0.5 Security / Compliance
- 1 Product Manager
- 1 Designer UX/UI
