import type { HttpClient } from '@veo/api-client';
import { createDriverHttpClient, type SessionTokenPort } from '../network/http';
import { createDriverSocket, type DriverSocket } from '../realtime/socket';
import { useSessionStore } from '../session/sessionStore';

import type { AuthRepository, LocalAuthService } from '../../features/auth/domain';
import { HttpAuthRepository, keychainLocalAuthService } from '../../features/auth/data';
import type { ShiftRepository, ForegroundServicePort } from '../../features/shift/domain';
import { HttpShiftRepository, nativeForegroundService } from '../../features/shift/data';
import type { TripsRepository } from '../../features/trips/domain';
import { HttpTripsRepository } from '../../features/trips/data';
import type { RatingsRepository } from '../../features/ratings/domain';
import { HttpRatingsRepository } from '../../features/ratings/data';
import type { BiddingRepository } from '../../features/bidding/domain';
import { HttpBiddingRepository } from '../../features/bidding/data';
import type { EarningsRepository } from '../../features/earnings/domain';
import { HttpEarningsRepository } from '../../features/earnings/data';
import type { CarpoolRepository } from '../../features/carpool/domain';
import { HttpCarpoolRepository } from '../../features/carpool/data';
import type { MapsRepository } from '../../features/maps/domain';
import { HttpMapsRepository } from '../../features/maps/data';
import type { ProfileRepository } from '../../features/profile/domain';
import { HttpProfileRepository } from '../../features/profile/data';
import type {
  DocumentsRepository,
  DocumentScannerService,
  DocumentUploader,
  ImagePickerService,
} from '../../features/documents/domain';
import {
  HttpDocumentsRepository,
  HttpDocumentUploader,
  nativeDocumentScanner,
  nativeImagePickerService,
} from '../../features/documents/data';
import type { RegistrationRepository } from '../../features/registration/domain';
import { HttpRegistrationRepository } from '../../features/registration/data';
import type { ChatRepository } from '../../features/chat/domain';
import { HttpChatRepository } from '../../features/chat/data';
import type { OpsRepository } from '../../features/ops/domain';
import { HttpOpsRepository } from '../../features/ops/data';
import type { SupportRepository } from '../../features/support/domain';
import { HttpSupportRepository } from '../../features/support/data';
import type { NotificationsRepository } from '../../features/notifications/domain';
import { HttpNotificationsRepository } from '../../features/notifications/data';

/**
 * Repositorios registrados, tipados por su INTERFAZ de dominio (no por la implementación).
 * Los consumidores (hooks/use cases) dependen de estas abstracciones (principio D de SOLID).
 */
export interface AppRepositories {
  auth: AuthRepository;
  shift: ShiftRepository;
  trips: TripsRepository;
  ratings: RatingsRepository;
  bidding: BiddingRepository;
  earnings: EarningsRepository;
  carpool: CarpoolRepository;
  maps: MapsRepository;
  profile: ProfileRepository;
  documents: DocumentsRepository;
  registration: RegistrationRepository;
  chat: ChatRepository;
  ops: OpsRepository;
  support: SupportRepository;
  notifications: NotificationsRepository;
}

/** Contenedor de inyección de dependencias de la app (service locator manual, tipado y ligero). */
export interface AppContainer {
  /** Cliente HTTP del driver-bff (Bearer + refresh). */
  httpClient: HttpClient;
  /** Fábrica del socket `/driver` (se conecta bajo demanda en presentación). */
  createDriverSocket: () => DriverSocket;
  /** Repositorios por feature, expuestos por su interfaz. */
  repositories: AppRepositories;
  /** Foreground Service del turno/viaje (Android obligatorio; no-op en iOS). */
  foregroundService: ForegroundServicePort;
  /** Re-login biométrico local (Face ID/huella) sobre Keychain/Keystore. */
  localAuth: LocalAuthService;
  /** Subida del binario de documentos: presign por el BFF + PUT crudo directo al almacén soberano. */
  documentUploader: DocumentUploader;
  /** Captura/selección de imagen (cámara o galería) para el binario de documentos. */
  imagePicker: ImagePickerService;
  /** Escáner nativo de documentos (bordes + auto-captura + corrección) para el binario de documentos. */
  documentScanner: DocumentScannerService;
}

/**
 * Adaptador del puerto de tokens sobre el store de sesión Zustand. Lee el estado vivo en cada
 * llamada (`getState()`), por eso funciona también fuera de React (cliente HTTP / socket).
 */
const sessionTokenPort: SessionTokenPort = {
  getAccessToken: () => useSessionStore.getState().accessToken,
  getRefreshToken: () => useSessionStore.getState().refreshToken,
  setTokens: async (tokens) => {
    // 1) MMKV + estado (fuente de la sesión de la app).
    useSessionStore.getState().setTokens(tokens);
    // 2) Keychain biométrico: SOLO si el relogin ya está habilitado (hay token guardado) — así una rotación
    // background por 401 lo mantiene en sync (sin este paso el Keychain conservaba el jti VIEJO → el próximo
    // relogin biométrico presentaba un jti ya rotado → reuse-detection mataba la familia). NO se crea una
    // entrada para usuarios que no usan biometría. Best-effort + observable: un fallo deja el Keychain stale
    // (el relogin cae a OTP), lo logueamos para diagnóstico, no rompe la rotación.
    try {
      if (await keychainLocalAuthService.hasStoredToken()) {
        await keychainLocalAuthService.saveRefreshToken(tokens.refreshToken);
      }
    } catch (err) {
      console.warn(
        '[session] no se pudo sincronizar el refresh token biométrico tras la rotación:',
        err,
      );
    }
  },
  // El cliente HTTP llama a `clearSession` cuando el refresh falla: lo tratamos como EXPIRACIÓN
  // (no logout) para que la capa de presentación muestre la pantalla de re-login.
  clearSession: () => useSessionStore.getState().expireSession(),
};

function buildContainer(): AppContainer {
  const httpClient = createDriverHttpClient(sessionTokenPort);

  const repositories: AppRepositories = {
    auth: new HttpAuthRepository(httpClient),
    shift: new HttpShiftRepository(httpClient),
    trips: new HttpTripsRepository(httpClient),
    ratings: new HttpRatingsRepository(httpClient),
    bidding: new HttpBiddingRepository(httpClient),
    earnings: new HttpEarningsRepository(httpClient),
    carpool: new HttpCarpoolRepository(httpClient),
    maps: new HttpMapsRepository(httpClient),
    profile: new HttpProfileRepository(httpClient),
    documents: new HttpDocumentsRepository(httpClient),
    registration: new HttpRegistrationRepository(httpClient),
    chat: new HttpChatRepository(httpClient),
    ops: new HttpOpsRepository(httpClient),
    support: new HttpSupportRepository(httpClient),
    notifications: new HttpNotificationsRepository(httpClient),
  };

  return {
    httpClient,
    createDriverSocket: () => createDriverSocket(sessionTokenPort),
    repositories,
    foregroundService: nativeForegroundService,
    localAuth: keychainLocalAuthService,
    // El uploader usa el MISMO httpClient autenticado SOLO para el presign; el PUT del binario va
    // por `fetch` crudo (sin el Bearer del BFF) que el uploader inyecta por defecto.
    documentUploader: new HttpDocumentUploader(httpClient),
    imagePicker: nativeImagePickerService,
    documentScanner: nativeDocumentScanner,
  };
}

let instance: AppContainer | null = null;

/** Devuelve el contenedor singleton (lo construye en el primer acceso). */
export function getContainer(): AppContainer {
  if (!instance) {
    instance = buildContainer();
  }
  return instance;
}

/** Reinicia el contenedor. Uso exclusivo en pruebas. */
export function resetContainer(): void {
  instance = null;
}
