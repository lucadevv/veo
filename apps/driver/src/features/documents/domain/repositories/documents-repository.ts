import type { DriverDocument, DriverDocumentList, RegisterDocumentInput } from '../entities';

/**
 * Contrato del repositorio de documentos (capa domain). Implementación concreta en `data/`.
 */
export interface DocumentsRepository {
  /** GET /drivers/me/documents — documentos del conductor con tipo, número, vencimiento y estado. */
  list(): Promise<DriverDocumentList>;
  /** POST /drivers/me/documents — registra/actualiza un documento (metadatos); devuelve el creado. */
  register(input: RegisterDocumentInput): Promise<DriverDocument>;
}
