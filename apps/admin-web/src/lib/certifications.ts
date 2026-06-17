import { findOffering, FleetDocumentType } from '@veo/shared-types';

/**
 * Certificaciones de operador de las verticales (B5-vert · gate "oculto hasta vender"). El admin solo puede
 * GESTIONAR (subir/aprobar) las certs que exige una vertical HABILITADA en el catálogo: si la ambulancia
 * está apagada, su credencial no aparece en el form. Es REFLEJO, no autorización — el backend acepta
 * cualquier FleetDocumentType por API; esto es UX (no listar credenciales de un servicio que no se vende).
 *
 * Pura y testeable. Deriva las certs del catálogo de @veo/shared-types (`findOffering(id).requires
 * .certifications`) — fuente única, sin duplicar la lista de tipos. Tolerante a ids desconocidos (oferta
 * más nueva que el admin-web): `findOffering` devuelve undefined y se ignora.
 */
export function certificationTypesForEnabledOfferings(
  offerings: readonly { id: string; enabled: boolean }[],
): FleetDocumentType[] {
  const certs = new Set<FleetDocumentType>();
  for (const offering of offerings) {
    if (!offering.enabled) continue;
    findOffering(offering.id)?.requires?.certifications?.forEach((c) => certs.add(c));
  }
  return [...certs];
}

/** Nombre legible de las credenciales de vertical para el form del admin (los docs base se muestran crudos). */
const CERTIFICATION_LABELS: Partial<Record<FleetDocumentType, string>> = {
  [FleetDocumentType.AMBULANCE_OPERATOR]: 'Operador de ambulancia',
  [FleetDocumentType.TOW_OPERATOR]: 'Operador de grúa',
  [FleetDocumentType.MECHANIC_CERT]: 'Certificación de mecánico',
};

/** Etiqueta de un tipo de documento para el dropdown: nombre legible si es cert de vertical, crudo si no. */
export function documentTypeLabel(type: string): string {
  return CERTIFICATION_LABELS[type as FleetDocumentType] ?? type;
}
