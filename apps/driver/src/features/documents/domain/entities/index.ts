import type {AddDocumentRequest, DriverDocument, DriverDocumentSimpleStatus} from '@veo/api-client';

/**
 * Entidades del dominio de documentos del conductor. El contrato `DriverDocument` trae tanto el
 * `status` crudo de fleet (VALID/EXPIRING_SOON/…) como el `simpleStatus` en español listo para la
 * UI, además del número, vencimiento (`expiresAt`, ISO o null) y el flag agregado `ok`.
 */
export type DriverDocument_ = DriverDocument;
export type {DriverDocument, DriverDocumentSimpleStatus};

/** Lista de documentos tal como la devuelve `GET /drivers/me/documents`. */
export type DriverDocumentList = DriverDocument[];

/**
 * Entrada para registrar/actualizar un documento. En esta ola el formulario captura solo
 * metadatos (tipo + número + vencimiento): la subida del binario llega en una ola posterior, por
 * eso `fileS3Key` no se expone en la UI.
 */
export type RegisterDocumentInput = AddDocumentRequest;
