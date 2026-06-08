# ADR-009 · Estrategia multi-repo (split inicial)

**Estado:** Aceptado · **Fecha:** 2026-05-27 · **Reemplaza:** decisión implícita previa de monorepo único

## Contexto

Empezamos con monorepo único (`veo-platform`) que contenía backend + apps móviles + admin-web + family-web + infra. Después de revisión:

- Apps móviles tienen ciclo de release independiente (App Store / Play Store)
- Apps móviles requieren build pipelines costosos (Xcode, Gradle, fastlane) que ralentizan a devs backend
- Infra es modificada por SRE + Tech Lead con cadencia distinta; mezclar Terraform con TS dificulta auditoría
- Equipo mobile no necesita levantar Postgres+Kafka+LiveKit en local
- Repo combinado supera 1 GB con `node_modules` de RN + Pods + Gradle

## Decisión

Split a **4 repos hermanos**:

```
00_Proyectos/VEO/
├── veo-platform/        Backend (14 svc) + admin-web + family-web + packages + dev-stack
├── veo-passenger-app/   RN iOS + Android
├── veo-driver-app/      RN Android (iOS Fase 3)
└── veo-infra/           Terraform + K8s + ArgoCD
```

## Alternativas consideradas

- **Monorepo único** (estado anterior): velocidad inicial alta pero saturación cuando los 4 productos tienen cadencias distintas
- **Polyrepo total** (18 repos, uno por servicio): overhead excesivo para 10.5 FTE — coordinación de versiones cross-repo se vuelve trabajo de tiempo completo
- **Híbrido 4 repos** (decisión): balance entre cohesión interna (backend monorepo) y aislamiento de productos con ciclos distintos

## Cómo se comunican los repos

### Packages compartidos (tipos, SDK, utils, ui-kit, events)

Viven en `veo-platform/packages/`. Son consumidos por las apps móviles vía dos mecanismos según contexto:

**Desarrollo local** — `file:` reference apuntando al repo hermano clonado en el mismo directorio padre:

```json
"@veo/shared-types": "file:../veo-platform/packages/shared-types"
```

Requiere clonar `veo-platform` y la app móvil en el mismo directorio padre. Documentado en cada README.

**CI / Producción** — packages publicados a GitHub Packages npm registry como `@veo/*` privados:

```json
"@veo/shared-types": "^0.1.0"
```

CI de `veo-platform` publica via `changesets` cuando hay cambios en `packages/`. Apps móviles bumpean dependencia en su propio `package.json` y abren PR.

### API contracts

- OpenAPI specs viven en `veo-platform/schemas/openapi/`
- Apps móviles consumen el SDK auto-generado `@veo/api-client`
- Cambios breaking en API requieren versionado de la app y mantener compat N-2

### Imágenes Docker

- `veo-platform` CI builda imágenes y push a ECR (`veo-platform/<service>:<sha>`)
- `veo-platform` CI actualiza tag en `veo-infra/k8s/overlays/<env>/` vía PR cross-repo (usa GitHub PAT)
- ArgoCD detecta cambio en `veo-infra` y sincroniza al cluster

### Versionado y releases

- Backend: continuous deployment (deploy ~5 veces/día a prod)
- Apps móviles: release cada 2 semanas a stores (independiente del backend)
- Infra: cambios via PR con freeze window (no viernes/finde)

## Consecuencias

+ Velocidad de build mobile aumenta ~3x (no resuelve `node_modules` del backend)
+ Devs backend no requieren Xcode/Android Studio en su máquina
+ Auditoría de infra (KMS, IAM, RBAC) queda en repo aislado y trackeable
+ Permisos GitHub granulares (mobile devs solo en sus repos)
+ Cadencias independientes — un fix de seguridad en backend no espera al ciclo mobile
+ Compatible con outsourcing parcial (un vendor mobile sin acceso al backend)

- Refactor de tipos requiere coordinar PRs cross-repo (1 PR a veo-platform + 2 PRs a apps móviles)
- Devs full-stack clonan 4 repos en lugar de 1
- Versionado de packages compartidos exige disciplina (changesets, semver)
- CI cross-repo (tag update PR) requiere PAT con permisos cuidados

## Migración

Hecha al pasar de monorepo único a split. Ver commit inicial de `veo-passenger-app`, `veo-driver-app`, `veo-infra`.

## Cuándo revisar esta decisión

- Si llegamos a > 30 FTE y empiezan a aparecer islas de equipos: considerar polyrepo total para backend
- Si el overhead de coordinación cross-repo > 1 día/semana del Tech Lead: considerar volver a monorepo parcial
- Cada 6 meses, revisión formal
