import {HttpAuthRepository} from '../../features/auth/data/httpAuthRepository';
import {HttpConsentRepository} from '../../features/auth/data/httpConsentRepository';
import {MmkvPendingConsentStore} from '../../features/auth/data/mmkvPendingConsentStore';
import {SyncPendingConsentUseCase} from '../../features/auth/domain/syncPendingConsentUseCase';
import {KeychainLocalAuthService} from '../../features/auth/data/keychainLocalAuthService';
import {
  ForgotPasswordUseCase,
  LoginEmailUseCase,
  GetConsentUseCase,
  LoginWithAppleUseCase,
  LoginWithGoogleUseCase,
  RecordConsentUseCase,
  RegisterEmailUseCase,
  RequestOtpUseCase,
  ResendEmailUseCase,
  ResetPasswordUseCase,
  VerifyEmailUseCase,
  VerifyOtpUseCase,
} from '../../features/auth/domain/usecases';
import {HttpChatRepository} from '../../features/chat/data/httpChatRepository';
import {
  ListMessagesUseCase,
  SendMessageUseCase,
} from '../../features/chat/domain/usecases';
import {HttpContactsRepository} from '../../features/contacts/data/httpContactsRepository';
import {HttpDispatchRepository} from '../../features/dispatch/data/httpDispatchRepository';
import {GetNearbyVehiclesUseCase} from '../../features/dispatch/domain/usecases';
import {HttpKycRepository} from '../../features/kyc/data/httpKycRepository';
import {
  RequestKycChallengeUseCase,
  SubmitKycUseCase,
} from '../../features/kyc/domain/usecases';
import {HttpMapsRepository} from '../../features/maps/data/httpMapsRepository';
import {
  AutocompletePlacesUseCase,
  GetCatalogUseCase,
  QuoteRideUseCase,
  ReverseGeocodeUseCase,
} from '../../features/maps/domain/usecases';
import {HttpNotificationsRepository} from '../../features/notifications/data/httpNotificationsRepository';
import {ListNotificationsUseCase} from '../../features/notifications/domain/usecases';
import {HttpPushTokenRegistrar} from '../../features/notifications/data/httpPushTokenRegistrar';
import {LogPushTokenRegistrar} from '../../features/notifications/data/logPushTokenRegistrar';
import {
  AddContactUseCase,
  ListContactsUseCase,
  RemoveContactUseCase,
  ResendContactOtpUseCase,
  VerifyContactUseCase,
} from '../../features/contacts/domain/usecases';
import {HttpPanicRepository} from '../../features/panic/data/httpPanicRepository';
import {HttpPanicKeyRepository} from '../../features/panic/data/httpPanicKeyRepository';
import {NativePanicTrigger} from '../../features/panic/data/nativePanicTrigger';
import {KeychainPanicSecretProvisioner} from '../../features/panic/data/keychainPanicSecretProvisioner';
import {KeychainPanicSecretStore} from '../../features/panic/data/keychainPanicSecretStore';
import {KeychainPanicSigner} from '../../features/panic/data/keychainPanicSigner';
import {NavigationPanicEscalation} from '../../features/panic/data/navigationPanicEscalation';
import {SilentPanicDispatcher} from '../../features/panic/domain/silentPanicDispatcher';
import {TriggerPanicUseCase} from '../../features/panic/domain/usecases';
import {HttpPaymentsRepository} from '../../features/payments/data/httpPaymentsRepository';
import {HttpAffiliationRepository} from '../../features/payments/data/httpAffiliationRepository';
import {
  AddTipUseCase,
  ChangePaymentMethodUseCase,
  ChargeTripUseCase,
  ConfirmCashUseCase,
  GetMyDebtsUseCase,
  GetUserCreditUseCase,
  GetPaymentByTripUseCase,
  GetPaymentUseCase,
  RetryChargeUseCase,
} from '../../features/payments/domain/usecases';
import {
  CreateYapeAffiliationUseCase,
  GetYapeAffiliationUseCase,
  RevokeYapeAffiliationUseCase,
} from '../../features/payments/domain/affiliationUsecases';
import {HttpSavedPlacesRepository} from '../../features/places/data/httpPlacesRepository';
import {
  ListPlacesUseCase,
  RemovePlaceUseCase,
  SavePlaceUseCase,
  UpdatePlaceUseCase,
} from '../../features/places/domain/usecases';
import {HttpProfileRepository} from '../../features/profile/data/httpProfileRepository';
import {
  GetProfileUseCase,
  LogoutUseCase,
  RemoveAvatarUseCase,
  RequestAccountDeletionUseCase,
  RequestPhoneCodeUseCase,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  VerifyPhoneUseCase,
} from '../../features/profile/domain/usecases';
import {HttpPromosRepository} from '../../features/promos/data/httpPromosRepository';
import {ValidatePromoUseCase} from '../../features/promos/domain/usecases';
import {HttpRatingsRepository} from '../../features/ratings/data/httpRatingsRepository';
import {SubmitRatingUseCase} from '../../features/ratings/domain/usecases';
import {HttpSupportRepository} from '../../features/support/data/httpSupportRepository';
import {
  CreateTicketUseCase,
  ListTicketsUseCase,
} from '../../features/support/domain/usecases';
import {HttpReferralsRepository} from '../../features/referrals/data/httpReferralsRepository';
import {
  GetReferralSummaryUseCase,
  RedeemReferralUseCase,
} from '../../features/referrals/domain/usecases';
import {LocalTripHistoryRepository} from '../../features/trip/data/localTripHistoryRepository';
import {LocalCameraSharePreferenceRepository} from '../../features/trip/data/localCameraSharePreferenceRepository';
import {HttpTripRepository} from '../../features/trip/data/httpTripRepository';
import {
  GetCameraSharePreferenceUseCase,
  SaveCameraSharePreferenceUseCase,
} from '../../features/trip/domain/cameraShareUsecases';
import {
  AcceptOfferUseCase,
  CancelBidUseCase,
  CancelScheduledTripUseCase,
  CancelTripUseCase,
  ChangeDestinationUseCase,
  CloseTripUseCase,
  CreateTripUseCase,
  GetCabinVideoUseCase,
  GetMyActiveTripUseCase,
  GetPendingSettlementUseCase,
  GetSurgeUseCase,
  GetTripHistoryUseCase,
  ListOffersUseCase,
  ListScheduledTripsUseCase,
  RebidUseCase,
  RevokeShareUseCase,
  ShareTripUseCase,
} from '../../features/trip/domain/usecases';
import {BackgroundGeolocationLocationProvider} from '../../shared/location/data/backgroundGeolocationLocationProvider';
import {HttpAvatarUploader} from '../../shared/media/data/httpAvatarUploader';
import {NativeImagePickerService} from '../../shared/media/data/nativeImagePickerService';
import {env} from '../config/env';
import {httpClient} from '../network/http';
import {prefsStore} from '../storage/mmkv';
import {Container} from './container';
import {TOKENS} from './tokens';

/**
 * Construye y cablea el contenedor: infraestructura, repositorios (impl data bajo el token de su
 * abstracción domain), puertos para la oleada nativa (defaults explícitos, sin mocks) y casos de uso.
 * Resolución perezosa: nada se instancia hasta el primer `resolve`.
 */
import {setPaymentPrefsBackendSync} from '../../features/payments/presentation/stores/paymentPrefsStore';

export function buildContainer(): Container {
  const container = new Container();

  // Infraestructura: el cliente HTTP ya apunta al public-bff e inyecta el Bearer.
  container.register(TOKENS.httpClient, () => httpClient);

  // Repositorios HTTP (dependen del HttpClient resuelto del propio contenedor).
  container.register(
    TOKENS.authRepository,
    c => new HttpAuthRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.consentRepository,
    c => new HttpConsentRepository(c.resolve(TOKENS.httpClient)),
  );
  // Cola durable de consentimiento (Ley 29733) en MMKV (prefs, no sensible): la aceptación capturada
  // en el onboarding se persiste acá hasta que el backend la confirma (sobrevive a red caída / cierres).
  container.register(
    TOKENS.pendingConsentStore,
    () => new MmkvPendingConsentStore(prefsStore),
  );
  container.register(
    TOKENS.profileRepository,
    c => new HttpProfileRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.tripRepository,
    c => new HttpTripRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.panicRepository,
    c => new HttpPanicRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.panicKeyRepository,
    c => new HttpPanicKeyRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.paymentsRepository,
    c => new HttpPaymentsRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.affiliationRepository,
    c => new HttpAffiliationRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.ratingsRepository,
    c => new HttpRatingsRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.promosRepository,
    c => new HttpPromosRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.referralsRepository,
    c => new HttpReferralsRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.contactsRepository,
    c => new HttpContactsRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.chatRepository,
    c => new HttpChatRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.supportRepository,
    c => new HttpSupportRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.kycRepository,
    c => new HttpKycRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.mapsRepository,
    c => new HttpMapsRepository(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.dispatchRepository,
    c => new HttpDispatchRepository(c.resolve(TOKENS.httpClient)),
  );

  // Snapshot local de viajes en MMKV (prefs). YA NO es la fuente del HISTORIAL — eso ahora lo manda el
  // servidor vía `GET /trips/history` (getTripHistoryUseCase), con los ESTADOS REALES. Este snapshot solo
  // alimenta dos cosas que el listado del server no trae: (1) los DESTINOS RECIENTES del autocompletado
  // (Home/RequestFlow) y (2) la POLYLINE/coords del mapa del detalle (el history item trae origin/destination
  // pero no la polyline). Ver tripHistoryRepository.ts.
  container.register(
    TOKENS.tripHistoryRepository,
    () => new LocalTripHistoryRepository(prefsStore),
  );

  // Centro de avisos: HTTP REAL contra el public-bff (`GET /notifications`). El aviso llega YA
  // renderizado y categorizado por el notification-service; el repo solo mapea category→kind. El
  // recipientId lo deriva el BFF del JWT (anti-IDOR). Reemplazó al EmptyNotificationsRepository
  // (HUECO DE BACKEND cerrado) sin tocar dominio ni presentación. Sin leído/no-leído aún (MVP).
  container.register(
    TOKENS.notificationsRepository,
    c => new HttpNotificationsRepository(c.resolve(TOKENS.httpClient)),
  );

  // Lugares guardados: HTTP REAL contra el public-bff (`/places`, JwtAuthGuard) + caché MMKV
  // (read-through / write-through). El puerto del dominio es síncrono: el caché es la copia que se
  // sirve al instante y el HTTP la reconcilia en segundo plano (preserva el offline de la versión local).
  // Los hooks de reconciliación (refresco del store) se cablean en el bootstrap (`App`) para NO acoplar
  // la composición con la capa de presentación ni crear un ciclo registry↔store.
  container.register(
    TOKENS.placesRepository,
    c =>
      new HttpSavedPlacesRepository(c.resolve(TOKENS.httpClient), prefsStore),
  );

  // Preferencia de compartir cámara: LOCAL en MMKV (prefs) por HUECO DE BACKEND (no existe endpoint
  // "quién ve la cámara"; ver cameraShareRepository.ts). Cuando exista, se sustituye por una impl HTTP
  // bajo este mismo token sin tocar dominio ni presentación.
  container.register(
    TOKENS.cameraSharePreferenceRepository,
    () => new LocalCameraSharePreferenceRepository(prefsStore),
  );

  // Puertos para la OLEADA NATIVA: implementaciones nativas REALES.
  container.register(
    TOKENS.locationProvider,
    () => new BackgroundGeolocationLocationProvider(),
  );
  container.register(
    TOKENS.localAuthService,
    () => new KeychainLocalAuthService(),
  );
  // Selector de imágenes nativo (avatar): galería + cámara tras el puerto `ImagePickerService`.
  container.register(
    TOKENS.imagePickerService,
    () => new NativeImagePickerService(),
  );
  // Subida del avatar: ticket prefirmado por el BFF + PUT crudo directo a MinIO (sin Authorization).
  container.register(
    TOKENS.avatarUploader,
    c => new HttpAvatarUploader(c.resolve(TOKENS.httpClient)),
  );
  container.register(
    TOKENS.panicSecretStore,
    () => new KeychainPanicSecretStore(),
  );
  container.register(
    TOKENS.panicSigner,
    c => new KeychainPanicSigner(c.resolve(TOKENS.panicSecretStore)),
  );
  // Aprovisionador del secreto HMAC: descarga la clave del bff y la persiste en el almacén seguro.
  container.register(
    TOKENS.panicSecretProvisioner,
    c =>
      new KeychainPanicSecretProvisioner(
        c.resolve(TOKENS.panicKeyRepository),
        c.resolve(TOKENS.panicSecretStore),
      ),
  );
  container.register(TOKENS.panicTrigger, () => new NativePanicTrigger());
  // Registro de push REAL cuando hay Firebase; en sandbox sin credenciales, fallback de log.
  container.register(TOKENS.pushTokenRegistrar, c =>
    env.firebaseEnabled
      ? new HttpPushTokenRegistrar(c.resolve(TOKENS.httpClient))
      : new LogPushTokenRegistrar(),
  );

  // Casos de uso · Auth
  container.register(
    TOKENS.requestOtpUseCase,
    c => new RequestOtpUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.verifyOtpUseCase,
    c => new VerifyOtpUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.recordConsentUseCase,
    c => new RecordConsentUseCase(c.resolve(TOKENS.consentRepository)),
  );
  container.register(
    TOKENS.getConsentUseCase,
    c => new GetConsentUseCase(c.resolve(TOKENS.consentRepository)),
  );
  // Cola durable: drena la aceptación encolada al backend (backoff + dedupKey idempotente). Singleton
  // del contenedor: los reintentos sobreviven al desmontaje del onboarding y se reanudan en login/boot/
  // foreground. Delega el POST en RecordConsentUseCase (SRP: el reintento NO vive en el use case de POST).
  container.register(
    TOKENS.syncPendingConsentUseCase,
    c =>
      new SyncPendingConsentUseCase(
        c.resolve(TOKENS.recordConsentUseCase),
        c.resolve(TOKENS.pendingConsentStore),
      ),
  );
  // Casos de uso · Auth por correo (ADR-012)
  container.register(
    TOKENS.registerEmailUseCase,
    c => new RegisterEmailUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.resendEmailUseCase,
    c => new ResendEmailUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.verifyEmailUseCase,
    c => new VerifyEmailUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.loginEmailUseCase,
    c => new LoginEmailUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.forgotPasswordUseCase,
    c => new ForgotPasswordUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.resetPasswordUseCase,
    c => new ResetPasswordUseCase(c.resolve(TOKENS.authRepository)),
  );
  // Casos de uso · Login social nativo (OAuth)
  container.register(
    TOKENS.loginWithGoogleUseCase,
    c => new LoginWithGoogleUseCase(c.resolve(TOKENS.authRepository)),
  );
  container.register(
    TOKENS.loginWithAppleUseCase,
    c => new LoginWithAppleUseCase(c.resolve(TOKENS.authRepository)),
  );

  // Casos de uso · Trip
  container.register(
    TOKENS.getSurgeUseCase,
    c => new GetSurgeUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.getMyActiveTripUseCase,
    c => new GetMyActiveTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.getPendingSettlementUseCase,
    c => new GetPendingSettlementUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.closeTripUseCase,
    c => new CloseTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.createTripUseCase,
    c => new CreateTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.cancelTripUseCase,
    c => new CancelTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.changeDestinationUseCase,
    c => new ChangeDestinationUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.getCabinVideoUseCase,
    c => new GetCabinVideoUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.getTripHistoryUseCase,
    c => new GetTripHistoryUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.listScheduledTripsUseCase,
    c => new ListScheduledTripsUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.cancelScheduledTripUseCase,
    c => new CancelScheduledTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.shareTripUseCase,
    c => new ShareTripUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.revokeShareUseCase,
    c => new RevokeShareUseCase(c.resolve(TOKENS.tripRepository)),
  );
  // Casos de uso · Preferencia de compartir cámara (CameraControl)
  container.register(
    TOKENS.getCameraSharePreferenceUseCase,
    c =>
      new GetCameraSharePreferenceUseCase(
        c.resolve(TOKENS.cameraSharePreferenceRepository),
      ),
  );
  container.register(
    TOKENS.saveCameraSharePreferenceUseCase,
    c =>
      new SaveCameraSharePreferenceUseCase(
        c.resolve(TOKENS.cameraSharePreferenceRepository),
      ),
  );
  // Casos de uso · Trip · PUJA
  container.register(
    TOKENS.listOffersUseCase,
    c => new ListOffersUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.acceptOfferUseCase,
    c => new AcceptOfferUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.cancelBidUseCase,
    c => new CancelBidUseCase(c.resolve(TOKENS.tripRepository)),
  );
  container.register(
    TOKENS.rebidUseCase,
    c => new RebidUseCase(c.resolve(TOKENS.tripRepository)),
  );

  // Casos de uso · Maps
  container.register(
    TOKENS.autocompletePlacesUseCase,
    c => new AutocompletePlacesUseCase(c.resolve(TOKENS.mapsRepository)),
  );
  container.register(
    TOKENS.reverseGeocodeUseCase,
    c => new ReverseGeocodeUseCase(c.resolve(TOKENS.mapsRepository)),
  );
  container.register(
    TOKENS.quoteRideUseCase,
    c => new QuoteRideUseCase(c.resolve(TOKENS.mapsRepository)),
  );
  container.register(
    TOKENS.getCatalogUseCase,
    c => new GetCatalogUseCase(c.resolve(TOKENS.mapsRepository)),
  );

  // Casos de uso · Dispatch (vehículos cercanos de ambiente)
  container.register(
    TOKENS.getNearbyVehiclesUseCase,
    c => new GetNearbyVehiclesUseCase(c.resolve(TOKENS.dispatchRepository)),
  );

  // Casos de uso · Panic (orquesta repo + ubicación + firma)
  container.register(
    TOKENS.triggerPanicUseCase,
    c =>
      new TriggerPanicUseCase(
        c.resolve(TOKENS.panicRepository),
        c.resolve(TOKENS.locationProvider),
        c.resolve(TOKENS.panicSigner),
        c.resolve(TOKENS.panicSecretProvisioner),
      ),
  );
  // Escalamiento del pánico silencioso fallido: navega a la pantalla manual (canal visible).
  container.register(
    TOKENS.panicEscalation,
    () => new NavigationPanicEscalation(),
  );
  // Entrega at-least-once del disparo SILENCIOSO (singleton del contenedor: los reintentos con
  // backoff + dedupKey idempotente sobreviven al desmontaje de la pantalla que armó el detector).
  container.register(
    TOKENS.silentPanicDispatcher,
    c =>
      new SilentPanicDispatcher(
        c.resolve(TOKENS.triggerPanicUseCase),
        c.resolve(TOKENS.panicEscalation),
      ),
  );

  // Casos de uso · Contacts
  container.register(
    TOKENS.listContactsUseCase,
    c => new ListContactsUseCase(c.resolve(TOKENS.contactsRepository)),
  );
  container.register(
    TOKENS.addContactUseCase,
    c => new AddContactUseCase(c.resolve(TOKENS.contactsRepository)),
  );
  container.register(
    TOKENS.verifyContactUseCase,
    c => new VerifyContactUseCase(c.resolve(TOKENS.contactsRepository)),
  );
  container.register(
    TOKENS.resendContactOtpUseCase,
    c => new ResendContactOtpUseCase(c.resolve(TOKENS.contactsRepository)),
  );
  container.register(
    TOKENS.removeContactUseCase,
    c => new RemoveContactUseCase(c.resolve(TOKENS.contactsRepository)),
  );

  // Casos de uso · KYC
  container.register(
    TOKENS.requestKycChallengeUseCase,
    c => new RequestKycChallengeUseCase(c.resolve(TOKENS.kycRepository)),
  );
  container.register(
    TOKENS.submitKycUseCase,
    c => new SubmitKycUseCase(c.resolve(TOKENS.kycRepository)),
  );

  // Casos de uso · Payments
  container.register(
    TOKENS.chargeTripUseCase,
    c => new ChargeTripUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.confirmCashUseCase,
    c => new ConfirmCashUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.addTipUseCase,
    c => new AddTipUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.getPaymentByTripUseCase,
    c => new GetPaymentByTripUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.getPaymentUseCase,
    c => new GetPaymentUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  // Casos de uso · Deuda (BR-P02: saldar para volver a pedir)
  container.register(
    TOKENS.getMyDebtsUseCase,
    c => new GetMyDebtsUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.getUserCreditUseCase,
    c => new GetUserCreditUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  container.register(
    TOKENS.retryChargeUseCase,
    c => new RetryChargeUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  // Caso de uso · Cambiar el método de un pago PENDIENTE a otro DIGITAL (TASK 3)
  container.register(
    TOKENS.changePaymentMethodUseCase,
    c => new ChangePaymentMethodUseCase(c.resolve(TOKENS.paymentsRepository)),
  );
  // Casos de uso · Afiliación Yape On File (cobro automático)
  container.register(
    TOKENS.getYapeAffiliationUseCase,
    c => new GetYapeAffiliationUseCase(c.resolve(TOKENS.affiliationRepository)),
  );
  container.register(
    TOKENS.createYapeAffiliationUseCase,
    c =>
      new CreateYapeAffiliationUseCase(c.resolve(TOKENS.affiliationRepository)),
  );
  container.register(
    TOKENS.revokeYapeAffiliationUseCase,
    c =>
      new RevokeYapeAffiliationUseCase(c.resolve(TOKENS.affiliationRepository)),
  );

  // Casos de uso · Places (lugares guardados · HTTP /places + caché MMKV)
  container.register(
    TOKENS.listPlacesUseCase,
    c => new ListPlacesUseCase(c.resolve(TOKENS.placesRepository)),
  );
  container.register(
    TOKENS.savePlaceUseCase,
    c => new SavePlaceUseCase(c.resolve(TOKENS.placesRepository)),
  );
  container.register(
    TOKENS.updatePlaceUseCase,
    c => new UpdatePlaceUseCase(c.resolve(TOKENS.placesRepository)),
  );
  container.register(
    TOKENS.removePlaceUseCase,
    c => new RemovePlaceUseCase(c.resolve(TOKENS.placesRepository)),
  );

  // Casos de uso · Ratings
  container.register(
    TOKENS.submitRatingUseCase,
    c => new SubmitRatingUseCase(c.resolve(TOKENS.ratingsRepository)),
  );

  // Casos de uso · Support (Centro de Ayuda)
  container.register(
    TOKENS.createTicketUseCase,
    c => new CreateTicketUseCase(c.resolve(TOKENS.supportRepository)),
  );
  container.register(
    TOKENS.listTicketsUseCase,
    c => new ListTicketsUseCase(c.resolve(TOKENS.supportRepository)),
  );

  // Casos de uso · Chat
  container.register(
    TOKENS.listMessagesUseCase,
    c => new ListMessagesUseCase(c.resolve(TOKENS.chatRepository)),
  );
  container.register(
    TOKENS.sendMessageUseCase,
    c => new SendMessageUseCase(c.resolve(TOKENS.chatRepository)),
  );

  // Casos de uso · Notificaciones (centro de avisos)
  container.register(
    TOKENS.listNotificationsUseCase,
    c =>
      new ListNotificationsUseCase(c.resolve(TOKENS.notificationsRepository)),
  );

  // Casos de uso · Promos
  container.register(
    TOKENS.validatePromoUseCase,
    c => new ValidatePromoUseCase(c.resolve(TOKENS.promosRepository)),
  );

  // Casos de uso · Referrals
  container.register(
    TOKENS.getReferralSummaryUseCase,
    c => new GetReferralSummaryUseCase(c.resolve(TOKENS.referralsRepository)),
  );
  container.register(
    TOKENS.redeemReferralUseCase,
    c => new RedeemReferralUseCase(c.resolve(TOKENS.referralsRepository)),
  );

  // Casos de uso · Profile
  container.register(
    TOKENS.getProfileUseCase,
    c => new GetProfileUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.updateProfileUseCase,
    c => new UpdateProfileUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.uploadAvatarUseCase,
    c =>
      new UploadAvatarUseCase(
        c.resolve(TOKENS.avatarUploader),
        c.resolve(TOKENS.profileRepository),
      ),
  );
  container.register(
    TOKENS.removeAvatarUseCase,
    c => new RemoveAvatarUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.requestPhoneCodeUseCase,
    c => new RequestPhoneCodeUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.verifyPhoneUseCase,
    c => new VerifyPhoneUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.requestAccountDeletionUseCase,
    c => new RequestAccountDeletionUseCase(c.resolve(TOKENS.profileRepository)),
  );
  container.register(
    TOKENS.logoutUseCase,
    c => new LogoutUseCase(c.resolve(TOKENS.authRepository)),
  );

  return container;
}

/** Contenedor singleton de la app. */
export const container = buildContainer();

// Cablea el push best-effort del método de pago por defecto al backend (perfil). El store de
// preferencias es offline-first (MMKV) y libre de dependencias; acá, en el composition root, le
// inyectamos CÓMO sincronizar al backend (PATCH /users/me vía el caso de uso de perfil). Si el PATCH
// falla, el valor local ya quedó persistido (degradación honesta) y se reintenta al próximo cambio.
setPaymentPrefsBackendSync(method => {
  void container
    .resolve(TOKENS.updateProfileUseCase)
    .execute({defaultPaymentMethod: method})
    .catch(() => {});
});
