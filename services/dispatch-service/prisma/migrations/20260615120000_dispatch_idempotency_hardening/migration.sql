-- Hardening de IDEMPOTENCIA del dispatch (Findings #4a, #4b, #11).
--
-- 1) dispatch_matches.agreed_price_cents (Finding #11): FUENTE DE VERDAD DURABLE del precio acordado.
--    El reconciliador (reconcileUnemittedMatches) lo lee de acá y NUNCA fabrica un precio desde el
--    board/oferta efímeros de Redis. NULLABLE: solo las filas ACCEPTED lo setean; OFFERED/legacy quedan NULL.
--
-- 2) outbox_events.dedup_key (Finding #4a): idempotencia DEL PRODUCTOR. NULLABLE + UNIQUE → emits sin
--    clave no se afectan; un re-insert de la MISMA clave estable (reconcile/retry tras crash) lo rechaza
--    el constraint (P2002) y el service lo traga como no-op en vez de apilar una segunda fila. Postgres
--    trata múltiples NULL como DISTINTOS, así que el unique nullable no colisiona entre emits sin clave.
--
-- 3) ÍNDICE UNIQUE PARCIAL "a-lo-sumo-UN-ACCEPTED-por-viaje" (Finding #4b): NO es un unique plano sobre
--    trip_id (un viaje tiene muchos matches legítimos: oferta A rechazada → oferta B). Solo restringe que
--    haya UNA fila ACCEPTED por trip_id a la vez. Prisma 5.22 NO puede expresar un índice unique parcial
--    (WHERE ...) en el schema declarativo → se escribe acá como SQL crudo. Defensa-en-profundidad sobre el
--    claim/CAS de acceptOffer (que ya garantiza un solo writer a nivel app).
--
--    ⚠️ PRERREQUISITO EN ENTORNOS CON DATOS EXISTENTES: si ya hay dos (o más) filas ACCEPTED para el MISMO
--    trip_id, la creación de este índice FALLARÁ. Antes de aplicarlo en un entorno con datos, hay que
--    DEDUPLICAR esas filas (conservar la canónica, mover/eliminar el resto). Esto es DEV sin datos de prod
--    garantizados → generamos el índice pero documentamos el prerrequisito. NO APLICAR A PROD sin el dedupe previo.

-- AlterTable
ALTER TABLE "dispatch"."dispatch_matches" ADD COLUMN "agreed_price_cents" INTEGER;

-- AlterTable
ALTER TABLE "dispatch"."outbox_events" ADD COLUMN "dedup_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_key_key" ON "dispatch"."outbox_events"("dedup_key");

-- CreateIndex (PARTIAL UNIQUE — at-most-one ACCEPTED DispatchMatch per trip)
CREATE UNIQUE INDEX "dispatch_matches_trip_id_accepted_key" ON "dispatch"."dispatch_matches"("trip_id") WHERE "outcome" = 'ACCEPTED';
