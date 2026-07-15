-- AUTO-suspensión del conductor por RATING bajo (decisión del dueño · compliance/seguridad).
-- rating-service decide la suspensión (evento `driver.flagged` reason='suspension', solo con ≥ mínimo de
-- reseñas) e identity la materializa como un hold con esta NUEVA causa. Igual que DOCUMENT_EXPIRED/INSPECTION_EXPIRED
-- es una causa AUTOMÁTICA (NO-disciplinaria): la levanta el override de compliance del operador (reactivateForCompliance),
-- NUNCA la vía disciplinaria (reactivate()). Reactivación MANUAL: no se auto-levanta al recuperar el rating.
--
-- AISLAMIENTO TRANSACCIONAL: en Postgres, `ALTER TYPE ... ADD VALUE` históricamente NO puede correr dentro de un
-- bloque transaccional junto a statements que USEN el valor nuevo. Esta migración agrega el valor y NADA MÁS
-- (no lo referencia), así que es segura. La mantenemos como migración PROPIA (un solo statement) para no acoplarla
-- a ningún backfill/uso del valor en la misma transacción.

-- AlterEnum
ALTER TYPE "identity"."SuspensionCause" ADD VALUE 'RATING_LOW';
