import type { HttpClient } from '@veo/api-client';
import type { AuthRepository } from '../../features/auth/domain/authRepository';
import type { ConsentRepository } from '../../features/auth/domain/consentRepository';
import type { PendingConsentStore } from '../../features/auth/domain/pendingConsent';
import type { SyncPendingConsentUseCase } from '../../features/auth/domain/syncPendingConsentUseCase';
import type { LocalAuthService } from '../../features/auth/domain/localAuthService';
import type {
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
import type { ChatRepository } from '../../features/chat/domain/chatRepository';
import type {
  ListMessagesUseCase,
  SendMessageUseCase,
} from '../../features/chat/domain/usecases';
import type { ContactsRepository } from '../../features/contacts/domain/contactsRepository';
import type { KycRepository } from '../../features/kyc/domain/kycRepository';
import type {
  RequestKycChallengeUseCase,
  SubmitKycUseCase,
} from '../../features/kyc/domain/usecases';
import type { NotificationsRepository } from '../../features/notifications/domain/notificationsRepository';
import type { ListNotificationsUseCase } from '../../features/notifications/domain/usecases';
import type { PushTokenRegistrar } from '../../features/notifications/domain/pushTokenRegistrar';
import type { PanicSecretStore } from '../../features/panic/domain/panicSecretStore';
import type {
  AddContactUseCase,
  ListContactsUseCase,
  RemoveContactUseCase,
  ResendContactOtpUseCase,
  VerifyContactUseCase,
} from '../../features/contacts/domain/usecases';
import type { PanicEscalation } from '../../features/panic/domain/panicEscalation';
import type { PanicKeyRepository } from '../../features/panic/domain/panicKeyRepository';
import type { PanicRepository } from '../../features/panic/domain/panicRepository';
import type { PanicSecretProvisioner } from '../../features/panic/domain/panicSecretProvisioner';
import type { PanicSigner } from '../../features/panic/domain/panicSigner';
import type { PanicTrigger } from '../../features/panic/domain/panicTrigger';
import type { SilentPanicDispatcher } from '../../features/panic/domain/silentPanicDispatcher';
import type { TriggerPanicUseCase } from '../../features/panic/domain/usecases';
import type { PaymentsRepository } from '../../features/payments/domain/paymentsRepository';
import type { AffiliationRepository } from '../../features/payments/domain/affiliationRepository';
import type {
  CreateYapeAffiliationUseCase,
  GetYapeAffiliationUseCase,
  RevokeYapeAffiliationUseCase,
} from '../../features/payments/domain/affiliationUsecases';
import type { PlacesRepository } from '../../features/places/domain/placesRepository';
import type {
  ListPlacesUseCase,
  RemovePlaceUseCase,
  SavePlaceUseCase,
  UpdatePlaceUseCase,
} from '../../features/places/domain/usecases';
import type {
  AddTipUseCase,
  ChangePaymentMethodUseCase,
  ChargeTripUseCase,
  ConfirmCashUseCase,
  GetMyDebtsUseCase,
  GetPaymentByTripUseCase,
  GetPaymentUseCase,
  GetUserCreditUseCase,
  RetryChargeUseCase,
} from '../../features/payments/domain/usecases';
import type { ProfileRepository } from '../../features/profile/domain/profileRepository';
import type { PromosRepository } from '../../features/promos/domain/promosRepository';
import type { ValidatePromoUseCase } from '../../features/promos/domain/usecases';
import type {
  GetProfileUseCase,
  LogoutUseCase,
  RemoveAvatarUseCase,
  RequestAccountDeletionUseCase,
  RequestPhoneCodeUseCase,
  UpdateProfileUseCase,
  UploadAvatarUseCase,
  VerifyPhoneUseCase,
} from '../../features/profile/domain/usecases';
import type { RatingsRepository } from '../../features/ratings/domain/ratingsRepository';
import type { SubmitRatingUseCase } from '../../features/ratings/domain/usecases';
import type { SupportRepository } from '../../features/support/domain/supportRepository';
import type {
  CreateTicketUseCase,
  ListTicketsUseCase,
} from '../../features/support/domain/usecases';
import type { ReferralsRepository } from '../../features/referrals/domain/referralsRepository';
import type {
  GetReferralSummaryUseCase,
  RedeemReferralUseCase,
} from '../../features/referrals/domain/usecases';
import type { DispatchRepository } from '../../features/dispatch/domain/dispatchRepository';
import type { GetNearbyVehiclesUseCase } from '../../features/dispatch/domain/usecases';
import type { CameraSharePreferenceRepository } from '../../features/trip/domain/cameraShareRepository';
import type {
  GetCameraSharePreferenceUseCase,
  SaveCameraSharePreferenceUseCase,
} from '../../features/trip/domain/cameraShareUsecases';
import type { TripHistoryRepository } from '../../features/trip/domain/tripHistoryRepository';
import type { TripRepository } from '../../features/trip/domain/tripRepository';
import type {
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
import type { MapsRepository } from '../../features/maps/domain/mapsRepository';
import type {
  AutocompletePlacesUseCase,
  GetCatalogUseCase,
  QuoteRideUseCase,
  ReverseGeocodeUseCase,
} from '../../features/maps/domain/usecases';
import type { LocationProvider } from '../../shared/location/domain/locationProvider';
import type { AvatarUploader } from '../../shared/media/domain/avatarUploader';
import type { ImagePickerService } from '../../shared/media/domain/imagePickerService';
import { createToken } from './container';

/**
 * Tokens tipados del contenedor. Cada token "transporta" el tipo de la ABSTRACCIÓN
 * (interfaz de repositorio, puerto o caso de uso), nunca el de la implementación concreta (DIP).
 */
export const TOKENS = {
  // Infraestructura
  httpClient: createToken<HttpClient>('HttpClient'),

  // Repositorios (interfaces en domain, impl en data)
  authRepository: createToken<AuthRepository>('AuthRepository'),
  consentRepository: createToken<ConsentRepository>('ConsentRepository'),
  // Cola durable de consentimiento (Ley 29733) en MMKV: persiste la aceptación hasta confirmarla.
  pendingConsentStore: createToken<PendingConsentStore>('PendingConsentStore'),
  profileRepository: createToken<ProfileRepository>('ProfileRepository'),
  tripRepository: createToken<TripRepository>('TripRepository'),
  tripHistoryRepository: createToken<TripHistoryRepository>('TripHistoryRepository'),
  // Preferencia de compartir cámara (LOCAL · hueco de backend, ver cameraShareRepository.ts).
  cameraSharePreferenceRepository: createToken<CameraSharePreferenceRepository>(
    'CameraSharePreferenceRepository',
  ),
  mapsRepository: createToken<MapsRepository>('MapsRepository'),
  // Dispatch: vehículos cercanos anónimos (ambiente del mapa en idle/searching).
  dispatchRepository: createToken<DispatchRepository>('DispatchRepository'),
  panicRepository: createToken<PanicRepository>('PanicRepository'),
  panicKeyRepository: createToken<PanicKeyRepository>('PanicKeyRepository'),
  paymentsRepository: createToken<PaymentsRepository>('PaymentsRepository'),
  affiliationRepository: createToken<AffiliationRepository>('AffiliationRepository'),
  promosRepository: createToken<PromosRepository>('PromosRepository'),
  placesRepository: createToken<PlacesRepository>('PlacesRepository'),
  ratingsRepository: createToken<RatingsRepository>('RatingsRepository'),
  supportRepository: createToken<SupportRepository>('SupportRepository'),
  referralsRepository: createToken<ReferralsRepository>('ReferralsRepository'),
  contactsRepository: createToken<ContactsRepository>('ContactsRepository'),
  chatRepository: createToken<ChatRepository>('ChatRepository'),
  // Centro de avisos (LOCAL · hueco de backend: no hay listado en el bff, ver
  // notificationsRepository.ts). Impl actual: feed vacío honesto.
  notificationsRepository: createToken<NotificationsRepository>('NotificationsRepository'),
  kycRepository: createToken<KycRepository>('KycRepository'),

  // Puertos para la OLEADA NATIVA (implementaciones nativas reales)
  locationProvider: createToken<LocationProvider>('LocationProvider'),
  imagePickerService: createToken<ImagePickerService>('ImagePickerService'),
  avatarUploader: createToken<AvatarUploader>('AvatarUploader'),
  localAuthService: createToken<LocalAuthService>('LocalAuthService'),
  panicSigner: createToken<PanicSigner>('PanicSigner'),
  panicTrigger: createToken<PanicTrigger>('PanicTrigger'),
  panicSecretStore: createToken<PanicSecretStore>('PanicSecretStore'),
  panicSecretProvisioner: createToken<PanicSecretProvisioner>('PanicSecretProvisioner'),
  // Escalamiento del pánico silencioso fallido al canal visible (navegación a la pantalla manual).
  panicEscalation: createToken<PanicEscalation>('PanicEscalation'),
  pushTokenRegistrar: createToken<PushTokenRegistrar>('PushTokenRegistrar'),

  // Casos de uso · Auth
  requestOtpUseCase: createToken<RequestOtpUseCase>('RequestOtpUseCase'),
  verifyOtpUseCase: createToken<VerifyOtpUseCase>('VerifyOtpUseCase'),
  recordConsentUseCase: createToken<RecordConsentUseCase>('RecordConsentUseCase'),
  getConsentUseCase: createToken<GetConsentUseCase>('GetConsentUseCase'),
  // Cola durable: drena la aceptación encolada al backend con backoff + dedupKey idempotente
  // (singleton: los reintentos sobreviven al desmontaje de la pantalla que la encoló).
  syncPendingConsentUseCase: createToken<SyncPendingConsentUseCase>('SyncPendingConsentUseCase'),
  // Casos de uso · Auth por correo (ADR-012)
  registerEmailUseCase: createToken<RegisterEmailUseCase>('RegisterEmailUseCase'),
  resendEmailUseCase: createToken<ResendEmailUseCase>('ResendEmailUseCase'),
  verifyEmailUseCase: createToken<VerifyEmailUseCase>('VerifyEmailUseCase'),
  loginEmailUseCase: createToken<LoginEmailUseCase>('LoginEmailUseCase'),
  forgotPasswordUseCase: createToken<ForgotPasswordUseCase>('ForgotPasswordUseCase'),
  resetPasswordUseCase: createToken<ResetPasswordUseCase>('ResetPasswordUseCase'),
  // Casos de uso · Login social nativo (OAuth)
  loginWithGoogleUseCase: createToken<LoginWithGoogleUseCase>('LoginWithGoogleUseCase'),
  loginWithAppleUseCase: createToken<LoginWithAppleUseCase>('LoginWithAppleUseCase'),

  // Casos de uso · Trip
  getSurgeUseCase: createToken<GetSurgeUseCase>('GetSurgeUseCase'),
  getMyActiveTripUseCase: createToken<GetMyActiveTripUseCase>('GetMyActiveTripUseCase'),
  getPendingSettlementUseCase: createToken<GetPendingSettlementUseCase>(
    'GetPendingSettlementUseCase',
  ),
  closeTripUseCase: createToken<CloseTripUseCase>('CloseTripUseCase'),
  createTripUseCase: createToken<CreateTripUseCase>('CreateTripUseCase'),
  cancelTripUseCase: createToken<CancelTripUseCase>('CancelTripUseCase'),
  changeDestinationUseCase: createToken<ChangeDestinationUseCase>('ChangeDestinationUseCase'),
  getCabinVideoUseCase: createToken<GetCabinVideoUseCase>('GetCabinVideoUseCase'),
  getTripHistoryUseCase: createToken<GetTripHistoryUseCase>('GetTripHistoryUseCase'),
  listScheduledTripsUseCase: createToken<ListScheduledTripsUseCase>('ListScheduledTripsUseCase'),
  cancelScheduledTripUseCase: createToken<CancelScheduledTripUseCase>('CancelScheduledTripUseCase'),
  shareTripUseCase: createToken<ShareTripUseCase>('ShareTripUseCase'),
  revokeShareUseCase: createToken<RevokeShareUseCase>('RevokeShareUseCase'),
  // Casos de uso · Preferencia de compartir cámara (CameraControl)
  getCameraSharePreferenceUseCase: createToken<GetCameraSharePreferenceUseCase>(
    'GetCameraSharePreferenceUseCase',
  ),
  saveCameraSharePreferenceUseCase: createToken<SaveCameraSharePreferenceUseCase>(
    'SaveCameraSharePreferenceUseCase',
  ),
  // Casos de uso · Trip · PUJA (board de ofertas)
  listOffersUseCase: createToken<ListOffersUseCase>('ListOffersUseCase'),
  acceptOfferUseCase: createToken<AcceptOfferUseCase>('AcceptOfferUseCase'),
  cancelBidUseCase: createToken<CancelBidUseCase>('CancelBidUseCase'),
  rebidUseCase: createToken<RebidUseCase>('RebidUseCase'),

  // Casos de uso · Maps
  autocompletePlacesUseCase: createToken<AutocompletePlacesUseCase>('AutocompletePlacesUseCase'),
  reverseGeocodeUseCase: createToken<ReverseGeocodeUseCase>('ReverseGeocodeUseCase'),
  quoteRideUseCase: createToken<QuoteRideUseCase>('QuoteRideUseCase'),
  getCatalogUseCase: createToken<GetCatalogUseCase>('GetCatalogUseCase'),

  // Casos de uso · Dispatch (vehículos cercanos de ambiente)
  getNearbyVehiclesUseCase: createToken<GetNearbyVehiclesUseCase>('GetNearbyVehiclesUseCase'),

  // Casos de uso · Panic
  triggerPanicUseCase: createToken<TriggerPanicUseCase>('TriggerPanicUseCase'),
  // Entrega at-least-once del disparo SILENCIOSO (singleton: los reintentos sobreviven al unmount).
  silentPanicDispatcher: createToken<SilentPanicDispatcher>('SilentPanicDispatcher'),

  // Casos de uso · Contacts
  listContactsUseCase: createToken<ListContactsUseCase>('ListContactsUseCase'),
  addContactUseCase: createToken<AddContactUseCase>('AddContactUseCase'),
  verifyContactUseCase: createToken<VerifyContactUseCase>('VerifyContactUseCase'),
  resendContactOtpUseCase: createToken<ResendContactOtpUseCase>('ResendContactOtpUseCase'),
  removeContactUseCase: createToken<RemoveContactUseCase>('RemoveContactUseCase'),

  // Casos de uso · KYC
  requestKycChallengeUseCase: createToken<RequestKycChallengeUseCase>(
    'RequestKycChallengeUseCase',
  ),
  submitKycUseCase: createToken<SubmitKycUseCase>('SubmitKycUseCase'),

  // Casos de uso · Payments
  chargeTripUseCase: createToken<ChargeTripUseCase>('ChargeTripUseCase'),
  confirmCashUseCase: createToken<ConfirmCashUseCase>('ConfirmCashUseCase'),
  addTipUseCase: createToken<AddTipUseCase>('AddTipUseCase'),
  getPaymentByTripUseCase: createToken<GetPaymentByTripUseCase>('GetPaymentByTripUseCase'),
  getPaymentUseCase: createToken<GetPaymentUseCase>('GetPaymentUseCase'),
  // Casos de uso · Payments · Deuda (gate BR-P02: saldar para volver a pedir)
  getMyDebtsUseCase: createToken<GetMyDebtsUseCase>('GetMyDebtsUseCase'),
  // Caso de uso · Payments · Saldo de crédito gastable del pasajero (referidos · Ola 2A)
  getUserCreditUseCase: createToken<GetUserCreditUseCase>('GetUserCreditUseCase'),
  retryChargeUseCase: createToken<RetryChargeUseCase>('RetryChargeUseCase'),
  // Caso de uso · Payments · Cambiar el método de un pago PENDIENTE a otro DIGITAL (TASK 3)
  changePaymentMethodUseCase: createToken<ChangePaymentMethodUseCase>(
    'ChangePaymentMethodUseCase',
  ),
  // Casos de uso · Payments · Afiliación Yape On File (cobro automático)
  getYapeAffiliationUseCase: createToken<GetYapeAffiliationUseCase>('GetYapeAffiliationUseCase'),
  createYapeAffiliationUseCase: createToken<CreateYapeAffiliationUseCase>(
    'CreateYapeAffiliationUseCase',
  ),
  revokeYapeAffiliationUseCase: createToken<RevokeYapeAffiliationUseCase>(
    'RevokeYapeAffiliationUseCase',
  ),

  // Casos de uso · Places (lugares guardados · HTTP /places + caché MMKV)
  listPlacesUseCase: createToken<ListPlacesUseCase>('ListPlacesUseCase'),
  savePlaceUseCase: createToken<SavePlaceUseCase>('SavePlaceUseCase'),
  updatePlaceUseCase: createToken<UpdatePlaceUseCase>('UpdatePlaceUseCase'),
  removePlaceUseCase: createToken<RemovePlaceUseCase>('RemovePlaceUseCase'),

  // Casos de uso · Ratings
  submitRatingUseCase: createToken<SubmitRatingUseCase>('SubmitRatingUseCase'),

  // Casos de uso · Support (Centro de Ayuda)
  createTicketUseCase: createToken<CreateTicketUseCase>('CreateTicketUseCase'),
  listTicketsUseCase: createToken<ListTicketsUseCase>('ListTicketsUseCase'),

  // Casos de uso · Chat
  listMessagesUseCase: createToken<ListMessagesUseCase>('ListMessagesUseCase'),
  sendMessageUseCase: createToken<SendMessageUseCase>('SendMessageUseCase'),

  // Casos de uso · Notificaciones (centro de avisos)
  listNotificationsUseCase: createToken<ListNotificationsUseCase>('ListNotificationsUseCase'),

  // Casos de uso · Promos
  validatePromoUseCase: createToken<ValidatePromoUseCase>('ValidatePromoUseCase'),

  // Casos de uso · Referrals
  getReferralSummaryUseCase: createToken<GetReferralSummaryUseCase>(
    'GetReferralSummaryUseCase',
  ),
  redeemReferralUseCase: createToken<RedeemReferralUseCase>('RedeemReferralUseCase'),

  // Casos de uso · Profile
  getProfileUseCase: createToken<GetProfileUseCase>('GetProfileUseCase'),
  updateProfileUseCase: createToken<UpdateProfileUseCase>('UpdateProfileUseCase'),
  uploadAvatarUseCase: createToken<UploadAvatarUseCase>('UploadAvatarUseCase'),
  removeAvatarUseCase: createToken<RemoveAvatarUseCase>('RemoveAvatarUseCase'),
  requestPhoneCodeUseCase: createToken<RequestPhoneCodeUseCase>('RequestPhoneCodeUseCase'),
  verifyPhoneUseCase: createToken<VerifyPhoneUseCase>('VerifyPhoneUseCase'),
  requestAccountDeletionUseCase: createToken<RequestAccountDeletionUseCase>(
    'RequestAccountDeletionUseCase',
  ),
  logoutUseCase: createToken<LogoutUseCase>('LogoutUseCase'),
} as const;
