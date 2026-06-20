/**
 * Lógica PURA del flujo "Capturado ✓" del sheet de documentos (Lote 1 · onboarding sin-formularios),
 * extraída del componente para poder testearla sin renderizar RN y para no enterrar la regla del campo
 * CRÍTICO en la UI. Mapea el `ParsedDocument` del dispatcher a un "readout" (campos LEÍDOS + data OCR del
 * contrato) y decide si falta el campo crítico (gating de auto-envío honesto).
 */

import type { ExtractedDocumentData } from '@veo/api-client';
import {
  parsedLicenseToExtracted,
  parsedSoatToExtracted,
  type ParsedDocument,
} from '../../../documents/domain';
import {
  REGISTRATION_DOCUMENT_FORM_CONFIG,
  type RegistrationDocumentFormType,
} from './registrationDocumentForm';

/**
 * Datos LEÍDOS por OCR listos para la tarjeta "Capturado ✓" (texto, no inputs) + la `extractedData` mapeada
 * al contrato. `number`/`expiry` ausentes = el OCR no los ancló (degradación honesta). `extractedData` es
 * `null` para los tipos que este sheet no produce (tarjeta de propiedad = Lote 2; DNI = paso 1).
 */
export interface CapturedReadout {
  number?: string;
  expiry?: string;
  extractedData: ExtractedDocumentData | null;
}

/**
 * Mapea el `ParsedDocument` (discriminado por `kind`, sin string mágico) al `CapturedReadout`. Solo licencia
 * y SOAT producen `extractedData` (los tipos OCR del Lote 1 en este sheet); la tarjeta de propiedad expone
 * la placa como número de referencia pero su `extractedData` es del Lote 2 (no se envía acá), y el DNI se
 * captura en el paso 1. Nunca inventa: lo no leído queda `undefined`.
 */
export function readoutFromParsed(parsed: ParsedDocument): CapturedReadout {
  switch (parsed.kind) {
    case 'license':
      return {
        ...(parsed.number ? { number: parsed.number } : {}),
        ...(parsed.expiresAt ? { expiry: parsed.expiresAt } : {}),
        extractedData: parsedLicenseToExtracted(parsed),
      };
    case 'soat':
      return {
        ...(parsed.policyNumber ? { number: parsed.policyNumber } : {}),
        ...(parsed.expiresAt ? { expiry: parsed.expiresAt } : {}),
        extractedData: parsedSoatToExtracted(parsed),
      };
    case 'propertyCard':
      return parsed.plate ? { number: parsed.plate, extractedData: null } : { extractedData: null };
    case 'dni':
      return { extractedData: null };
  }
}

/**
 * ¿Falta el campo CRÍTICO del tipo? Los campos críticos de un documento dependen de su config:
 *  - NÚMERO: si el tipo es numerado (licencia/SOAT/tarjeta) y el OCR no lo leyó → crítico faltante.
 *  - VENCIMIENTO: si el tipo VENCE (`hasExpiry`: SOAT/licencia) y el OCR no leyó el vencimiento → crítico
 *    faltante. El vencimiento es dato de VALIDEZ LEGAL: un SOAT/licencia sin vencimiento NO se auto-envía
 *    en silencio (espeja la honestidad del gating del número).
 * En cualquiera de los dos casos el sheet pide REESCANEAR (no muestra un formulario). Para tipos sin número
 * y sin vencimiento (foto del vehículo) nunca falta el crítico.
 */
export function isCriticalFieldMissing(
  type: RegistrationDocumentFormType,
  readout: CapturedReadout | null,
): boolean {
  const config = REGISTRATION_DOCUMENT_FORM_CONFIG[type];
  if (config.hasNumber && !readout?.number) {
    return true;
  }
  if (config.hasExpiry && !readout?.expiry) {
    return true;
  }
  return false;
}
