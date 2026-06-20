/**
 * Patrón canónico de placa peruana. FUENTE ÚNICA RN-safe (sin node:*): la importan los DTOs/casos de uso
 * que validan placa (fleet-service, driver-bff, driver app, parser OCR) en vez de redefinir el regex.
 *  - AUTO: 3 alfanuméricos + 3 (`ABC-123`, `A1B-234`).
 *  - MOTO/vehículo menor (categoría L): 3-4 dígitos + 2 letras (`7351-NB`, formato de las TIVe de moto).
 * Guion separador OPCIONAL (`7351NB`), case-insensitive. Espeja los PLATE_PATTERNS del parser OCR.
 */
export const PLATE_PATTERN = /^([A-Z0-9]{3}-?[A-Z0-9]{3}|\d{3,4}-?[A-Z]{2})$/i;

/** Mensaje canónico del error de placa inválida. */
export const PLATE_INVALID_MESSAGE = 'Placa inválida (formato auto ABC-123 o moto 1234-AB)';
