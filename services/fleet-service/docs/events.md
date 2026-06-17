# Eventos de `fleet-service`

Topic Kafka = dominio antes del primer punto → **`fleet`**. Key = id de la entidad raíz.
Todos se publican vía **outbox** (FOUNDATION §6): la mutación de dominio y el insert del evento
ocurren en la misma transacción Postgres; el `OutboxRelay` los drena a Kafka.

> ⚠ **Pendiente de registro en `@veo/events`.** Estos `eventType` NO están aún en `EVENT_SCHEMAS`.
> El `KafkaEventProducer` sólo valida payloads de eventos registrados, así que hoy viajan sin
> validación de esquema. Se solicita al orquestador agregarlos al registro (ver payloads abajo).

## Publica

| Topic | eventType                 | Disparado por                                                            | Consumidores previstos                                                  |
| ----- | ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| fleet | `fleet.document.expiring` | Cron `ExpirySweeper` al alcanzar un hito 30/15/7/1 días                  | notification-service (alerta al conductor/operador)                     |
| fleet | `fleet.document.expired`  | Cron / revisión cuando un documento vence                                | notification-service, identity-service                                  |
| fleet | `fleet.driver.suspended`  | Documento crítico (Licencia A1 / SOAT / Tarjeta) EXPIRED de un conductor | identity-service (marca `DriverStatus=SUSPENDED`), notification-service |
| fleet | `fleet.vehicle.suspended` | docStatus del vehículo cae a EXPIRED (SOAT/ITV/seguro vencidos)          | dispatch-service (excluye el vehículo), notification-service            |

### Payloads propuestos

```jsonc
// fleet.document.expiring  (schemaVersion 1)
{
  "documentId": "uuid",
  "ownerType": "DRIVER" | "VEHICLE",
  "ownerId": "uuid",
  "documentType": "LICENSE_A1" | "SOAT" | "PROPERTY_CARD" | "BACKGROUND_CHECK" | "ITV",
  "expiresAt": "ISO-8601",
  "daysRemaining": 30,
  "milestone": 30          // hito alcanzado: 30 | 15 | 7 | 1
}

// fleet.document.expired  (schemaVersion 1)
{
  "documentId": "uuid",
  "ownerType": "DRIVER" | "VEHICLE",
  "ownerId": "uuid",
  "documentType": "LICENSE_A1" | "SOAT" | "PROPERTY_CARD" | "BACKGROUND_CHECK" | "ITV",
  "expiresAt": "ISO-8601",
  "critical": true          // crítico = Licencia A1 / SOAT / Tarjeta de propiedad
}

// fleet.driver.suspended  (schemaVersion 1)
{
  "driverId": "uuid",
  "reason": "Documento crítico vencido (SOAT)",
  "documentId": "uuid",
  "documentType": "SOAT",
  "suspendedAt": "ISO-8601"
}

// fleet.vehicle.suspended  (schemaVersion 1)
{
  "vehicleId": "uuid",
  "reason": "Documentación del vehículo vencida (SOAT/ITV/seguro)",
  "suspendedAt": "ISO-8601"
}
```

### Schemas Zod sugeridos (para `@veo/events/schemas.ts`)

```ts
export const fleetDocumentExpiring = z.object({
  documentId: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  documentType: z.string(),
  expiresAt: z.string(),
  daysRemaining: z.number().int(),
  milestone: z.number().int(),
});
export const fleetDocumentExpired = z.object({
  documentId: z.string(),
  ownerType: z.enum(['DRIVER', 'VEHICLE']),
  ownerId: z.string(),
  documentType: z.string(),
  expiresAt: z.string(),
  critical: z.boolean(),
});
export const fleetDriverSuspended = z.object({
  driverId: z.string(),
  reason: z.string(),
  documentId: z.string(),
  documentType: z.string(),
  suspendedAt: z.string(),
});
export const fleetVehicleSuspended = z.object({
  vehicleId: z.string(),
  reason: z.string(),
  suspendedAt: z.string(),
});

// En EVENT_SCHEMAS:
//   'fleet.document.expiring': fleetDocumentExpiring,
//   'fleet.document.expired':  fleetDocumentExpired,
//   'fleet.driver.suspended':  fleetDriverSuspended,
//   'fleet.vehicle.suspended': fleetVehicleSuspended,
```

## Consume

| Topic    | eventType                                    | Acción                                                        | Reintentos                   |
| -------- | -------------------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| identity | `driver.verified` (opcional, fase posterior) | Pre-crear el checklist de documentos requeridos del conductor | reintenta vía consumer group |

> Hoy `fleet-service` NO consume eventos (el alta de documentos es por API). El consumo de
> `driver.verified` queda documentado como mejora para precargar el checklist de documentos.
