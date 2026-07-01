-- ADR-018 Lote 2 · Backfill idempotente del estado inicial del KYC.
--
-- Los PASAJEROS que nacieron en PENDING por la CONFLACIÓN de estado (ADR-018 §0.2) — nunca hicieron
-- ningún KYC (kyc_verified_at IS NULL) — pasan a UNVERIFIED, que es su estado REAL: "no arrancó".
-- Antes de ADR-018 el @default de la columna era PENDING, y la app interpretaba PENDING = "en revisión"
-- → el pasajero quedaba amurallado "en revisión" sin haber hecho nada. Lote 1 cambió el @default a
-- UNVERIFIED (solo inserts NUEVOS); este Lote 2 corrige las filas YA existentes.
--
-- NO toca (por diseño):
--  - Pasajeros/conductores VERIFIED: una verificación vigente no se "des-decide" (guard: solo PENDING).
--  - Conductores en PENDING LEGÍTIMO (REJECTED->PENDING por resubmit, ADR-018 state machine): el guard
--    type='PASSENGER' los excluye. (Al aplicar esta migración no hay ninguno, pero el guard lo garantiza
--    a futuro y documenta la intención.)
--  - Cualquier fila con kyc_verified_at seteado (verificó en algún momento).
--
-- Idempotente: una segunda corrida no encuentra filas (ya quedaron en UNVERIFIED).

UPDATE "identity"."users"
   SET "kyc_status" = 'UNVERIFIED'
 WHERE "kyc_status" = 'PENDING'
   AND "kyc_verified_at" IS NULL
   AND "type" = 'PASSENGER';
