import {resolveDeepLink} from '../src/features/notifications/domain/deepLink';

/**
 * El deep-link de push (#1 PUJA programada) traduce el `data` string→string de FCM a una ruta tipada.
 * Invariantes: (1) `screen` explícito de la whitelist gana (solo OffersBoard), (2) CUALQUIER otro push
 * con tripId aterriza en el HOME con `adoptTripId` — el flujo unificado adopta el viaje y deriva la
 * fase real (la pantalla legacy TripActive se eliminó), (3) sin tripId no navega (null), (4) un screen
 * desconocido o que pide más params (Counter) NO se acepta a ciegas.
 */
describe('notifications · resolveDeepLink', () => {
  it('screen explícito de la whitelist → navega ahí (PUJA programada → OffersBoard)', () => {
    expect(resolveDeepLink({tripId: 't1', screen: 'OffersBoard'})).toEqual({
      screen: 'OffersBoard',
      params: {tripId: 't1'},
    });
  });

  it('sin screen pero con tripId → Home + adoptTripId (el sheet unificado deriva la fase real)', () => {
    expect(resolveDeepLink({tripId: 't2'})).toEqual({
      screen: 'Home',
      adoptTripId: 't2',
    });
  });

  it('NoOffers (puja EXPIRED) → Home + adoptTripId (la fase noOffers se reconstruye del server)', () => {
    // El flujo normal vive ENTERO en el sheet: NoOffers no es una pantalla aparte, es la fase
    // `noOffers`. Adoptar el tripId cierra el gap de arranque en frío: el poll de estado del sheet
    // reporta EXPIRED aunque `GET /trips/active` no incluya el viaje.
    expect(resolveDeepLink({tripId: 't5', screen: 'NoOffers'})).toEqual({
      screen: 'Home',
      adoptTripId: 't5',
    });
  });

  it("el viejo 'TripActive' (backend N-1) → Home + adoptTripId (la pantalla legacy no existe)", () => {
    expect(resolveDeepLink({tripId: 't6', screen: 'TripActive'})).toEqual({
      screen: 'Home',
      adoptTripId: 't6',
    });
  });

  it('sin tripId → null (no navega a ciegas)', () => {
    expect(resolveDeepLink({screen: 'OffersBoard'})).toBeNull();
    expect(resolveDeepLink({})).toBeNull();
    expect(resolveDeepLink(undefined)).toBeNull();
  });

  it('screen desconocido con tripId → degrada al Home unificado (no rompe)', () => {
    expect(resolveDeepLink({tripId: 't3', screen: 'Inexistente'})).toEqual({
      screen: 'Home',
      adoptTripId: 't3',
    });
  });

  it('Counter NO es destino directo (necesita driverId) → degrada al Home unificado', () => {
    expect(resolveDeepLink({tripId: 't4', screen: 'Counter'})).toEqual({
      screen: 'Home',
      adoptTripId: 't4',
    });
  });

  it('ignora valores no-string del data (FCM a veces manda objetos)', () => {
    expect(
      resolveDeepLink({tripId: {nested: 'x'} as unknown as string}),
    ).toBeNull();
  });
});
