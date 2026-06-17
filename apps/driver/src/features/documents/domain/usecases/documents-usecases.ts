import type { DocumentsRepository } from '../repositories/documents-repository';
import type { DriverDocument, DriverDocumentList, RegisterDocumentInput } from '../entities';
import { needsAttention, statusPriority } from '../value-objects/document-status';

/**
 * Caso de uso: lista de documentos del conductor, ordenada por urgencia (vencido → rechazado →
 * por vencer → en revisión → vigente). Ordenar en el dominio mantiene la pantalla declarativa y
 * facilita probar la priorización sin renderizar UI.
 */
export class ListDocumentsUseCase {
  constructor(private readonly documents: DocumentsRepository) {}

  async execute(): Promise<DriverDocumentList> {
    const docs = await this.documents.list();
    return [...docs].sort(
      (a, b) => statusPriority(a.simpleStatus) - statusPriority(b.simpleStatus),
    );
  }
}

/** Caso de uso: registrar/actualizar un documento del conductor (metadatos de la ola actual). */
export class RegisterDocumentUseCase {
  constructor(private readonly documents: DocumentsRepository) {}

  execute(input: RegisterDocumentInput): Promise<DriverDocument> {
    return this.documents.register(input);
  }
}

/** Cuenta cuántos documentos requieren atención (vencido/por vencer/rechazado) para el resumen. */
export function countDocumentsNeedingAttention(docs: DriverDocumentList): number {
  return docs.filter((doc) => needsAttention(doc.simpleStatus)).length;
}
