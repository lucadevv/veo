import { create } from 'zustand';
import { prefsStore } from '../../../../core/storage/mmkv';
import {
  VehicleType,
  type FaceCapture,
  type PersonalData,
  type RegistrationDocument,
  type RegistrationDocumentType,
  type RegistrationDraft,
  type RegistrationStatus,
  type VehicleData,
} from '../../domain';

/** Total de pasos del wizard (Datos · Vehículo · Documentos · KYC). */
export const REGISTRATION_TOTAL_STEPS = 4;

/**
 * Clave de preferencias para persistir el progreso del alta.
 * El `status` se rehidrata desde `GET /drivers/me` (ver `applyBackendStatus`); el resto del avance
 * del wizard se persiste localmente para no perderlo entre sesiones.
 */
const REGISTRATION_PREF_KEY = 'pref.registration.v1';

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
}

const emptyPersonal: PersonalData = { fullName: '', dni: '', birthdate: '' };
const emptyVehicle: VehicleData = {
  // "Solo autos" (Ola 1): el alta arranca en CAR. La clase real OPERABLE la gobierna el catálogo
  // (OPERABLE_VEHICLE_CLASSES) vía el selector; este es solo el valor semilla del wizard.
  type: VehicleType.CAR,
  plate: '',
  year: '',
  modelSpecId: '',
  brand: '',
  model: '',
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
  /** Paso actual del wizard (1..4). */
  currentStep: number;
  personal: PersonalData;
  vehicle: VehicleData;
  documents: RegistrationDocument[];
  faceCapture: FaceCapture | null;

  setPersonal(data: Partial<PersonalData>): void;
  setVehicleType(type: VehicleType): void;
  setVehicle(data: Partial<VehicleData>): void;
  setDocumentStatus(type: RegistrationDocumentType, status: RegistrationDocument['status']): void;
  setFaceCapture(capture: FaceCapture): void;
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

/** Lee el snapshot persistido (si existe) para rehidratar el store al crearse. */
function loadPersisted(): PersistedRegistration | null {
  return prefsStore.getObject<PersistedRegistration>(REGISTRATION_PREF_KEY) ?? null;
}

const persisted = loadPersisted();

/**
 * Store del wizard de registro (Zustand): única fuente de verdad del alta en la app. El estado del
 * wizard (datos de los 4 pasos + estado global) vive aquí; nunca en `setState` de componentes.
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
      });
      prefsStore.remove(REGISTRATION_PREF_KEY);
    },
  };
});
