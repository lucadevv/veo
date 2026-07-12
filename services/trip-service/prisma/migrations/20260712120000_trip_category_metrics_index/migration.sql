-- Métricas 30d por OFERTA (página-detalle del catálogo admin · board HjDvx "Ofertas · Detalle"). El endpoint
-- interno /internal/analytics/offering-metrics agrega count + Σ fare_cents del cohorte (category = offering id,
-- status = COMPLETED, completed_at en la ventana de 30 días). Sin este índice la agregación escanearía todo el
-- histórico de viajes COMPLETED filtrando por category en residual; el compuesto [category, status, completed_at]
-- cubre la igualdad (category, status) + el rango de completed_at en el btree. Read-only (réplica), pega ocasional
-- por carga del detalle. Ver schema.prisma (@@index([category, status, completedAt])).

-- CreateIndex
CREATE INDEX "trips_category_status_completed_at_idx" ON "trip"."trips"("category", "status", "completed_at");
