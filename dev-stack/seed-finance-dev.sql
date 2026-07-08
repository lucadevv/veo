-- ─────────────────────────────────────────────────────────────────────────────
-- Seed DEV de PAGOS (payment-service) — alimenta las 3 pantallas de finanzas del admin
-- (Liquidaciones · Reembolsos · Reconciliación) sin depender de webhooks reales.
--
--   Ejecutar:  docker exec -i veo-postgres psql -U veo -d veo < dev-stack/seed-finance-dev.sql
--   (o vía)    dev-stack/veo.sh seed-finance   ← además imprime los tripIds sembrados.
--
-- Todo son cobros de TARIFA (kind=FARE) CAPTURED del conductor sembrado por seed-dev-driver.sql,
-- método YAPE (digital → cuenta para la reconciliación), modo ON_DEMAND, comisión 20%.
-- Dinero SIEMPRE en céntimos PEN (enteros). Sin FK cross-service: payment tiene su propio schema,
-- así que NO hace falta una fila Trip para estos tripIds.
--
-- IDEMPOTENTE: `id = gen_random_uuid()` (nunca colisiona) + `ON CONFLICT (dedup_key) DO NOTHING`
-- (la dedupKey determinista `seed-fare:{tripId}` es la barrera de re-ejecución). Re-correr NO duplica
-- ni rota los tripIds ya sembrados.
--
-- VENTANAS (calculadas en SQL, UTC-safe — NO hardcodeadas), coherentes con los crons del servicio:
--   · Reembolsos     → capturados HACE HORAS (dentro de la ventana de reembolso de 7 días · BR-P06).
--   · Liquidaciones  → capturados en la SEMANA PREVIA [lunes_pasado, este_lunes) (payout cron · BR-P05).
--                      El neto (gross−comisión+tip) suma S/61.60 > S/50 (PAYOUT_MIN_CENTS) → genera Payout.
--   · Reconciliación → capturados AYER (día previo UTC), que es lo que suma el cron diario 04:00 (BR-P07).
-- ─────────────────────────────────────────────────────────────────────────────

WITH win AS (
  SELECT
    -- Lunes 00:00 UTC de ESTA semana (fin exclusivo del período de liquidación previo).
    (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')                     AS this_monday,
    -- Lunes 00:00 UTC de la SEMANA PREVIA (inicio del período de liquidación).
    (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '7 days' AS last_monday,
    -- Medianoche UTC de AYER (inicio del día previo que concilia el cron diario).
    (date_trunc('day',  now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 day'  AS yesterday
)
INSERT INTO payment.payments (
  id, trip_id, driver_id, passenger_id, dedup_key,
  amount_cents, gross_cents, commission_cents, fee_cents, psp_fee_cents, net_settled_cents,
  method, status, kind, mode,
  captured_at, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  v.trip_id::uuid,
  'd0000000-0000-4000-8000-000000000001'::uuid,   -- driverId = User.id del conductor DEV (seed-dev-driver.sql)
  'e0000000-0000-4000-8000-0000000000f1'::uuid,   -- passengerId sintético (payment NO tiene FK cross-service)
  'seed-fare:' || v.trip_id,                       -- dedupKey determinista (idempotencia / ON CONFLICT)
  v.gross_cents,                                    -- amount = gross (sin propina ni descuento)
  v.gross_cents,
  v.commission_cents,
  v.commission_cents,                              -- fee visible = comisión
  0,                                                -- pspFee 0 (sin tarifa PSP cargada en dev · degradación honesta)
  v.gross_cents,                                    -- netSettled = amount (fee PSP 0)
  'YAPE', 'CAPTURED', 'FARE', 'ON_DEMAND',
  captured_at, captured_at, captured_at
FROM win w
CROSS JOIN LATERAL (
  VALUES
    -- ── Reembolsos: 2 cobros recientes (dentro de los 7 días de la ventana de reembolso) ──
    ('f0000000-0000-4000-8000-0000000000a1', 3200, 640,  now() - interval '2 hours'),
    ('f0000000-0000-4000-8000-0000000000a2', 4500, 900,  now() - interval '5 hours'),
    -- ── Liquidaciones: 2 cobros en la SEMANA PREVIA (neto 2800 + 3360 = 6160 > 5000 = S/50) ──
    ('f0000000-0000-4000-8000-0000000000b1', 3500, 700,  w.last_monday + interval '1 day 10 hours'),
    ('f0000000-0000-4000-8000-0000000000b2', 4200, 840,  w.last_monday + interval '2 days 15 hours'),
    -- ── Reconciliación: 2 cobros de AYER (día previo UTC que suma el cron diario) ──
    ('f0000000-0000-4000-8000-0000000000c1', 2500, 500,  w.yesterday   + interval '9 hours'),
    ('f0000000-0000-4000-8000-0000000000c2', 1800, 360,  w.yesterday   + interval '13 hours')
) AS v(trip_id, gross_cents, commission_cents, captured_at)
ON CONFLICT (dedup_key) DO NOTHING;
