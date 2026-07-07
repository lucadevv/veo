-- Remoción del modelo de energía/combustible del pricing on-demand.
-- Decisión (2026-07): la tarifa on-demand usa UN solo per-km all-in (fórmula canónica Uber). El catálogo de
-- energía (B5) y el recargo de combustible (B3/B4) eran una variable de más que se sumaba al per-km (riesgo de
-- doble-cuenta) y no existe en el modelo del mercado. Los singletons de hot-config quedaron huérfanos (ningún
-- código los lee tras la remoción) → se dropean. Sin pérdida de datos financieros: eran config, no historia.
DROP TABLE IF EXISTS "trip"."fuel_surcharge_config";
DROP TABLE IF EXISTS "trip"."energy_catalog";
