# mTLS interno de VEO — Linkerd (soberano, self-hosted)

Objetivo: cifrado y autenticación mutua (mTLS) **automática** entre todos los
microservicios VEO, sin SaaS de terceros y sin tocar el código de la aplicación.

## Decisión

Se elige **Linkerd** (edge/stable OSS, Apache-2.0) por ser el service mesh más
ligero y porque hace **mTLS automático** entre pods inyectados, con identidades
basadas en el `ServiceAccount` de cada pod y rotación de certificados cada 24h.
La **CA raíz (trust anchor)** se emite con **cert-manager** dentro del cluster
(CA propia), de modo que ningún material criptográfico depende de un proveedor
externo. Alternativa evaluada: cert-manager + Istio (más potente pero mucho más
pesado). Para la escala actual de VEO, Linkerd es suficiente y más sencillo de
operar; el patrón de inyección por anotación permite migrar a Istio sin cambiar
los manifests de los servicios.

## Componentes en este directorio

| Archivo | Qué es | Cuándo se aplica |
|---|---|---|
| `cert-manager-trust-anchor.yaml` | CA raíz + Issuer de identidad de Linkerd vía cert-manager | Una vez por cluster (namespace `linkerd`) |
| `linkerd-inject-patch.yaml` | Patch Kustomize que añade `linkerd.io/inject: enabled` a todos los Deployments del overlay | Se referencia como `patches` en el overlay |

> Estos archivos **no** se incluyen en `k8s/base/kustomization.yaml` por defecto:
> el control-plane de Linkerd y cert-manager se instalan a nivel de cluster
> (no por namespace de aplicación), y la inyección se activa por overlay.

## Instalación (una vez por cluster)

```bash
# 1) cert-manager (OSS, self-hosted)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# 2) Namespace y trust anchor soberano (cert-manager emite la CA)
kubectl create namespace linkerd
kubectl apply -f k8s/base/mesh/cert-manager-trust-anchor.yaml

# 3) Control-plane de Linkerd, consumiendo la CA emitida por cert-manager.
#    (linkerd CLI OSS; las CRDs y el control-plane corren self-hosted)
linkerd install --crds | kubectl apply -f -
linkerd install \
  --identity-external-issuer \
  --set identity.issuer.scheme=kubernetes.io/tls \
  | kubectl apply -f -
linkerd check
```

El flag `--identity-external-issuer` hace que Linkerd use el Secret
`linkerd-identity-issuer` (gestionado y rotado por cert-manager) en vez de
generar su propia CA, manteniendo el control criptográfico en el cluster.

## Habilitar mTLS en un entorno

Añadir el patch de inyección al overlay (mismo mecanismo que `replicas.yaml`):

```yaml
# k8s/overlays/prod/kustomization.yaml
patches:
  - path: replicas.yaml
    target: { kind: Deployment }
  - path: ../../base/mesh/linkerd-inject-patch.yaml   # <-- activar mTLS
    target: { kind: Deployment }
```

Tras el sync de ArgoCD, cada pod arranca con el sidecar `linkerd-proxy` y todo
el tráfico pod-a-pod queda cifrado con mTLS automático. Verificar:

```bash
linkerd viz edges deployment -n veo-prod   # debe mostrar src/dst "√ (mTLS)"
```

## Capa de defensa en profundidad (sin/antes del mesh)

Aunque el mesh aún no esté inyectado, el repositorio mantiene:

- **NetworkPolicies default-deny** (`k8s/base/networkpolicies/default-deny.yaml`)
  + allowlist explícita por flujo. Esto da segmentación L3/L4 incluso sin mTLS.
- Una vez inyectado Linkerd, el mTLS añade autenticación/cifrado L7 sobre esa
  segmentación (defensa en profundidad).

## Pendientes que requieren cluster real

- Instalar cert-manager y el control-plane de Linkerd (pasos arriba); no se
  puede validar sin un cluster.
- Las CRDs de cert-manager (`Issuer`/`Certificate`) y de Linkerd no están en el
  build de Kustomize a propósito (se instalan a nivel cluster), por lo que
  `cert-manager-trust-anchor.yaml` no se valida con `kubectl --dry-run=client`
  hasta que las CRDs existan en el cluster.
