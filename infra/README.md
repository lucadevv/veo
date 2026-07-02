# VEO Infrastructure

Deploy de VEO en **VPS único + Docker Compose + GitHub Actions (self-hosted por SSH)**. Vive en `infra/` del monorepo único `lucadevv/veo`. Aunque comparte repo con el código de aplicación, mantiene su propia gobernanza:

- **Cadencia distinta**: cambios de infra son semanales/mensuales vs deploys de app diarios
- **Reviewers distintos**: cambios al firewall del host, secretos, retención de audit o exposición de puertos requieren label `security-review` (SRE + security engineer)
- **Compliance**: soberanía tecnológica (Ley 29733) — todo lo self-hosteable se self-hostea

> **Regla maestra (soberanía):** ¿se puede self-hostear? → se self-hostea (Postgres NO RDS · Kafka NO MSK · MinIO NO S3 · Redis NO ElastiCache · cifrado app-level/SOPS NO KMS · `.env`/docker-secrets NO Secrets Manager · Docker Compose NO EKS). ¿Es físicamente imposible (push Apple/Google, red de pagos, SMS de operador)? → riel externo tras un puerto propio. **No hay AWS managed.** Terraform / K8s / ArgoCD / EKS / ECR **YA NO EXISTEN** — se eliminaron al retirar el modelo AWS.

## Ubicación en el monorepo

`infra/` contiene el compose de deploy + el ingreso (Cloudflare Tunnel) + el script de migraciones. El backend está en `services/`, las apps en `apps/`, los packages compartidos en `packages/`.

## Layout (real)

```
infra/
├── cloudflare/                 ← config de Cloudflare Tunnel (cloudflared): único ingreso público
├── deploy/
│   └── migrate-preview.sh      ← corre las migraciones Prisma de los servicios con DB, en orden
└── docker-compose.preview.yml  ← el stack completo (infra + servicios), images de GHCR, env_file, depends_on
```

## Prerequisitos

- Docker + Docker Compose (en el VPS)
- Acceso SSH al VPS (lo usa el job `deploy` de GitHub Actions)
- `sops` + `age` si se versionan secretos cifrados

## Cómo se deploya (GHCR + SSH, sin GitOps)

El CI (`.github/workflows/images.yml`) buildea las imágenes de cada servicio y las **push a GHCR** (único registro canónico). El job `deploy` del mismo workflow entra **por SSH** al VPS y hace `pull && up -d` con `docker-compose.preview.yml`. **No hay ECR, no hay ArgoCD, no hay reconciliación GitOps** — el deploy es imperativo (SSH) disparado por el push a `main` (dormido hasta `vars.VPS_DEPLOY_ENABLED=true`).

```bash
# Levantar / actualizar el stack (en el VPS)
docker compose -f docker-compose.preview.yml up -d

# Ver logs en vivo de un servicio
docker compose -f docker-compose.preview.yml logs -f <svc>

# Actualizar a la última imagen publicada (lo que hace el job deploy por SSH)
docker compose -f docker-compose.preview.yml pull && \
docker compose -f docker-compose.preview.yml up -d

# Migraciones Prisma (en orden, los servicios con DB)
bash infra/deploy/migrate-preview.sh
```

**Producción NO se aplica desde la laptop.** El deploy a prod va SOLO por GitHub Actions (build → GHCR → SSH → `pull && up -d`). Un `docker compose up` manual desde tu máquina contra el VPS de prod está PROHIBIDO (sin rastro, sin revisión, sin reproducibilidad).

**Rollback** = volver al tag de imagen anterior (fijá el tag previo en el compose/env y re-`up -d`). No hay `rollout undo`: el rollback es declarativo sobre el tag de imagen.

## Convenciones

- **Secretos JAMÁS en git**: viven en el `.env` del host del VPS (fuera del repo) o cifrados con **SOPS+age** si se versionan. Nunca un SaaS de secretos. El `.env.example` es la única referencia commitada.
- **Ingreso público SOLO por Cloudflare Tunnel** (cloudflared). Los servicios de aplicación NO publican puertos al host; conviven en la red interna de Docker Compose.
- **Firewall del host default-deny** (ufw/nftables): solo se abren los puertos estrictamente necesarios.
- **Cifrado por dominio a nivel app / SOPS** (pii, biometric, video, audit): en vez de KMS managed. Rotación documentada.
- **Backups del VPS + restore PROBADO**: dumps de Postgres + snapshot de volúmenes MinIO/datos, con restore efectivamente verificado (un backup no restaurado no es un backup).
- **Cambios a prod en ventana segura**: no deployar viernes/finde salvo emergencia.

## Cambios prohibidos sin `security-review`

- Cambios al **firewall del host** (reglas ufw/nftables, apertura de puertos).
- Cambios a **secretos** (`.env` del host, SOPS+age, rotación de claves de cifrado por dominio).
- Cambios a la **retención del audit log** (object-lock de MinIO, días de retención WORM).
- **Exposición de puertos**: publicar al host un puerto que antes era solo interno, o abrir algo distinto del Cloudflare Tunnel.

## Documentación

- [CLAUDE.md](./CLAUDE.md) — contexto para futuras sesiones AI (el detalle operativo canónico vive ahí)
- [docs/runbooks/](../../docs/runbooks/) — runbooks operativos (TODO)
- Blueprint maestro: `../VEO_Blueprint.pdf` (Cap. 10 infra + observabilidad)
