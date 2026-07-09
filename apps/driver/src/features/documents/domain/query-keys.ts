/**
 * Clave de caché COMPARTIDA del dominio de documentos. Vive en `domain` (no en `presentation`) para
 * que otras features (turno) lean el MISMO cache con coherencia SIN importar los hooks internos de
 * `documents/presentation` (feature-isolation).
 */

/** Clave de caché del listado de documentos del conductor. */
export const DOCUMENTS_QUERY_KEY = ['documents', 'list'] as const;
