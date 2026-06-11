-- Lote C1 · Parada mid-trip NEGOCIADA. El pasajero propone agregar una parada DURANTE el viaje
-- (IN_PROGRESS); el server calcula el delta de tarifa + la ruta nueva y crea una PROPUESTA con TTL;
-- el conductor la acepta (se agrega el waypoint al viaje y se estampa la tarifa nueva) o la rechaza;
-- el sweeper expira las que nadie respondió. Server-authoritative: el delta lo computa el server.
-- Ver trip-service/prisma/schema.prisma model TripWaypointProposal + enum WaypointProposalStatus
-- y trips/domain/waypoint-proposal.ts (dominio puro).

-- CreateEnum
CREATE TYPE "trip"."WaypointProposalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "trip"."trip_waypoint_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "delta_fare_cents" INTEGER NOT NULL,
    "new_fare_cents" INTEGER NOT NULL,
    "status" "trip"."WaypointProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "responded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "trip_waypoint_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Sweeper: escanea PROPOSED con expires_at vencido (status + expires_at).
CREATE INDEX "trip_waypoint_proposals_status_expires_at_idx" ON "trip"."trip_waypoint_proposals"("status", "expires_at");

-- CreateIndex
-- respond/get leen las propuestas por viaje.
CREATE INDEX "trip_waypoint_proposals_trip_id_idx" ON "trip"."trip_waypoint_proposals"("trip_id");

-- CreateIndex (índice ÚNICO PARCIAL — Prisma no lo modela, va a mano)
-- "Una sola propuesta ACTIVA por viaje": a nivel DB no pueden coexistir dos PROPOSED para el mismo
-- viaje. Cierra la carrera de dos propose concurrentes (el segundo INSERT viola el único → conflicto).
CREATE UNIQUE INDEX "trip_waypoint_proposals_one_active_per_trip"
    ON "trip"."trip_waypoint_proposals"("trip_id")
    WHERE "status" = 'PROPOSED';

-- AddForeignKey
ALTER TABLE "trip"."trip_waypoint_proposals"
    ADD CONSTRAINT "trip_waypoint_proposals_trip_id_fkey"
    FOREIGN KEY ("trip_id") REFERENCES "trip"."trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
