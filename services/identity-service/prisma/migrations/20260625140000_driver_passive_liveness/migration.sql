-- Veredicto del LIVENESS PASIVO (anti-spoofing PAD single-frame) del enrol del registro. El operador lo VE
-- en la ficha del conductor y `approve()` exige que el PAD haya CORRIDO (gate de ejecución, NO de veredicto).
-- `liveness_checked` = ¿corrió el PAD? (true = anti-spoofing real; false = degradado/modelo ausente; null = aún
-- no enrolado). `liveness_score` = score de la clase viva 0..1. Un spoof NUNCA se persiste (se rechaza en el
-- enrol, 422). Ambos NULLABLE (migración segura, sin backfill): null en conductores previos al campo → el borde
-- gRPC los deriva a NOT_RUN y el gate de aprobación los trata como "PAD no ejecutado" (fail-closed: re-enrolar).
-- AlterTable
ALTER TABLE "identity"."drivers"
  ADD COLUMN "liveness_checked" BOOLEAN,
  ADD COLUMN "liveness_score" DOUBLE PRECISION;
