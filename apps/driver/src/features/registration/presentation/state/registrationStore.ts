import { create } from 'zustand';
import type { ExtractedDniData, ExtractedPropertyCardData } from '@veo/api-client';
import type { PickedImage } from '../../../documents/domain';
import { prefsStore } from '../../../../core/storage/mmkv';
import { ORDERED_STEPS } from '../../../../navigation/registrationStackRoutes';
import { RegistrationStep } from '../../domain';
import type {
  FaceCapture,
  PersonalData,
  RegistrationDocument,
  RegistrationDocumentType,
  RegistrationDraft,
  RegistrationStatus,
  VehicleData,
  VehicleType,
} from '../../domain';

/**
 * Caras del DNI escaneadas en el paso 1 (anverso siempre; reverso si se capturó), a la ESPERA de subir
 * DESPUÉS de que el `PATCH /drivers/me/personal` cree el perfil del conductor. Hasta entonces el presign
 * del DNI devuelve 404 (no existe driver), así que la subida NO puede ocurrir en el momento del scan.
 *
 * VIVE SOLO EN MEMORIA (NO se persiste en MMKV): son base64 con PII del DNI (Ley 29733) y su único
 * propósito es el handoff scan→continue dentro de la misma sesión del wizard. Se limpia tras subir.
 */
export interface PendingDniCapture {
  /** Anverso del DNI listo para subir (siempre presente cuando hay captura). */
  front: PickedImage;
  /** Reverso si el escáner capturó la 2ª página; `null` si solo vino el anverso. */
  back: PickedImage | null;
  /**
   * Lote 1: data extraída por OCR del DNI (`ExtractedDniData`), ya mapeada del parser al contrato. Se
   * captura JUNTO a las caras en el momento del scan y se envía al registrar el DNI tras el PATCH. `null`
   * si el escaneo no extrajo ningún campo con confianza (degradación honesta: se sube sin `extractedData`).
   */
  extractedData: ExtractedDniData | null;
}

/**
 * Tarjeta de propiedad escaneada en el paso 2 (Vehículo · Lote 2 · scan-first), a la ESPERA de subir
 * DESPUÉS de que `POST /drivers/vehicles` cree el vehículo. Mismo patrón que `PendingDniCapture`: el
 * documento NO se sube en el momento del escaneo (se sube DIFERIDO tras crear el vehículo, reusando el
 * mismo uploader y tratando un 409 como éxito). Es la fuente de verdad de "se capturó una tarjeta"
 * INDEPENDIENTE del OCR: la imagen viaja aunque el texto no se lea.
 *
 * VIVE SOLO EN MEMORIA (NO se persiste en MMKV): es base64 de un documento (peso + dato del vehículo) y
 * su único propósito es el handoff scan→continue dentro de la misma sesión del wizard. Se limpia tras subir.
 */
export interface PendingPropertyCardCapture {
  /** Imagen de la tarjeta de propiedad lista para subir (siempre presente cuando hay captura). */
  front: PickedImage;
  /**
   * Lote 2: data extraída por OCR de la tarjeta (`ExtractedPropertyCardData`), ya mapeada del parser al
   * contrato. Se captura JUNTO a la imagen en el momento del scan y se envía al registrar el documento
   * tras crear el vehículo. `null` si el OCR no extrajo ningún campo (se sube sin `extractedData`).
   */
  extractedData: ExtractedPropertyCardData | null;
}

/**
 * Total de pasos del wizard (LOTE B: Conductor · Vehículo · KYC). DERIVADO de `ORDERED_STEPS` (la fuente
 * única tipada de la pila) — NUNCA un número mágico: si se agrega/quita un paso, este total lo sigue solo.
 */
export const REGISTRATION_TOTAL_STEPS = ORDERED_STEPS.length;

/**
 * Clave de preferencias para persistir el progreso del alta.
 * El `status` se rehidrata desde `GET /drivers/me` (ver `applyBackendStatus`); el resto del avance
 * del wizard se persiste localmente para no perderlo entre sesiones.
 */
const REGISTRATION_PREF_KEY = 'pref.registration.v1';

/**
 * Versión del esquema del wizard persistido. LOTE B (reagrupación 4→3 pasos) introdujo la `v2`: hasta
 * `v1` el wizard tenía 4 pasos (1=Datos · 2=Vehículo · 3=Documentos · 4=KYC); en `v2` son 3 (1=Conductor ·
 * 2=Vehículo · 3=KYC). Un snapshot SIN `schemaVersion` (o `< 2`) se MIGRA al rehidratar (ver
 * `migratePersisted`): el `currentStep` legacy se remapea al paso nuevo correcto, no se confía a ciegas.
 */
const REGISTRATION_SCHEMA_VERSION = 2;

/** Total de pasos del layout legacy (`v1`): 1=Datos · 2=Vehículo · 3=Documentos · 4=KYC. */
const LEGACY_TOTAL_STEPS_V1 = 4;
/** Paso legacy "Documentos" (`v1`, paso 3): desapareció en `v2` — se remapea a Vehículo (donde vive el SOAT). */
const LEGACY_DOCUMENTS_STEP_V1 = 3;
/** Paso legacy "KYC" (`v1`, paso 4): en `v2` la biometría es el paso 3. */
const LEGACY_KYC_STEP_V1 = 4;

/** Forma del snapshot persistido en MMKV. */
interface PersistedRegistration {
  status: RegistrationStatus;
  currentStep: number;
  personal: PersonalData;
  vehicle: VehicleData;
  documents: RegistrationDocument[];
  faceCapture: FaceCapture | null;
  /** Si el `status` ya fue confirmado por el backend al menos una vez (evita parpadeos al arrancar). */
  statusResolvedFromBackend: boolean;
  /**
   * Versión del esquema (LOTE B). Ausente en snapshots `v1` (pre-reagrupación): `loadPersisted` los detecta
   * por la ausencia y los migra. Siempre `REGISTRATION_SCHEMA_VERSION` en los snapshots que escribimos hoy.
   */
  schemaVersion?: number;
}

const emptyPersonal: PersonalData = { fullName: '', dni: '', birthdate: '' };
const emptyVehicle: VehicleData = {
  // LOTE 1: SIN seed "Auto". El tipo arranca en `null` y se DERIVA de la categoría MTC de la tarjeta (fuente
  // de verdad) o se elige a mano en el fallback. El alta NO asume tipo: nunca se registra "Auto" en silencio.
  type: null,
  plate: '',
  year: '',
  modelSpecId: '',
  brand: '',
  model: '',
  mtcCategory: '',
};
const initialDocuments: RegistrationDocument[] = [
  { type: 'LICENSE', status: 'pending' },
  { type: 'SOAT', status: 'pending' },
  { type: 'VEHICLE_REGISTRATION', status: 'pending' },
  // Foto del vehículo (Ola 1): se captura en el paso 2 (Vehículo) pero se trackea como documento
  // (reusa el pipeline de subida y aparece en el visor del admin). Requerida para aprobar.
  { type: 'VEHICLE_PHOTO', status: 'pending' },
];

export interface RegistrationState {
  /**
   * Estado global del alta. Se rehidrata desde el backend (`applyBackendStatus`) tras autenticar;
   * por defecto `not_started` solo como valor inicial mientras llega esa respuesta.
   */
  status: RegistrationStatus;
  /**
   * `true` cuando `GET /drivers/me` ya confirmó el `status` al menos una vez. Permite distinguir el
   * default local (sin confirmar) del estado real del servidor y evitar parpadeos al arrancar.
   */
  statusResolvedFromBackend: boolean;
  /** Paso actual del wizard (1..3). */
  currentStep: number;
  personal: PersonalData;
  vehicle: VehicleData;
  documents: RegistrationDocument[];
  faceCapture: FaceCapture | null;
  /**
   * DNI escaneado en el paso 1, a la espera de subir tras el `PATCH /drivers/me/personal` (que crea el
   * driver). `null` si el conductor no escaneó (tipeó a mano) o si el DNI ya se subió. NO se persiste.
   */
  pendingDni: PendingDniCapture | null;
  /**
   * Tarjeta de propiedad escaneada en el paso 2 (Vehículo), a la espera de subir tras `POST
   * /drivers/vehicles` (que crea el vehículo). `null` si el conductor no escaneó (carga manual) o si ya
   * se subió. NO se persiste (base64 de un documento; handoff scan→continue efímero).
   */
  pendingPropertyCard: PendingPropertyCardCapture | null;

  setPersonal(data: Partial<PersonalData>): void;
  /** Fija el tipo del vehículo (derivado de la tarjeta o elegido a mano). `null` lo deja sin definir. */
  setVehicleType(type: VehicleType | null): void;
  setVehicle(data: Partial<VehicleData>): void;
  setDocumentStatus(type: RegistrationDocumentType, status: RegistrationDocument['status']): void;
  setFaceCapture(capture: FaceCapture): void;
  /** Guarda las caras del DNI escaneado para subirlas tras el PATCH /personal (idempotente: reemplaza). */
  setPendingDni(capture: PendingDniCapture): void;
  /** Descarta el DNI pendiente (tras subirlo con éxito, o al reiniciar el escaneo). */
  clearPendingDni(): void;
  /** Guarda la tarjeta de propiedad escaneada para subirla tras crear el vehículo (idempotente: reemplaza). */
  setPendingPropertyCard(capture: PendingPropertyCardCapture): void;
  /** Descarta la tarjeta de propiedad pendiente (tras subirla con éxito, o al reiniciar el escaneo). */
  clearPendingPropertyCard(): void;
  setCurrentStep(step: number): void;
  setStatus(status: RegistrationStatus): void;
  /**
   * Aplica el estado mapeado desde `GET /drivers/me`. Marca `statusResolvedFromBackend`. Para no
   * pisar el avance local del wizard, cuando el backend indica "wizard" (`not_started`) solo
   * reinicia si el estado local venía como `approved`/`in_review` (corrección); si el conductor
   * estaba avanzando (`in_progress`), conserva su progreso.
   */
  applyBackendStatus(status: RegistrationStatus): void;
  /**
   * Fuerza el wizard (alta) cuando el backend confirma que el conductor NO existe aún
   * (`GET /drivers/me` ⇒ 404 definitivo). A diferencia de `applyBackendStatus('not_started')`, NUNCA
   * conserva un `status` resuelto previo (`approved`/`in_review`/`rejected`): un 404 significa que no
   * hay registro en el backend, así que cualquier estado "resuelto" heredado (p. ej. por una fuga de
   * un logout anterior) es espurio y debe descartarse. Solo se respeta el progreso local en curso
   * (`in_progress`) para no expulsar al conductor que está rellenando el wizard. Marca
   * `statusResolvedFromBackend` (el 404 ES una respuesta definitiva del servidor).
   */
  forceWizard(): void;
  /** Compone el borrador inmutable a enviar al backend. */
  buildDraft(): RegistrationDraft;
  /** Limpia el progreso (uso en logout o reinicio del alta). */
  reset(): void;
}

/**
 * Remapea el `currentStep` de un snapshot legacy (`v1`, 4 pasos) al layout `v2` (3 pasos) de LOTE B:
 *  - paso 3 legacy (Documentos, que YA NO existe) → paso 2 (Vehículo): el conductor re-recorre el paso donde
 *    ahora vive el SOAT, y el back desde ahí llega al paso 1 (Conductor) donde ahora vive la licencia. Nunca
 *    salta a KYC con docs a medias.
 *  - paso 4 legacy (KYC) → paso 3 (la biometría es el último paso en `v2`).
 *  - pasos 1 y 2 quedan igual (Datos/Conductor y Vehículo no cambiaron de índice).
 *  - cualquier otro valor fuera de rango → paso 1 (degradación segura, nunca un índice inválido).
 */
function migrateLegacyStep(step: number): number {
  if (step === LEGACY_DOCUMENTS_STEP_V1) {
    return RegistrationStep.VEHICLE;
  }
  if (step === LEGACY_KYC_STEP_V1) {
    return RegistrationStep.IDENTITY_VERIFICATION;
  }
  if (step >= 1 && step <= LEGACY_TOTAL_STEPS_V1) {
    return step;
  }
  return RegistrationStep.PERSONAL_DATA;
}

/**
 * Lee el snapshot persistido (si existe) y, si es un esquema viejo (`v1`, sin `schemaVersion`), lo MIGRA al
 * layout `v2` de LOTE B (4→3 pasos): el `currentStep` legacy se remapea con `migrateLegacyStep`. Así un
 * conductor que cerró la app en el viejo paso "Documentos" (3) REANUDA en Vehículo (2) en vez de aterrizar
 * en KYC con el SOAT/licencia sin capturar — degradación limpia, sin crash ni paso huérfano.
 */
function loadPersisted(): PersistedRegistration | null {
  const raw = prefsStore.getObject<PersistedRegistration>(REGISTRATION_PREF_KEY) ?? null;
  if (!raw) {
    return null;
  }
  if ((raw.schemaVersion ?? 1) >= REGISTRATION_SCHEMA_VERSION) {
    return raw;
  }
  return {
    ...raw,
    currentStep: migrateLegacyStep(raw.currentStep),
    schemaVersion: REGISTRATION_SCHEMA_VERSION,
  };
}

const persisted = loadPersisted();

/**
 * Store del wizard de registro (Zustand): única fuente de verdad del alta en la app. El estado del
 * wizard (datos de los 3 pasos + estado global) vive aquí; nunca en `setState` de componentes.
 * El snapshot se persiste en MMKV (preferencias) tras cada cambio para no perder el avance.
 */
export const useRegistrationStore = create<RegistrationState>((set, get) => {
  /** Persiste el estado relevante del store en MMKV. */
  const persist = (): void => {
    const {
      status,
      statusResolvedFromBackend,
      currentStep,
      personal,
      vehicle,
      documents,
      faceCapture,
    } = get();
    const snapshot: PersistedRegistration = {
      status,
      statusResolvedFromBackend,
      currentStep,
      personal,
      vehicle,
      documents,
      faceCapture,
      // LOTE B: sella el snapshot con la versión actual del esquema (3 pasos) para que un futuro cambio de
      // layout pueda detectar y migrar este snapshot igual que migramos los `v1` (4 pasos) al rehidratar.
      schemaVersion: REGISTRATION_SCHEMA_VERSION,
    };
    prefsStore.setObject(REGISTRATION_PREF_KEY, snapshot);
  };

  return {
    status: persisted?.status ?? 'not_started',
    statusResolvedFromBackend: persisted?.statusResolvedFromBackend ?? false,
    currentStep: persisted?.currentStep ?? 1,
    personal: persisted?.personal ?? emptyPersonal,
    vehicle: persisted?.vehicle ?? emptyVehicle,
    documents: persisted?.documents ?? initialDocuments,
    faceCapture: persisted?.faceCapture ?? null,
    // En memoria: nunca se rehidrata desde MMKV (base64 con PII del DNI; handoff scan→continue efímero).
    pendingDni: null,
    // En memoria: igual que `pendingDni` (base64 de un documento; handoff scan→continue efímero del paso 2).
    pendingPropertyCard: null,

    setPersonal: (data) => {
      set((state) => ({ personal: { ...state.personal, ...data } }));
      persist();
    },

    setVehicleType: (type) => {
      set((state) => ({ vehicle: { ...state.vehicle, type } }));
      persist();
    },

    setVehicle: (data) => {
      set((state) => ({ vehicle: { ...state.vehicle, ...data } }));
      persist();
    },

    setDocumentStatus: (type, status) => {
      // UPSERT: actualiza la entrada si existe, o la agrega. Robusto ante snapshots persistidos viejos
      // que no incluyen un tipo nuevo (p. ej. VEHICLE_PHOTO en un wizard a medias de una versión previa).
      set((state) => {
        const exists = state.documents.some((doc) => doc.type === type);
        return {
          documents: exists
            ? state.documents.map((doc) => (doc.type === type ? { ...doc, status } : doc))
            : [...state.documents, { type, status }],
        };
      });
      persist();
    },

    setFaceCapture: (capture) => {
      set({ faceCapture: capture });
      persist();
    },

    setPendingDni: (capture) => {
      // Solo en memoria: NO se llama a persist() (las caras del DNI no van a MMKV por PII/peso base64).
      set({ pendingDni: capture });
    },

    clearPendingDni: () => {
      set({ pendingDni: null });
    },

    setPendingPropertyCard: (capture) => {
      // Solo en memoria: NO se llama a persist() (base64 de un documento; no va a MMKV por peso).
      set({ pendingPropertyCard: capture });
    },

    clearPendingPropertyCard: () => {
      set({ pendingPropertyCard: null });
    },

    setCurrentStep: (step) => {
      set({
        currentStep: Math.min(Math.max(step, 1), REGISTRATION_TOTAL_STEPS),
        status: 'in_progress',
      });
      persist();
    },

    setStatus: (status) => {
      set({ status });
      persist();
    },

    applyBackendStatus: (status) => {
      const current = get().status;
      if (status === 'not_started') {
        // El backend dice "faltan documentos" (wizard). Solo reiniciamos si veníamos de un estado
        // ya resuelto (approved/in_review) que ahora el servidor contradice; si el conductor estaba
        // avanzando localmente, conservamos su progreso (`in_progress`).
        const next = current === 'approved' || current === 'in_review' ? 'not_started' : current;
        set({ status: next, statusResolvedFromBackend: true });
      } else {
        // approved / in_review / rejected: el backend manda.
        set({ status, statusResolvedFromBackend: true });
      }
      persist();
    },

    forceWizard: () => {
      const current = get().status;
      // 404 = no existe el conductor en el backend ⇒ wizard. Conservamos un `in_progress` en curso
      // (el conductor está rellenando el alta); cualquier otro estado heredado se descarta a favor
      // del wizard limpio (`not_started`). Importante para no atrapar a un conductor nuevo en tabs
      // por un `approved` espurio que hubiera sobrevivido a un logout previo (bug de fuga de PII).
      const next = current === 'in_progress' ? 'in_progress' : 'not_started';
      set({ status: next, statusResolvedFromBackend: true });
      persist();
    },

    buildDraft: () => {
      const { personal, vehicle, documents, faceCapture } = get();
      return {
        personal,
        vehicle,
        documents,
        faceCaptureRef: faceCapture?.ref ?? null,
      };
    },

    reset: () => {
      set({
        status: 'not_started',
        statusResolvedFromBackend: false,
        currentStep: 1,
        personal: emptyPersonal,
        vehicle: emptyVehicle,
        documents: initialDocuments,
        faceCapture: null,
        pendingDni: null,
        pendingPropertyCard: null,
      });
      prefsStore.remove(REGISTRATION_PREF_KEY);
    },
  };
});
