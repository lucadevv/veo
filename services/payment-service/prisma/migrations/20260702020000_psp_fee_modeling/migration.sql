-- P-B (ADR-022 §P-B) · Modelar el fee del PSP (ProntoPaga) para que los libros CUADREN con el banco. ProntoPaga
-- descuenta un fee antes de depositar → el bruto (amountCents) NO es lo que la plataforma recibe. Se modela el fee
-- en la captura (desde una tarifa editable por método) y se persiste el neto REAL. Legacy = NULL (no modelado).
ALTER TABLE "payment"."payments"
  ADD COLUMN "psp_fee_cents" INTEGER,
  ADD COLUMN "net_settled_cents" INTEGER;

-- Fee del PSP por MÉTODO digital, en basis points Int (0..10000), EDITABLE por admin. Arranca en 0 (degradación
-- honesta hasta que el dueño cargue las tarifas del convenio). CASH no tiene fee (no pasa por el PSP). NOT NULL
-- DEFAULT 0 → la fila singleton existente queda con fee 0, cero cambio al desplegar.
ALTER TABLE "payment"."commission_config"
  ADD COLUMN "yape_fee_bps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "plin_fee_bps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "card_fee_bps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pagoefectivo_fee_bps" INTEGER NOT NULL DEFAULT 0;
