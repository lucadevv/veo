-- F2.7 (corrección del MODELO) · Service fee CARPOOLING editable. El modelo previo trataba el carpooling como
-- comisión 0 FIJA (descuento al conductor = on-demand), conceptualmente MAL para cost-sharing (BlaBlaCar): el
-- carpooling NO descuenta al conductor — cobra un SERVICE FEE al PASAJERO, sumado arriba de la contribución. Esa
-- tasa ES admin-editable (no hay nudo legal: es un cargo al pasajero, no lucro sobre el conductor). Esta migración
-- agrega la columna `carpooling_fee_bps` al singleton commission_config, sembrada en 0 (arranca sin fee; el admin
-- lo sube). NOT NULL DEFAULT 0 → la fila GLOBAL existente queda con fee 0, cero cambio al desplegar.
ALTER TABLE "payment"."commission_config"
  ADD COLUMN "carpooling_fee_bps" INTEGER NOT NULL DEFAULT 0;
