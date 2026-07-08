-- Centro (CITV) donde se realizó la inspección técnica — texto libre, opcional.
-- Aditiva y no destructiva: las filas existentes quedan NULL. Las inspecciones auto-registradas al aprobar el
-- documento ITV del vehículo no traen centro (el doc no lo captura hoy → follow-up: OCR); el alta manual del
-- operador (CreateInspectionDialog) sí lo captura. El ItvCard muestra "—" cuando es NULL.
ALTER TABLE "fleet"."inspections" ADD COLUMN "center" TEXT;
