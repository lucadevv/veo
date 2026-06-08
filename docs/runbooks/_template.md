# Runbook · `<service-name>`

> Copia este template a `docs/runbooks/<service-name>.md` y completa.

## Responsable
- Equipo: <team>
- On-call rotation: <link PagerDuty schedule>
- Tech Lead: @persona

## Qué hace este servicio
1-2 párrafos. ¿Cuál es su responsabilidad única?

## SLOs

| SLI | Target | Error budget mensual |
|---|---|---|
| Availability HTTP 5xx | 99.5% | 3.6h |
| p99 latency endpoint X | < 1s | 1% requests |

## Dashboards

- Grafana: <link>
- Sentry: <link>
- Jaeger: <link>

## Alertas

| Alerta | Severidad | Acción |
|---|---|---|
| `<svc>_p99_latency_high` | SEV2 | Ver "Latencia alta" abajo |
| `<svc>_error_rate_high` | SEV1 | Ver "Errores 5xx" abajo |
| `<svc>_pod_crashloop` | SEV1 | Ver "Pod en crashloop" abajo |

## Procedimientos comunes

### Restart limpio
```bash
kubectl -n veo-prod rollout restart deployment/<svc>
kubectl -n veo-prod rollout status deployment/<svc>
```

### Ver logs en vivo
```bash
kubectl -n veo-prod logs -l app=<svc> -f --tail=100
```

### Conectar a Postgres del servicio
```bash
kubectl -n veo-prod exec -it deploy/<svc> -- psql $DATABASE_URL
```

### Latencia alta
1. Verificar p99 por endpoint en Grafana
2. Ver traces lentos en Jaeger filtrando por `service=<svc>`
3. Ver locks en Postgres: `SELECT * FROM pg_stat_activity WHERE state != 'idle';`
4. Ver hit rate Redis: `redis-cli INFO stats`

### Errores 5xx
1. Sentry: agrupar por mensaje y deploy
2. Logs estructurados: `kubectl logs ... | jq 'select(.level == "error")'`
3. Si patrón nuevo post-deploy: rollback con `kubectl rollout undo`

### Pod en crashloop
1. `kubectl describe pod <pod>` — ver Events
2. Logs del container previo: `kubectl logs <pod> --previous`
3. Verificar secrets/config: `kubectl get secret <svc>-secrets -o yaml`

## Dependencias externas

| Dependencia | Tipo | Qué pasa si cae |
|---|---|---|
| Postgres | DB | Servicio degradado → modo solo-lectura |
| Redis | Cache | Latencia +200ms |
| Kafka | Eventos | Eventos bufferizados; fan-out diferido |

## Procedimientos críticos

### Rollback
```bash
kubectl -n veo-prod rollout undo deployment/<svc>
# o a revisión específica:
kubectl -n veo-prod rollout undo deployment/<svc> --to-revision=N
```

### Escalar manualmente
```bash
kubectl -n veo-prod scale deployment/<svc> --replicas=10
# HPA lo va a sobreescribir si está activo — pausar HPA primero:
kubectl -n veo-prod patch hpa <svc>-hpa -p '{"spec":{"minReplicas":10}}'
```

### Drenar nodo (mantenimiento)
```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
```

## Historial de incidentes notables

| Fecha | Resumen | Postmortem |
|---|---|---|
| (vacío) | | |
