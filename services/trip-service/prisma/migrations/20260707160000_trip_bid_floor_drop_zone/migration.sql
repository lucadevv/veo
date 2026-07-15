-- Lote A6 · ADR 010 §9.3 — poda la dimensión ZONA del bid floor (era capacidad 100% latente: siempre
-- 'GLOBAL'). El piso pasa a ser puramente per-OFERTA. El singleton id='GLOBAL' guarda `overrides` como
-- array JSONB [{zone, offeringId, floorCents}]; esta migración DROPEA la key `zone` de cada elemento →
-- [{offeringId, floorCents}]. SOLO quita la key; NO toca offeringId ni floorCents → CERO impacto de precio
-- (el piso resuelto de cada oferta queda idéntico: la zona era constante).
--
-- Idempotente y no-op segura: el WHERE solo pega en la fila singleton que AÚN tiene un elemento con `zone`.
-- Tras correr, ningún elemento lo tiene → re-run = no-op. Overrides vacío ([]) o fila ausente → el EXISTS
-- es falso → no se toca nada. `COALESCE(..., '[]')` es cinturón-y-tirantes por si el agregado queda vacío.
UPDATE "trip"."bid_floor_config" AS bfc
SET "overrides" = (
  SELECT COALESCE(jsonb_agg(elem - 'zone'), '[]'::jsonb)
  FROM jsonb_array_elements(bfc."overrides") AS elem
)
WHERE bfc."id" = 'GLOBAL'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(bfc."overrides") AS e
    WHERE e ? 'zone'
  );
