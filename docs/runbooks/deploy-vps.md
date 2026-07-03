# Runbook · Deploy a producción (VPS self-hosted)

> **Canónico (2026-06-24).** Producción VEO corre en un **VPS único con Docker Compose**, imágenes desde
> **GHCR**, deploy disparado por **GitHub Actions vía SSH**. Sin AWS/EKS/Terraform/ArgoCD (FOUNDATION §0.7c).
> El runbook AWS (`deploy-a-produccion.md`) quedó como historia.

## Arquitectura del deploy

```
push a main ──► .github/workflows/images.yml
                 ├─ detect : qué servicios cambiaron (matrix dinámica)
                 ├─ image  : build + push a ghcr.io/lucadevv/veo/<svc>:latest
                 └─ deploy : SSH al VPS → pull → migrate → up -d   (dormido tras VPS_DEPLOY_ENABLED)
VPS /opt/veo ──► docker-compose.preview.yml (infra self-hosted + 19 servicios, todo en veo-net)
                 edge: cloudflared (Cloudflare Tunnel) = único ingreso público, termina TLS
```

## 1. Pre-requisitos del VPS (one-time)

1. VPS con Linux + **Docker** y **Docker Compose v2** instalados.
2. **Firewall del host default-deny** (ufw/nftables): NO publicar puertos de app al exterior; el único
   ingreso es Cloudflare Tunnel (saliente). Abrí solo SSH (idealmente restringido).
3. Clonar el repo en **`/opt/veo`**: `git clone <repo> /opt/veo`.

## 2. Secretos y env (one-time, en el VPS, NUNCA en git)

1. **Infra**: copiá `infra/deploy/vps.env.example` → `/opt/veo/.env` y rellená los 4 secretos
   (`CLICKHOUSE_PASSWORD`, `MINIO_ROOT_PASSWORD`, `LIVEKIT_API_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`).
2. **Por servicio**: por cada servicio, copiá `services/<svc>/env/example.env` → `services/<svc>/env/preview.env`
   con valores reales (gitignored). **OJO booking-service**: su `preview.env` DEBE setear `VEO_MAPS_MODE=osrm`
   + `OSRM_BASE_URL` (su superRefine exige routing soberano en prod o no arranca).
3. **Cloudflare Tunnel**: creá el tunnel `veo-preview` (Dashboard Zero Trust o `infra/cloudflare/setup-preview-tunnel.mjs`)
   con ingress a `public-bff:4001` / `driver-bff:4002` / `admin-bff:4003`; poné su token en `CLOUDFLARE_TUNNEL_TOKEN`.

## 3. Bootstrap (one-time)

```bash
cd /opt/veo
bash infra/deploy/bootstrap-vps.sh   # crea veo-net, valida /opt/veo/.env, provisiona buckets MinIO
```

## 4. Activar el deploy automático (one-time, en GitHub)

En el repo → **Settings → Secrets and variables → Actions**:

- **Variables**: `VPS_DEPLOY_ENABLED = true`
- **Secrets**: `VPS_HOST` (IP/host del VPS), `VPS_USER` (usuario SSH), `VPS_SSH_KEY` (clave privada SSH con acceso al VPS)

> Mientras `VPS_DEPLOY_ENABLED` no sea `true`, el job `deploy` queda dormido (CI solo buildea+pushea a GHCR).

## 5. Deploy (continuo)

Un **push a `main`** dispara `images.yml`: buildea solo lo que cambió, pushea a GHCR, y el job `deploy` entra
por SSH y corre en el VPS:

```bash
cd /opt/veo
docker compose -f docker-compose.preview.yml pull
docker compose -f docker-compose.preview.yml up -d postgres redis kafka clickhouse minio
bash infra/deploy/migrate-preview.sh        # migraciones Prisma (idempotente) ANTES de los servicios
docker compose -f docker-compose.preview.yml up -d --remove-orphans
docker image prune -f
```

## 6. Operación

```bash
docker compose -f docker-compose.preview.yml logs -f <svc>     # logs en vivo
docker compose -f docker-compose.preview.yml ps                # estado
```

- **Rollback**: es declarativo sobre el tag de imagen — fijá el tag previo (o `:<sha>` anterior) en el compose/env
  y `up -d` el servicio. No hay `rollout undo`.
- **Deploy manual desde laptop a prod: PROHIBIDO** (sin rastro/revisión). Va siempre por GitHub Actions.

## 7. Resiliencia (en vez de multi-AZ managed)

- **Backups**: dump de Postgres + snapshot de los volúmenes de MinIO/datos, con **restore PROBADO** (un backup
  no restaurado no es backup). Documentá el procedimiento y la última fecha de restore verificado.
- **Observabilidad prod**: Prometheus/Grafana están diferidos en el compose preview (dev-only); si los querés en
  el VPS, agregalos con `mem_limit` (decisión pendiente).
