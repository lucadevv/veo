# Cumplimiento · Ley 29733 (Protección de Datos Personales · Perú)

> Esta carpeta documenta cómo VEO cumple con la Ley 29733 y su reglamento. Es referencia obligatoria para cualquier feature que toque PII, biometría, video o ubicación.

## Principios aplicados

| Principio                | Cómo lo implementamos                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Consentimiento**       | Pantallas dedicadas al onboarding, no enterradas en T&C. Granular por propósito (KYC, video, geo).               |
| **Finalidad**            | Datos usados solo para el propósito declarado. NO marketing, NO entrenamiento de modelos sin consent específico. |
| **Proporcionalidad**     | Mínimo necesario (video 22 min/trip, no audio fuera del trip, GPS solo durante viaje).                           |
| **Calidad**              | Validación de datos en ingreso. Mecanismo de corrección.                                                         |
| **Seguridad**            | TLS 1.3, cifrado at-rest con clave self-hosted (SOPS+age, NO AWS KMS — §0.7c): **AES-256-GCM app-level** (pii/biometric) + **MinIO SSE-S3 server-side** (video, envelope transparente). mTLS interno, RBAC, MFA, audit inmutable. |
| **Confidencialidad**     | Doble auth para acceso a video. Watermark dinámico. Audit log inmutable.                                         |
| **Derechos del titular** | Rectificación, cancelación, oposición — endpoints en código. **Acceso (data-export): planificado, aún NO implementado** (ver §Acceso).                                    |

## Datos personales que tratamos

| Categoría              | Tipo                             | Retención              | Cifrado                               |
| ---------------------- | -------------------------------- | ---------------------- | ------------------------------------- |
| Identidad básica       | nombre, phone, email             | Vida cuenta + 30d      | AES-256-GCM app-level, dominio `pii`              |
| Documento de identidad | DNI (hash)                       | Vida cuenta            | AES-256-GCM app-level, dominio `pii`              |
| Datos biométricos      | foto facial + score liveness     | Vida cuenta            | AES-256-GCM app-level, dominio `biometric` (clave separada) |
| Ubicación              | GPS pings histórico              | 90 días (configurable) | ClickHouse cifrado                               |
| Video del viaje        | grabación interior               | 30/90/180 días         | **MinIO SSE-S3 server-side (envelope)**, clave maestra self-hosted vía SOPS+age, dominio `video` — NO AWS |
| Comunicaciones         | chat anónimo conductor↔pasajero  | 90 días                | AES-256-GCM app-level, dominio `pii`             |
| Pagos                  | últimos 4 dígitos, transacciones | 5 años (regulatorio)   | AES-256-GCM app-level, dominio `pii`             |

## Derechos del titular

### Acceso

Endpoint **planificado** (aún NO implementado en código): `GET /api/me/data-export` — retornará un ZIP con todo lo que tenemos. Latencia objetivo < 7 días (regulatorio). Pendiente de build (Fase 2). El resto de derechos (rectificación, cancelación, oposición) sí están en código.

### Rectificación

Endpoint: `PATCH /api/me` — usuario puede editar email, phone, foto. DNI requiere proceso manual con verificación.

### Cancelación (derecho al olvido)

Endpoint: `DELETE /api/me` — soft delete + 30 días grace period → tombstone + lifecycle de **MinIO self-hosted** borra blobs (NO S3 — §0.7(c)).
**Excepciones documentadas:**

- Video que es evidencia de `panic_event` se retiene hasta resolución legal
- Datos de pagos retenidos 5 años por obligación tributaria

### Oposición

Endpoint: `POST /api/me/preferences` — opt-out de marketing, analytics, sharing con terceros.

## DPO (Data Protection Officer)

**Responsabilidad del cliente.** VEO opera como controller; el cliente (operadora de la flota) designa DPO formalmente y notifica a ANPD.

## Brecha de seguridad

1. Detección automática via alerting self-hosted (Sentry + reglas sobre logs/audit en el VPS — NO AWS GuardDuty, §0.7(c))
2. Notificación al DPO en < 4h
3. Evaluación de impacto y datos afectados
4. **Notificación a ANPD en < 48h** si aplica (mandatory por reglamento)
5. Notificación a titulares afectados
6. Post-mortem público (anonimizado)

## Auditoría

- Pen-test externo pre-launch + anual
- Auditoría interna de privacy cada 6 meses
- Reporte mensual de accesos a video disponible para DPO

## Documentos relacionados

- [`./consents.md`](./consents.md) — Textos legales de consentimiento (TODO)
- [`./privacy-policy.md`](./privacy-policy.md) — Política de privacidad pública (TODO)
- [`./data-retention.md`](./data-retention.md) — Políticas de retención por categoría (TODO)
- [`./breach-response.md`](./breach-response.md) — Plan de respuesta a brecha (TODO)
- [`./vendor-dpa.md`](./vendor-dpa.md) — Data Processing Agreements con los **rieles externos inevitables** (push FCM/APNs, SMS de operador, red de pagos Yape/Plin). Biometría, video, audit y cómputo sensible son **self-hosted** — sin FaceTec, sin AWS (§0.7(c)). (TODO)
