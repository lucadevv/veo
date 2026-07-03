# CLAUDE.md · VEO Infrastructure

> 🟢 **Estado global y handoff:** lee `../docs/STATUS.md` (qué se hizo, dónde quedamos, qué falta) y
> `../docs/FOUNDATION.md` (contrato + decisiones, §0.7 soberanía). **Regla maestra:** soberanía tecnológica
> = todo lo self-hosteable se self-hostea. ¿Se puede self-hostear? → se self-hostea (Postgres NO RDS · Kafka
> NO MSK · MinIO NO S3 · Redis NO ElastiCache · cifrado app-level/SOPS NO KMS · `.env`/docker-secrets NO
> Secrets Manager · Docker Compose NO EKS). ¿Es físicamente imposible (push Apple/Google, red de pagos, SMS
> de operador)? → riel externo tras un puerto propio. **No hay AWS managed.**

## Repo

Carpeta de **deploy en VPS único + Docker Compose + GitHub Actions (self-hosted)**. Separada del código de
aplicación. Terraform / K8s / ArgoCD **YA NO EXISTEN** — fueron eliminados: el modelo AWS EKS/multi-AZ se
retiró por soberanía. Lo que corre VEO en producción es **un VPS con Docker Compose**, las imágenes salen de
**GHCR** (GitHub Container Registry) y el deploy lo dispara **GitHub Actions por SSH**.

## Reglas no negociables

1. **NUNCA deployar a prod desde la laptop.** El deploy a prod va SOLO por GitHub Actions (`.github/workflows/images.yml`, job `deploy`): CI buildea → push a GHCR → el job entra por SSH al VPS y hace `pull && up -d`. Un `docker compose up` manual desde tu máquina contra el VPS de prod está PROHIBIDO (sin rastro, sin revisión, sin reproducibilidad).
2. **Secretos JAMÁS en git.** Viven en el `.env` del host del VPS (fuera del repo) o cifrados con **SOPS+age** si se versionan. Nunca un SaaS de secretos, nunca en claro en el repo. El `.env.example` es la única referencia commitada.
3. **Backups del VPS + restore PROBADO.** En vez de multi-AZ managed, la resiliencia la da el backup: dumps de Postgres + snapshot de los volúmenes de MinIO/datos, con un **restore efectivamente probado** (un backup no restaurado no es un backup). Documentá el procedimiento y la última fecha de restore verificado.
4. **Firewall del host default-deny.** En vez de NetworkPolicies de k8s, la contención este-oeste la da el firewall del host (ufw/nftables) en modo default-deny: solo se abren los puertos estrictamente necesarios. El ingreso público entra SOLO por **Cloudflare Tunnel** (cloudflared) — los servicios de aplicación NO publican puertos al host; conviven en la red interna de Docker Compose.
5. **Cambios a prod en ventana segura.** No deployar viernes/finde salvo emergencia. Política humana, la respetamos.
6. **Cifrado por dominio a nivel app / SOPS.** En vez de KMS managed, las claves de cifrado (pii, biometric, video, audit) se gestionan a nivel aplicación / con SOPS+age. Rotación documentada.

## Layout (real)

```
infra/
├── cloudflare/                 ← config de Cloudflare Tunnel (cloudflared): único ingreso público
├── deploy/
│   └── migrate-preview.sh      ← corre las migraciones Prisma de los servicios con DB, en orden
└── docker-compose.preview.yml  ← el stack completo (infra + servicios), images de GHCR, env_file, depends_on
```

> `terraform/`, `k8s/` (Kustomize) y `argocd/` **ya no existen** — eliminados al retirar el modelo AWS.

## Comandos críticos

```bash
# Levantar / actualizar el stack (en el VPS)
docker compose -f docker-compose.preview.yml up -d

# Ver logs en vivo de un servicio
docker compose -f docker-compose.preview.yml logs -f <svc>

# Actualizar a la última imagen publicada (lo que hace el job deploy por SSH)
docker compose -f docker-compose.preview.yml pull && \
docker compose -f docker-compose.preview.yml up -d

# Rollback = volver al tag de imagen anterior (fijá el tag previo en el compose / env y re-`up -d`)
# No hay `rollout undo`: el rollback es declarativo sobre el tag de imagen.

# Migraciones Prisma (en orden, los servicios con DB)
bash infra/deploy/migrate-preview.sh
```

## Cómo se relaciona con el código

- El CI (`.github/workflows/images.yml`) **buildea las imágenes** de cada servicio y las **push a GHCR**.
- El job `deploy` del mismo workflow entra **por SSH** al VPS y hace `pull && up -d` con `docker-compose.preview.yml`.
- **No hay ECR, no hay ArgoCD, no hay reconciliación GitOps.** El deploy es imperativo (SSH) disparado por el push a la rama de deploy.

## Cambios prohibidos sin reviewer security

- Cambios al **firewall del host** (reglas ufw/nftables, apertura de puertos).
- Cambios a **secretos** (`.env` del host, SOPS+age, rotación de claves de cifrado por dominio).
- Cambios a la **retención del audit log** (object-lock de MinIO, días de retención WORM).
- **Exposición de puertos**: publicar al host un puerto que antes era solo interno, o abrir algo distinto del Cloudflare Tunnel.

Cualquier PR que toque estos puntos debe etiquetarse `security-review` y bloquearse hasta aprobación de security engineer.

## Documentos

- Blueprint: `../VEO_Blueprint.pdf` (Cap. 10 infra)
- ADRs: `../docs/adr/` (compartidos)
