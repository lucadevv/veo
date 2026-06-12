# Runbook · Migraciones de base de datos

> Riel automático de migraciones Prisma (Lote I-B) + procedimiento manual de emergencia.

## Responsable
- Equipo: Backend + SRE
- Regla: migraciones destructivas (DROP, rename) requieren patrón expand/contract y review explícita.

## Cómo funciona el riel automático

Manifest: `infra/k8s/base/migrations/prisma-migrate-jobs.yaml`.

- Un `Job` por servicio con Prisma + manifest k8s (12): identity, trip, dispatch, media, payment,
  panic, notification, audit, rating, share, fleet, chat.
- Hook `argocd.argoproj.io/hook: PreSync`: ArgoCD lo corre **antes** de aplicar los workloads.
  Si la migración falla → el sync falla → **no se despliega** la imagen nueva.
- `hook-delete-policy: BeforeHookCreation`: el Job del sync anterior queda visible para debug
  hasta el próximo sync.
- Usa **la misma imagen del servicio** (`ecr/<svc>` — el transformer `images:` del overlay le pone
  el mismo tag que al Deployment) y ejecuta `npx prisma migrate deploy --schema=prisma/schema.prisma`.
- `DATABASE_URL` sale del Secret `<svc>-secrets` que materializa External Secrets desde
  AWS Secrets Manager (`veo/<env>/rds/<svc|shared>`). **No existe** convención
  `MIGRATION_DATABASE_URL` en el repo (verificado): las migraciones usan la misma `DATABASE_URL`
  (mismo usuario master de RDS).
- `prisma migrate deploy` es idempotente: re-sync sin migraciones nuevas = no-op.

### Ver el estado

```bash
kubectl -n veo-<env> get jobs -l tier=backend
kubectl -n veo-<env> logs job/<svc>-migrate
argocd app get veo-<env>   # un PreSync fallido deja el sync en estado Failed
```

### Si el Job de migración falla

1. Logs del Job (`kubectl logs job/<svc>-migrate`). Causas típicas:
   - Secret `<svc>-secrets` sin crear (primer sync del entorno) → verificar
     `kubectl get externalsecret <svc>-secrets` y re-sync.
   - Imagen sin `prisma/` (ver GAP abajo).
   - Migración inválida contra datos reales → corregir con una migración nueva, NUNCA editando una aplicada.
2. El deploy quedó bloqueado (los pods siguen con la versión anterior) — eso es lo esperado.
3. Arreglar, pushear, re-sync.

## Caso manual de emergencia

Cuando hay que migrar fuera del riel (hotfix de schema, riel caído):

```bash
# 1. Pod efímero con la MISMA imagen desplegada y el mismo Secret que usa el riel
kubectl -n veo-<env> run <svc>-migrate-manual --rm -it --restart=Never \
  --labels=tier=backend \
  --image=$(kubectl -n veo-<env> get deploy <svc> -o jsonpath='{.spec.template.spec.containers[0].image}') \
  --overrides='{"spec":{"serviceAccountName":"<svc>","containers":[{"name":"migrate","image":"PEGAR_IMAGEN_DEL_PASO_ANTERIOR","command":["npx","prisma","migrate","deploy","--schema=prisma/schema.prisma"],"envFrom":[{"secretRef":{"name":"<svc>-secrets"}}]}]}}'

# 2. Verificar estado de migraciones (mismo pod, comando `npx prisma migrate status`)
```

> El pod manual necesita el label `tier: backend` si las NetworkPolicies están activas
> (egress a RDS 5432 lo permite `allow-datastores-egress`). Agregarlo con `--labels=tier=backend`.

**Rollback de schema**: Prisma no tiene down-migrations. El procedimiento es siempre
*roll forward* (nueva migración que revierte el cambio) + patrón expand/contract para que la
imagen anterior siga funcionando durante el rollback de app.

## GAPs conocidos (honesto)

- **Dockerfiles sin `prisma/` en el runner**: solo `payment-service` y `dispatch-service` copian
  `prisma/` (schema + migrations) a la imagen final. Para el resto, `prisma migrate deploy`
  fallará con "schema not found" hasta que sus Dockerfiles copien `prisma/` (Lote I-A).
- **places-service**: tiene `prisma/migrations` pero NO tiene manifest en `k8s/base` ni rol IRSA
  en terraform → sin riel hasta que se incorpore.
- **chat-service**: tiene riel, pero terraform no lo lista en `shared_db_services` ni en
  `service_accounts` (sin rol IRSA); su ExternalSecret apunta a `rds/shared` por convención.
- **biometric/tracking**: stubs sin Prisma — sin Job de migración (correcto hoy).
- Primer sync de un entorno nuevo: el PreSync puede correr antes de que ESO cree los Secrets →
  re-sincronizar una vez (ver `deploy-a-produccion.md`).
