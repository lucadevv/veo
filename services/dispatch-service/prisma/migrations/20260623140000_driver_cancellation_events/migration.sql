-- VENTANA ROLLING de cancelaciones del conductor (auto-suspensión por exceso · decisión del dueño ·
-- compliance/seguridad). Tabla SEPARADA del contador LIFELONG `driver_stats.cancelled_trips` (ese alimenta
-- la TASA de cancelación del scoring BR-T06 y NUNCA se poda): acá cada cancelación POR conductor es UNA fila
-- con su `occurred_at`, y dispatch cuenta solo las de las últimas 24h (poda las viejas). Cuando el conteo de
-- la ventana CRUZA el umbral (4→5) dispatch emite `driver.excessive_cancellations` (UNA vez por cruce).
--
-- IDEMPOTENCIA del at-least-once de Kafka: UNIQUE(driver_id, trip_id) → una RE-ENTREGA del mismo
-- `trip.cancelled` (mismo tripId) es un upsert no-op, NO duplica la fila NI re-cuenta.

-- CreateTable
CREATE TABLE "dispatch"."driver_cancellation_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "driver_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_cancellation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_cancellation_events_driver_id_trip_id_key"
    ON "dispatch"."driver_cancellation_events"("driver_id", "trip_id");

-- CreateIndex
CREATE INDEX "driver_cancellation_events_driver_id_occurred_at_idx"
    ON "dispatch"."driver_cancellation_events"("driver_id", "occurred_at");
