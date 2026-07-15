-- Lote F2.1a · ADR-017 §1.1 — unifica las gasolinas con octanaje a UNA sola referencia GASOLINE_90.
-- El EnergyCatalog guarda `sources` como array JSONB [{sourceId, unit, pricePerUnitCents}] en el
-- singleton id='GLOBAL'. Esta migración RENOMBRA el sourceId 'GASOLINE_95'/'GASOLINE_84' → 'GASOLINE_90'.
-- SOLO toca el sourceId; NO cambia pricePerUnitCents → CERO impacto de precio (B5 sigue en shadow).
--
-- Elección documentada (si conviven 95 y 84): se CONSERVA la entrada de 'GASOLINE_95' como canónica
-- (es la única que el seed 20260616160000 sembró = el precio del fuel global) y se DESCARTA la de
-- 'GASOLINE_84' para no producir un 'GASOLINE_90' duplicado. En la práctica solo existe GASOLINE_95
-- (caso de 1 fuente), así que el dedupe es defensivo.
--
-- Idempotente: el WHERE filtra solo filas que AÚN contienen 95/84; tras correr no quedan → re-run = no-op.
UPDATE "trip"."energy_catalog" AS ec
SET "sources" = (
  SELECT COALESCE(jsonb_agg(renamed.elem), '[]'::jsonb)
  FROM (
    SELECT
      CASE
        WHEN elem->>'sourceId' IN ('GASOLINE_95', 'GASOLINE_84')
          THEN jsonb_set(elem, '{sourceId}', '"GASOLINE_90"'::jsonb)
        ELSE elem
      END AS elem
    FROM jsonb_array_elements(ec."sources") AS elem
    -- dedupe: si existe una GASOLINE_95, se descartan las GASOLINE_84 (no se renombran → no duplican el 90).
    WHERE NOT (
      elem->>'sourceId' = 'GASOLINE_84'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(ec."sources") AS e2
        WHERE e2->>'sourceId' = 'GASOLINE_95'
      )
    )
  ) AS renamed
)
WHERE ec."id" = 'GLOBAL'
  AND (
    ec."sources" @> '[{"sourceId": "GASOLINE_95"}]'::jsonb
    OR ec."sources" @> '[{"sourceId": "GASOLINE_84"}]'::jsonb
  );
