import { buildContainer } from '../src/core/di/registry';
import { TOKENS } from '../src/core/di/tokens';

describe('buildContainer · cableado de la oleada de features', () => {
  const container = buildContainer();

  it('resuelve los casos de uso de viaje', () => {
    expect(typeof container.resolve(TOKENS.createTripUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.cancelTripUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.changeDestinationUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.getCabinVideoUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.shareTripUseCase).execute).toBe('function');
  });

  it('resuelve los casos de uso de cierre / re-entrada (settlement)', () => {
    expect(typeof container.resolve(TOKENS.getPendingSettlementUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.closeTripUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.getPaymentByTripUseCase).execute).toBe('function');
  });

  it('resuelve los casos de uso de PUJA (board de ofertas)', () => {
    expect(typeof container.resolve(TOKENS.listOffersUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.acceptOfferUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.cancelBidUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.rebidUseCase).execute).toBe('function');
  });

  it('resuelve el repositorio y el caso de uso de consentimientos (Ley N.° 29733)', () => {
    expect(typeof container.resolve(TOKENS.consentRepository).record).toBe('function');
    expect(typeof container.resolve(TOKENS.recordConsentUseCase).execute).toBe('function');
  });

  it('resuelve el caso de uso de pánico y sus puertos nativos por defecto', () => {
    expect(typeof container.resolve(TOKENS.triggerPanicUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.panicSigner).sign).toBe('function');
    expect(typeof container.resolve(TOKENS.panicTrigger).start).toBe('function');
    expect(typeof container.resolve(TOKENS.locationProvider).getCurrentPosition).toBe('function');
  });

  it('resuelve los casos de uso de contactos, pagos, ratings y perfil', () => {
    expect(typeof container.resolve(TOKENS.addContactUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.chargeTripUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.confirmCashUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.submitRatingUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.getProfileUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.logoutUseCase).execute).toBe('function');
  });

  it('resuelve los casos de uso de promos, referidos y chat (Ola 2A)', () => {
    expect(typeof container.resolve(TOKENS.validatePromoUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.getReferralSummaryUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.redeemReferralUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.listMessagesUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.sendMessageUseCase).execute).toBe('function');
  });

  it('resuelve los casos de uso de soporte (Centro de Ayuda)', () => {
    expect(typeof container.resolve(TOKENS.createTicketUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.listTicketsUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.supportRepository).createTicket).toBe('function');
  });

  it('resuelve el centro de avisos (feed vacío honesto, hueco de backend)', () => {
    expect(typeof container.resolve(TOKENS.notificationsRepository).list).toBe('function');
    expect(typeof container.resolve(TOKENS.listNotificationsUseCase).execute).toBe('function');
  });

  it('resuelve el historial local de viajes', () => {
    expect(typeof container.resolve(TOKENS.tripHistoryRepository).list).toBe('function');
  });

  it('resuelve la propina y los casos de uso de lugares guardados (local)', () => {
    expect(typeof container.resolve(TOKENS.addTipUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.placesRepository).list).toBe('function');
    expect(typeof container.resolve(TOKENS.listPlacesUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.savePlaceUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.updatePlaceUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.removePlaceUseCase).execute).toBe('function');
  });

  it('resuelve los casos de uso de login social nativo (OAuth)', () => {
    expect(typeof container.resolve(TOKENS.loginWithGoogleUseCase).execute).toBe('function');
    expect(typeof container.resolve(TOKENS.loginWithAppleUseCase).execute).toBe('function');
  });

  it('resuelve el repositorio y el caso de uso de vehículos cercanos (dispatch · ambiente)', () => {
    expect(typeof container.resolve(TOKENS.dispatchRepository).getNearbyVehicles).toBe('function');
    expect(typeof container.resolve(TOKENS.getNearbyVehiclesUseCase).execute).toBe('function');
  });
});
