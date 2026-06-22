import {
  DocumentUploadStatus,
  isAcceptableServerDocStatus,
  registrationDocTypeToBackend,
  type PersonalData,
  type RegistrationDocument,
  type RegistrationDocumentType,
  type RegistrationDocumentView,
} from '../entities';

/**
 * Tipos de documento del alta que son DOCUMENT-BACKED (su "hecho" se puede derivar de
 * `GET /drivers/me/documents`). Son el rango EXACTO sobre el que aplica el gate server-aware y la
 * hidratación: DNI + LICENSE (paso 1 · Conductor) y SOAT + tarjeta + foto (paso 2 · Vehículo).
 *
 * Derivar el set explícitamente (en vez de iterar el union completo) deja que un tipo nuevo del alta
 * sea una DECISIÓN explícita aquí — no un doc que se cuela mudo por el gate equivocado.
 */
export const DOCUMENT_BACKED_REGISTRATION_TYPES: readonly RegistrationDocumentType[] = [
  'DNI',
  'LICENSE',
  'SOAT',
  'VEHICLE_REGISTRATION',
  'VEHICLE_PHOTO',
];

/**
 * ¿El SERVIDOR ya tiene el documento del alta (`type`) en un estado ACEPTABLE
 * (PENDING_REVIEW / VALID / EXPIRING_SOON)? Mapea la etiqueta del wizard al `FleetDocumentType`
 * canónico y la compara contra el listado real de `GET /drivers/me/documents`.
 *
 * Es el helper CANÓNICO de "qué ya mandé al servidor": lo consumen TODOS los pasos document-backed
 * (DNI, LICENSE, SOAT, tarjeta, foto) para derivar "hecho" de la MISMA fuente de verdad (el server),
 * de forma COHERENTE — sin que un paso mire el server y otro solo el estado local de sesión.
 *
 * `serverDocs` puede ser `undefined` (la query aún no resolvió): en ese caso devuelve `false`
 * (todavía no sabemos; el gate local lo respalda). Nunca lanza.
 */
export function serverHasAcceptableDoc(
  serverDocs: readonly RegistrationDocumentView[] | undefined,
  type: RegistrationDocumentType,
): boolean {
  if (!serverDocs) {
    return false;
  }
  const backendType = registrationDocTypeToBackend(type);
  return serverDocs.some(
    (doc) => doc.type === backendType && isAcceptableServerDocStatus(doc.status),
  );
}

/** El documento del servidor (crudo) para un tipo del alta, o `undefined` si no existe en el listado. */
export function findServerDoc(
  serverDocs: readonly RegistrationDocumentView[] | undefined,
  type: RegistrationDocumentType,
): RegistrationDocumentView | undefined {
  if (!serverDocs) {
    return undefined;
  }
  const backendType = registrationDocTypeToBackend(type);
  return serverDocs.find((doc) => doc.type === backendType);
}

/**
 * Plan de hidratación del store del alta DERIVADO del estado del SERVIDOR (`GET /drivers/me/documents`).
 * Es un objeto de datos PURO (sin efectos): describe QUÉ hidratar; el aplicador (hook) decide CÓMO y de
 * forma NO destructiva (no pisa lo que el conductor está escribiendo en esta sesión).
 */
export interface RegistrationHydrationPlan {
  /**
   * Tipos de documento del alta que el servidor YA tiene en un estado aceptable → marcar `UPLOADED`
   * en el avance local para que el "hecho" del paso quede respaldado por el server al reanudar.
   */
  uploadedDocTypes: RegistrationDocumentType[];
  /**
   * Número de DNI leído del documento DNI del servidor (`documentNumber`), o `null` si el server no lo
   * tiene aún. El DNI ES un documento del alta (`FleetDocumentType.DNI`) y su `documentNumber` ES el
   * número del DNI: por eso podemos hidratar `personal.dni` SIN un endpoint de datos personales
   * (que el contrato `GET /drivers/me` NO expone).
   */
  dni: string | null;
}

/**
 * USECASE PURO: deriva el plan de hidratación del store a partir del listado de documentos del servidor.
 *
 * FUENTE DE VERDAD de "qué ya mandé" = el SERVIDOR. Al reanudar el alta, el store local de sesión está
 * vacío (no se persiste la PII del DNI ni el avance de docs frente al server); este usecase reconstruye
 * desde el server qué pasos ya están hechos, de forma COHERENTE para TODOS los pasos document-backed.
 *
 *  - `uploadedDocTypes`: cada doc del server en estado ACEPTABLE → su etiqueta del wizard, para
 *    `setDocumentStatus(type, UPLOADED)`.
 *  - `dni`: el `documentNumber` del documento DNI si está en estado aceptable (el número del DNI), para
 *    hidratar `personal.dni` y que el "hecho" del DNI derive del server IGUAL que la licencia.
 *
 * NO toca `fullName`/`birthDate`/`vehicle.*`: el contrato del servidor (`GET /drivers/me` +
 * `GET /drivers/me/documents`) NO los expone (no hay GET de datos personales ni del detalle del
 * vehículo más allá de los documentos). Hidratarlos exigiría un cambio de contrato del servidor.
 *
 * DEUDA: hidratar personal.fullName/birthdate desde el extractedData del doc DNI del server. techo: el
 * contrato driverDocumentView (mobile.ts) NO expone extractedData/nombre/fecha, solo type/status/expiresAt/
 * ok+documentNumber. gatillo: agregar extractedData (o legalName/birthDate) a GET /drivers/me/documents.
 */
export function buildRegistrationHydrationPlan(
  serverDocs: readonly RegistrationDocumentView[] | undefined,
): RegistrationHydrationPlan {
  const uploadedDocTypes: RegistrationDocumentType[] = [];
  for (const type of DOCUMENT_BACKED_REGISTRATION_TYPES) {
    if (serverHasAcceptableDoc(serverDocs, type)) {
      uploadedDocTypes.push(type);
    }
  }

  const dniDoc = findServerDoc(serverDocs, 'DNI');
  const dni =
    dniDoc && isAcceptableServerDocStatus(dniDoc.status) && dniDoc.documentNumber.trim().length > 0
      ? dniDoc.documentNumber.trim()
      : null;

  return { uploadedDocTypes, dni };
}

/**
 * Mutadores del store que el aplicador de la hidratación necesita. Es el PUERTO mínimo (DI): el usecase
 * de aplicación no depende del store concreto, solo de estas operaciones — testeable con stubs.
 */
export interface RegistrationHydrationTarget {
  /** Datos personales LOCALES actuales (para hidratar SOLO los campos vacíos, no destructivo). */
  readonly personal: PersonalData;
  /** Avance LOCAL de documentos (para no re-marcar lo ya marcado). */
  readonly documents: readonly RegistrationDocument[];
  setPersonal(data: Partial<PersonalData>): void;
  setDocumentStatus(type: RegistrationDocumentType, status: RegistrationDocument['status']): void;
}

/**
 * Aplica un plan de hidratación al store de forma NO DESTRUCTIVA e IDEMPOTENTE:
 *  - `personal.dni`: solo se hidrata si el campo LOCAL está vacío (no pisa lo que el conductor tipeó/
 *    escaneó en esta sesión).
 *  - doc statuses: marca `UPLOADED` solo los tipos que el server tiene aceptables y que el avance local
 *    aún NO marca como `UPLOADED` (evita writes redundantes / loops de render).
 *
 * Devuelve `true` si aplicó algún cambio (útil para tests y para evitar persistir sin necesidad).
 */
export function applyRegistrationHydration(
  plan: RegistrationHydrationPlan,
  target: RegistrationHydrationTarget,
): boolean {
  let changed = false;

  if (plan.dni && target.personal.dni.trim().length === 0) {
    target.setPersonal({ dni: plan.dni });
    changed = true;
  }

  for (const type of plan.uploadedDocTypes) {
    const local = target.documents.find((doc) => doc.type === type);
    if (local?.status !== DocumentUploadStatus.UPLOADED) {
      target.setDocumentStatus(type, DocumentUploadStatus.UPLOADED);
      changed = true;
    }
  }

  return changed;
}
