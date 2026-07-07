-- Remoción del schedule/franjas de modo de pricing (ADR 011 · superseded por ADR 023).
-- Decisión (2026-07): el modo de pricing (FIJO/PUJA) ya NO se resuelve por horario/franjas — vive POR OFERTA
-- en el catálogo (palanca manual del admin, `effectiveOfferingMode`). El singleton del schedule quedó
-- huérfano (ningún código lo lee tras la remoción del ModeResolver/PricingScheduleService) → se dropea.
-- Sin pérdida de datos financieros: era config de modo, no historia de viajes ni de plata.
DROP TABLE IF EXISTS "trip"."pricing_mode_schedule";
