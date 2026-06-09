import type {HttpClient} from '@veo/api-client';
import {createDriverHttpClient, type SessionTokenPort} from '../network/http';
import {createDriverSocket, type DriverSocket} from '../realtime/socket';
import {useSessionStore} from '../session/sessionStore';

import type {AuthRepository, LocalAuthService} from '../../features/auth/domain';
import {HttpAuthRepository, keychainLocalAuthService} from '../../features/auth/data';
import type {ShiftRepository, ForegroundServicePort} from '../../features/shift/domain';
import {HttpShiftRepository, nativeForegroundService} from '../../features/shift/data';
import type {TripsRepository} from '../../features/trips/domain';
import {HttpTripsRepository} from '../../features/trips/data';
import type {BiddingRepository} from '../../features/bidding/domain';
import {HttpBiddingRepository} from '../../features/bidding/data';
import type {EarningsRepository} from '../../features/earnings/domain';
import {HttpEarningsRepository} from '../../features/earnings/data';
import type {ProfileRepository} from '../../features/profile/domain';
import {HttpProfileRepository} from '../../features/profile/data';
import type {DocumentsRepository} from '../../features/documents/domain';
import {HttpDocumentsRepository} from '../../features/documents/data';
import type {RegistrationRepository} from '../../features/registration/domain';
import {HttpRegistrationRepository} from '../../features/registration/data';
import type {ChatRepository} from '../../features/chat/domain';
import {HttpChatRepository} from '../../features/chat/data';
import type {OpsRepository} from '../../features/ops/domain';
import {HttpOpsRepository} from '../../features/ops/data';
import type {SupportRepository} from '../../features/support/domain';
import {HttpSupportRepository} from '../../features/support/data';

/**
 * Repositorios registrados, tipados por su INTERFAZ de dominio (no por la implementación).
 * Los consumidores (hooks/use cases) dependen de estas abstracciones (principio D de SOLID).
 */
export interface AppRepositories {
  auth: AuthRepository;
  shift: ShiftRepository;
  trips: TripsRepository;
  bidding: BiddingRepository;
  earnings: EarningsRepository;
  profile: ProfileRepository;
  documents: DocumentsRepository;
  registration: RegistrationRepository;
  chat: ChatRepository;
  ops: OpsRepository;
  support: SupportRepository;
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
}

/**
 * Adaptador del puerto de tokens sobre el store de sesión Zustand. Lee el estado vivo en cada
 * llamada (`getState()`), por eso funciona también fuera de React (cliente HTTP / socket).
 */
const sessionTokenPort: SessionTokenPort = {
  getAccessToken: () => useSessionStore.getState().accessToken,
  getRefreshToken: () => useSessionStore.getState().refreshToken,
  setTokens: tokens => useSessionStore.getState().setTokens(tokens),
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
    bidding: new HttpBiddingRepository(httpClient),
    earnings: new HttpEarningsRepository(httpClient),
    profile: new HttpProfileRepository(httpClient),
    documents: new HttpDocumentsRepository(httpClient),
    registration: new HttpRegistrationRepository(httpClient),
    chat: new HttpChatRepository(httpClient),
    ops: new HttpOpsRepository(httpClient),
    support: new HttpSupportRepository(httpClient),
  };

  return {
    httpClient,
    createDriverSocket: () => createDriverSocket(sessionTokenPort),
    repositories,
    foregroundService: nativeForegroundService,
    localAuth: keychainLocalAuthService,
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
