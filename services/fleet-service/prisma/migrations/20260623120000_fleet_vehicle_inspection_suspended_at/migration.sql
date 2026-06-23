-- Lote B · AUTO-SUSPENSIÓN por INSPECCIÓN técnica (ITV) vencida. Cierra el lazo del gate de aprobación
-- (Lote A): si el vehículo OPERADO de un conductor pierde la ITV vigente, el cron de vencimientos suspende
-- al conductor (evento `fleet.driver_suspended` keyeado por User.id; identity resuelve User.id → Driver.id).
--
-- `inspection_suspended_at` es el LATCH de idempotencia LOCAL de fleet: el sweeper solo EMITE el evento
-- cuando la columna está en null (CAS `updateMany WHERE inspection_suspended_at IS NULL`), así el cron
-- repetido NO re-emite el mismo evento. NO refleja el estado de suspensión de identity (fuente de verdad en
-- `Driver.suspended_at`): es solo el anti-duplicado del lado fleet. Ver schema.prisma (model Vehicle).
ALTER TABLE "fleet"."vehicles" ADD COLUMN "inspection_suspended_at" TIMESTAMPTZ;
