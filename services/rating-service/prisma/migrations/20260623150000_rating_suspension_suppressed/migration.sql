-- Período de gracia post-override de la auto-suspensión por rating (FIX 1).
-- El cron diario (recomputeAll) re-evaluaba las MISMAS reseñas viejas tras un override del operador y
-- re-emitía 'suspension' (prev.flagReason quedaba en null tras clearRatingFlag) → identity re-suspendía
-- dentro de 24h, anulando el override. Este flag SUPRIME la escalada por cron hasta que llegue una
-- reseña NUEVA, que es la única que lo limpia. Default false: los agregados existentes arrancan SIN
-- supresión (comportamiento idéntico al previo para conductores no reactivados).
ALTER TABLE "rating"."rating_aggregates"
  ADD COLUMN "suspension_suppressed" BOOLEAN NOT NULL DEFAULT false;
