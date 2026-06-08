# Workflow cross-repo

> Cómo los 4 repos de VEO colaboran. Lectura obligatoria si te toca cambiar tipos compartidos, contratos de API o tags de imágenes Docker.

## Mapa de repos

```
00_Proyectos/VEO/                          ← directorio padre, NO es un repo
├── veo-platform/        ← backend + webs + packages + dev-stack
├── veo-passenger-app/   ← RN pasajero
├── veo-driver-app/      ← RN conductor
└── veo-infra/           ← Terraform + K8s + ArgoCD
```

**Convención:** los 4 repos viven como hermanos bajo un directorio padre. Esto NO es opcional — los `file:` deps lo asumen.

## Setup inicial de un dev nuevo

```bash
mkdir -p ~/veo && cd ~/veo
git clone git@github.com:veo/veo-platform.git
git clone git@github.com:veo/veo-passenger-app.git
git clone git@github.com:veo/veo-driver-app.git
git clone git@github.com:veo/veo-infra.git

cd veo-platform
nvm use && corepack enable
pnpm install
pnpm dev-stack:up
pnpm dev   # arranca todos los servicios backend

# En otra terminal, mobile:
cd ../veo-passenger-app
pnpm install
pnpm ios   # o pnpm android
```

## Flujos de cambio comunes

### A) Cambio que NO afecta otros repos

Ejemplo: agregar endpoint a `trip-service`, fix de UI en `admin-web`.

→ PR único en `veo-platform`. CI corre. Merge. Deploy automático (staging).

### B) Cambio en tipos compartidos (`@veo/shared-types`)

Ejemplo: agregar campo a `Trip`, cambiar enum de `PaymentMethod`.

1. PR en `veo-platform` con el cambio en `packages/shared-types/`
2. CI valida que todos los servicios siguen compilando
3. Merge → CI publica nueva versión patch/minor a GitHub Packages vía `changesets`
4. PRs en `veo-passenger-app` y `veo-driver-app` bumpeando la versión:
   ```json
   "@veo/shared-types": "^0.2.0"  // antes ^0.1.0
   ```
5. Si es breaking change: bump major + apps quedan en versión anterior hasta que adapten

**Durante desarrollo local con `file:` link**, los cambios se ven inmediatamente sin publicar. Pero **antes de PR a mobile**, se debe haber publicado la versión.

### C) Cambio en API (contratos OpenAPI)

Ejemplo: cambio en `POST /trips/request`.

1. PR en `veo-platform` actualizando el handler + OpenAPI spec en `schemas/openapi/`
2. CI regenera `@veo/api-client` desde el spec actualizado
3. CI publica nuevo `@veo/api-client@x.y.z`
4. PRs en apps móviles bumpean el cliente
5. **Regla N-2:** backend mantiene compatibilidad con clientes 2 versiones atrás (las apps en stores pueden tardar en actualizarse)

### D) Deploy de nueva imagen Docker → cluster

1. Merge en `veo-platform` con cambio en un servicio
2. CI builda imagen y push a ECR como `veo-platform/<svc>:<sha>` + `:latest`
3. CI abre PR automático en `veo-infra` actualizando el tag en `k8s/overlays/<env>/`
4. PR de `veo-infra` se mergea (auto en dev/staging, manual en prod)
5. ArgoCD detecta cambio en `veo-infra` y sincroniza al cluster

Esta es la única automatización cross-repo. Usa GitHub Actions con un PAT específico con permiso solo sobre `veo-infra`.

### E) Cambio de infra (Terraform)

1. PR en `veo-infra`
2. CI corre `terraform plan` para dev/staging/prod y comenta en el PR
3. Reviewers: SRE + Tech Lead (mínimo 2 aprobaciones para `prod`)
4. Merge → ApplyState manual (`prod`) o automático (`dev`)

### F) Release a App Store / Play Store

Ciclo independiente:

1. Mobile dev cierra sprint en `veo-passenger-app` con todos los PRs mergeados
2. `git tag v1.x.0` → fastlane lo recoge
3. Fastlane builda + sube a TestFlight / Play Internal
4. QA en stores → promote a producción
5. **Backend no se ve afectado.** Sigue corriendo la versión actual.

## Versionado

| Repo | Esquema | Cuándo bumpear |
|---|---|---|
| `veo-platform/packages/*` | semver via changesets | Cada PR que afecta el paquete |
| `veo-platform/services/*` | semver del servicio (independiente) | En tag de imagen Docker |
| `veo-passenger-app` | semver del binario | Por release a store |
| `veo-driver-app` | semver del binario | Por release a store |
| `veo-infra` | sin versionado, solo commits | git sha es el identificador |

## Reglas anti-fricción

1. **NO duplicar tipos en apps móviles.** Si necesitas un tipo, agrégalo a `@veo/shared-types`.
2. **NO llamar servicios desde apps móviles directamente.** Siempre vía BFF correspondiente.
3. **NO push a `main` sin PR**, ni en repos pequeños como `veo-infra`. Branch protection lo bloquea.
4. **NO modificar `@veo/api-client` a mano.** Es generado desde OpenAPI. Cambia el spec, no el cliente.
5. **Sincronizar versiones de RN entre `veo-passenger-app` y `veo-driver-app`** — usar mismo `react-native@0.75.x`.

## Troubleshooting común

### `Cannot find module @veo/shared-types`
- ¿Está `veo-platform` clonado como hermano?
- ¿Corriste `pnpm install` después de clonar?
- Verifica `package.json` que apunte a `file:../veo-platform/packages/shared-types`

### `Module @veo/api-client not found at runtime`
- En RN, después de cambiar deps locales: `pnpm install && cd ios && pod install`
- Metro bundler cache: `pnpm dev --reset-cache`

### `Terraform plan falla en CI`
- Variables sensibles esperadas en Secrets Manager — no en `.tfvars`
- Workspace correcto: `terraform workspace show` debe coincidir con env

### "Tag de imagen Docker no se actualiza en prod"
- Verifica que el PR auto a `veo-infra` se haya mergeado
- ArgoCD: `kubectl -n argocd get application veo-prod -o yaml`
- Sync manual: `argocd app sync veo-prod`
