# Runbook · Deploy a producción

> Flujo GitOps completo post-Lote I-B (secrets reales + riel de migraciones).
> Honesto sobre lo que aún NO existe — ver "Qué falta" al final.

## Responsable

- Equipo: SRE / Platform
- Política: **no deployar a prod un viernes** salvo emergencia (CLAUDE.md). Cambios a prod = 2 approvals.

## El flujo, de commit a pods

```
PR mergeada a main
  → CI buildea y pushea imagen veo/<svc>:<git-sha> a ECR        [Lote I-A — en construcción]
  → CI actualiza newName/newTag en infra/k8s/overlays/<env>/kustomization.yaml (kustomize edit set image)
  → ArgoCD detecta el cambio en el repo:
      · dev/staging: sync automático (prune + selfHeal)
      · prod: sync MANUAL (automated sin prune/selfHeal; aprobación humana)
  → Fase PreSync: Jobs <svc>-migrate corren `prisma migrate deploy` (si una migración falla, NO se despliega)
  → Fase Sync: ExternalSecrets/ConfigMaps/Deployments se aplican; rollout RollingUpdate (maxUnavailable: 0)
```

Los secrets en runtime: External Secrets Operator (instalado vía `infra/argocd/applications/external-secrets.yaml`)
materializa cada `<svc>-secrets` desde AWS Secrets Manager (`veo/<env>/...`) usando el `SecretStore`
del overlay con IRSA. Nada secreto vive en git.

## Bootstrap de un cluster nuevo (orden importa)

```bash
# 1. Terraform (crea EKS, RDS, secrets en ASM, roles IRSA)
cd infra/terraform/envs/<env> && terraform init && terraform apply

# 2. kubeconfig
aws eks update-kubeconfig --name veo-<env>-eks --region us-east-1

# 3. Instalar ArgoCD + AppProject + operador ESO
kubectl apply -f infra/argocd/projects/veo.yaml
kubectl apply -f infra/argocd/applications/external-secrets.yaml   # ESO via helm chart oficial

# 4. Reemplazar el account ID placeholder (000000000000) en
#    infra/k8s/overlays/<env>/serviceaccounts.yaml con el real (terraform output / aws sts get-caller-identity)
#    y llenar KAFKA_BROKERS en configmaps.yaml con `terraform output` de module.msk. Commit + PR.

# 5. App del entorno
kubectl apply -f infra/argocd/applications/veo-<env>.yaml
```

> **Primer sync**: los Jobs de migración (PreSync) pueden fallar porque el Secret que crea ESO
> aún no existe (se crea en fase Sync). Re-sincronizar una vez: `argocd app sync veo-<env>`.
> De ahí en adelante el orden ya no es problema (los Secrets persisten).

## Deploy normal a prod

```bash
# 1. Verificar que staging está sano con la misma imagen
kubectl -n veo-staging get pods
# 2. Sync manual de prod (revisar el diff primero)
argocd app diff veo-prod
argocd app sync veo-prod
# 3. Observar la fase PreSync (migraciones) y el rollout
kubectl -n veo-prod get jobs -w
kubectl -n veo-prod rollout status deployment/<svc>
```

## Verificación post-deploy

```bash
argocd app get veo-prod                       # Synced + Healthy
kubectl -n veo-prod get externalsecrets       # READY=True en todos
kubectl -n veo-prod get pods                  # sin CrashLoopBackOff
kubectl -n veo-prod logs -l app=<svc> --tail=50 | jq 'select(.level=="error")'
```

## Rollback

```bash
# Opción A (GitOps, preferida): revertir el commit que cambió el tag de imagen y sync
git revert <sha> && git push   # ArgoCD aplica el tag anterior; las migraciones ya aplicadas NO se revierten
# Opción B (emergencia, imperativa — ArgoCD prod no tiene selfHeal, no lo pisa):
kubectl -n veo-prod rollout undo deployment/<svc>
```

**OJO migraciones**: `prisma migrate deploy` no tiene "down". Un rollback de imagen sobre un schema
ya migrado exige que la migración haya sido backwards-compatible (expand/contract). Ver
`docs/runbooks/migraciones-de-db.md`.

## Qué falta (estado honesto)

- **Lote I-A (en paralelo)**: el CI de la raíz hoy NO buildea/pushea imágenes a ECR ni actualiza tags
  (solo lint/typecheck/test/build). Hasta entonces, el paso "CI publica imagen" es manual.
- La mayoría de Dockerfiles no copian `prisma/` al runner (solo payment y dispatch) — los Jobs de
  migración fallarán para el resto hasta que lote I-A lo corrija.
- Placeholders a llenar por entorno: account ID en `serviceaccounts.yaml`, `KAFKA_BROKERS` (MSK) en
  `configmaps.yaml`.
- Secrets que los servicios esperan y Terraform aún no crea (keypair JWT ES256, ProntoPaga, LiveKit,
  SMTP, etc.): listados como GAPs comentados en `infra/k8s/overlays/<env>/external-secrets.yaml`.
