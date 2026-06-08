import type {
  CreateYapeAffiliation,
  DocumentType,
  YapeAffiliationView,
} from '@veo/api-client';
import type { AffiliationRepository } from './affiliationRepository';

/**
 * CAPACIDAD no habilitada para el comercio: el proveedor (ProntoPaga) no tiene activado el producto de
 * afiliación Yape On File en este comercio (BFF 422 `GATEWAY_CAPABILITY_UNAVAILABLE`). NO es un error del
 * usuario ni un fallo de la app, y NO es transitorio: reintentar nunca funcionará hasta que el proveedor
 * lo habilite (tarea comercial L0). La presentación lo muestra como banner INFO calmo ("la estamos
 * activando"), NUNCA como error rojo ni con "reintenta". La capa data traduce ese 422 a este error tipado
 * para que la presentación lo distinga sin acoplarse al `status`/`code` HTTP.
 */
export class AffiliationUnsupportedError extends Error {
  constructor() {
    super('La vinculación de Yape todavía no está disponible. La estamos activando.');
    this.name = 'AffiliationUnsupportedError';
  }
}

/**
 * Estado 422 `PROFILE_NAME_MISSING` del alta: el BFF resuelve el nombre del titular del PERFIL del
 * usuario; si el perfil no tiene nombre cargado responde 422 con ese código ("completá tu nombre
 * primero"). NO es un fallo de la app ni del formulario: la presentación lo muestra con un CTA al
 * perfil, no como error rojo de campo. La capa data traduce ese 422 a este error tipado para que la
 * presentación lo distinga sin acoplarse al HTTP.
 */
export class AffiliationProfileIncompleteError extends Error {
  constructor() {
    super('Completa tu nombre en el perfil antes de vincular Yape.');
    this.name = 'AffiliationProfileIncompleteError';
  }
}

/**
 * Estado 422 `PROFILE_DOCUMENT_MISSING` del alta: el flujo de UN TAP manda body VACÍO `{}` esperando que
 * el BFF lea el documento del PERFIL. Si el perfil aún no tiene documento, el server responde 422 con
 * este código: la presentación lo distingue para revelar el campo de documento (que al enviarse se
 * PERSISTE en el perfil → la próxima vez vuelve a ser un tap). NO es un error rojo: es una bifurcación
 * esperada del flujo de fricción mínima.
 */
export class AffiliationDocumentMissingError extends Error {
  constructor() {
    super('Carga tu documento para vincular Yape.');
    this.name = 'AffiliationDocumentMissingError';
  }
}

/**
 * Estado 502 `UPSTREAM_UNAVAILABLE` del alta: el gateway de Yape (sandbox tras Cloudflare) responde con
 * un 502 transitorio. NO es un error del usuario ni de la app: es reintentable. La capa data lo traduce
 * a este error tipado; la presentación reintenta automáticamente una vez y, si persiste, muestra un
 * mensaje honesto ("el servicio de Yape está ocupado, probá en un momento"), nunca un error críptico.
 */
export class AffiliationUpstreamUnavailableError extends Error {
  constructor() {
    super('El servicio de Yape está ocupado. Inténtalo en un momento.');
    this.name = 'AffiliationUpstreamUnavailableError';
  }
}

/** Error de validación del único campo del sheet de vinculación (documento). */
export class AffiliationValidationError extends Error {
  constructor(
    message: string,
    /** Campo que falló, para resaltarlo en el sheet. Hoy solo `document`. */
    readonly field: 'document',
  ) {
    super(message);
    this.name = 'AffiliationValidationError';
  }
}

/**
 * Validación LOCAL del documento por tipo (DNI=8 díg.; CE=9–12; PP=6–12 alfanum.). Validación amable y
 * no exhaustiva (el BFF hace la dura). Compartida entre el alta de Yape y la edición del documento en el
 * perfil para que el usuario tenga el mismo feedback en ambos lugares (exportada, single source of truth).
 */
export function isDocumentValid(documentType: DocumentType, document: string): boolean {
  const value = document.trim();
  if (documentType === 'DN') {
    return /^\d{8}$/.test(value);
  }
  if (documentType === 'CE') {
    return /^[A-Za-z0-9]{9,12}$/.test(value);
  }
  // PP: alfanumérico 6–12.
  return /^[A-Za-z0-9]{6,12}$/.test(value);
}

/** Lee el estado actual de la afiliación Yape (para pintar la card del perfil). */
export class GetYapeAffiliationUseCase {
  constructor(private readonly repository: AffiliationRepository) {}

  execute(): Promise<YapeAffiliationView> {
    return this.repository.getYapeAffiliation();
  }
}

/**
 * Da de alta la afiliación Yape On File con FRICCIÓN MÍNIMA (patrón PedidosYa · ProntoPaga: documento en
 * PERFIL, no en checkout). El body es TODO OPCIONAL:
 *
 *  - SIN argumento (`execute()`) → body VACÍO `{}`: el BFF lee documento+nombre del PERFIL y afilia
 *    directo. El flujo feliz de UN TAP (el perfil ya tiene el documento cargado).
 *  - CON `{documentType, document}` → primera vez que el usuario carga su documento: el BFF lo PERSISTE
 *    en el perfil y luego afilia (la próxima vez vuelve a ser un tap). Se valida el documento ANTES de
 *    tocar la red.
 *
 * El BFF resuelve el nombre del titular del perfil y fija `origin=MOBILE` (el `deepLink` abre Yape
 * directo). Errores de entorno los traduce la capa data: 422 `GATEWAY_CAPABILITY_UNAVAILABLE` →
 * `AffiliationUnsupportedError` (capacidad no habilitada en el comercio, NO reintentable),
 * 422 `PROFILE_NAME_MISSING` → `AffiliationProfileIncompleteError`, 422 `PROFILE_DOCUMENT_MISSING` →
 * `AffiliationDocumentMissingError`, 502 `UPSTREAM_UNAVAILABLE` → `AffiliationUpstreamUnavailableError`.
 */
export class CreateYapeAffiliationUseCase {
  constructor(private readonly repository: AffiliationRepository) {}

  execute(input?: CreateYapeAffiliation): Promise<YapeAffiliationView> {
    // Flujo feliz de UN TAP: sin documento → body vacío, el server lo resuelve del perfil.
    if (input?.documentType == null || input.document == null) {
      return this.repository.createYapeAffiliation();
    }
    // Primera vez: validamos el documento localmente antes de mandarlo (el server lo persiste).
    if (!isDocumentValid(input.documentType, input.document)) {
      throw new AffiliationValidationError(
        'Ingresa un documento válido para el tipo seleccionado.',
        'document',
      );
    }
    return this.repository.createYapeAffiliation({
      documentType: input.documentType,
      document: input.document.trim(),
    });
  }
}

/** Revoca la afiliación Yape (desactivar el cobro automático). Acción destructiva, siempre visible. */
export class RevokeYapeAffiliationUseCase {
  constructor(private readonly repository: AffiliationRepository) {}

  execute(): Promise<YapeAffiliationView> {
    return this.repository.revokeYapeAffiliation();
  }
}
