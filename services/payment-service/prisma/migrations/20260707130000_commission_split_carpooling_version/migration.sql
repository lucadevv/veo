-- F2.7 (desacople de CAS · money-config #3) · Version INDEPENDIENTE para el service fee de CARPOOLING. Hasta
-- ahora la comisión ON-DEMAND y el service fee de CARPOOLING compartían UNA sola `version` (CAS) en el singleton
-- commission_config, aunque se editan desde DOS paneles admin distintos: editar uno 409eaba al otro (version
-- stale) — la plata siempre estuvo a salvo (el CAS previene el clobber), pero era un footgun de UX. Esta migración
-- agrega `carpooling_fee_version`: el PUT de carpooling bumpea SOLO esta columna; `version` queda para on-demand +
-- los fees PSP. Cada panel edita SU campo con SU propia CAS → no se 409ean entre sí.
--
-- Backfill = CONTINUIDAD para el cliente que ya tenía la version vieja: la nueva columna arranca igual a `version`
-- (no en 0), así el panel de carpooling que ya cargó `version` como su CAS sigue matcheando tras el deploy.
ALTER TABLE "payment"."commission_config"
  ADD COLUMN "carpooling_fee_version" INTEGER NOT NULL DEFAULT 0;

UPDATE "payment"."commission_config"
  SET "carpooling_fee_version" = "version";
