-- CreateEnum
CREATE TYPE "booking"."PublishedTripState" AS ENUM ('BORRADOR', 'PUBLICADO', 'PARCIALMENTE_RESERVADO', 'LLENO', 'EN_RUTA', 'COMPLETADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "booking"."BookingState" AS ENUM ('SOLICITADO', 'PENDIENTE_APROBACION', 'APROBADO', 'COBRO_PENDIENTE', 'RECHAZADO', 'EXPIRADO', 'CONFIRMADO', 'EN_RUTA', 'COMPLETADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "booking"."PricingMode" AS ENUM ('FIJO');

-- CreateEnum
CREATE TYPE "booking"."ModoReserva" AS ENUM ('INSTANT_BOOKING', 'REVISION_CADA_SOLICITUD');

-- CreateTable
CREATE TABLE "booking"."published_trips" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "origen_lat" DOUBLE PRECISION NOT NULL,
    "origen_lon" DOUBLE PRECISION NOT NULL,
    "origin_h3" TEXT,
    "destino_lat" DOUBLE PRECISION NOT NULL,
    "destino_lon" DOUBLE PRECISION NOT NULL,
    "dest_h3" TEXT,
    "stopovers" JSONB NOT NULL DEFAULT '[]',
    "fecha_hora_salida" TIMESTAMPTZ NOT NULL,
    "asientos_totales" INTEGER NOT NULL,
    "asientos_disponibles" INTEGER NOT NULL,
    "pricing_mode" "booking"."PricingMode" NOT NULL DEFAULT 'FIJO',
    "precio_base" INTEGER NOT NULL,
    "precio_por_tramo" JSONB NOT NULL DEFAULT '[]',
    "modo_reserva" "booking"."ModoReserva" NOT NULL,
    "reglas" TEXT,
    "pais" TEXT NOT NULL DEFAULT 'PE',
    "moneda" TEXT NOT NULL DEFAULT 'PEN',
    "estado" "booking"."PublishedTripState" NOT NULL DEFAULT 'BORRADOR',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "published_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking"."bookings" (
    "id" UUID NOT NULL,
    "published_trip_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "asientos" INTEGER NOT NULL,
    "pickup_lat" DOUBLE PRECISION NOT NULL,
    "pickup_lon" DOUBLE PRECISION NOT NULL,
    "dropoff_lat" DOUBLE PRECISION NOT NULL,
    "dropoff_lon" DOUBLE PRECISION NOT NULL,
    "precio_acordado" INTEGER NOT NULL,
    "mensaje_intro" TEXT,
    "special_request" INTEGER,
    "payment_id" UUID,
    "dedup_key" TEXT NOT NULL,
    "estado" "booking"."BookingState" NOT NULL DEFAULT 'SOLICITADO',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "published_trips_estado_fecha_hora_salida_idx" ON "booking"."published_trips"("estado", "fecha_hora_salida");

-- CreateIndex
CREATE INDEX "published_trips_driver_id_idx" ON "booking"."published_trips"("driver_id");

-- CreateIndex
CREATE INDEX "bookings_published_trip_id_estado_idx" ON "booking"."bookings"("published_trip_id", "estado");

-- CreateIndex
CREATE INDEX "bookings_passenger_id_idx" ON "booking"."bookings"("passenger_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_dedup_key_key" ON "booking"."bookings"("dedup_key");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "booking"."outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "booking"."bookings" ADD CONSTRAINT "bookings_published_trip_id_fkey" FOREIGN KEY ("published_trip_id") REFERENCES "booking"."published_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
