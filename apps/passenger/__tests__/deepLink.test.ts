import { resolveDeepLink } from '../src/features/notifications/domain/deepLink';

/**
 * El deep-link de push (#1 PUJA programada) traduce el `data` string→string de FCM a una ruta tipada.
 * Invariantes: (1) `screen` explícito de la whitelist gana, (2) sin screen pero con tripId cae a
 * TripActive (el detalle refleja cualquier estado), (3) sin tripId no navega (null), (4) un screen
 * desconocido o que pide más params (Counter) NO se acepta a ciegas.
 */
describe('notifications · resolveDeepLink', () => {
  it('screen explícito de la whitelist → navega ahí (PUJA programada → OffersBoard)', () => {
    expect(resolveDeepLink({ tripId: 't1', screen: 'OffersBoard' })).toEqual({
      screen: 'OffersBoard',
      params: { tripId: 't1' },
    });
  });

  it('sin screen pero con tripId → cae a TripActive (assigned/expired)', () => {
    expect(resolveDeepLink({ tripId: 't2' })).toEqual({
      screen: 'TripActive',
      params: { tripId: 't2' },
    });
  });

  it('NoOffers (puja EXPIRED) → Home del sheet, NO la pantalla legacy', () => {
    // El flujo normal vive ENTERO en el sheet: NoOffers ya no es una pantalla aparte, es la fase
    // `noOffers` del sheet. El push aterriza en el Home y el sheet rehidrata; el tripId no viaja.
    // Tras quitar los bottom tabs, `Home` es una ruta DIRECTA del stack (antes `Main`/`{screen:'Home'}`).
    expect(resolveDeepLink({ tripId: 't5', screen: 'NoOffers' })).toEqual({
      screen: 'Home',
    });
  });

  it('sin tripId → null (no navega a ciegas)', () => {
    expect(resolveDeepLink({ screen: 'OffersBoard' })).toBeNull();
    expect(resolveDeepLink({})).toBeNull();
    expect(resolveDeepLink(undefined)).toBeNull();
  });

  it('screen desconocido con tripId → degrada a TripActive (no rompe)', () => {
    expect(resolveDeepLink({ tripId: 't3', screen: 'Inexistente' })).toEqual({
      screen: 'TripActive',
      params: { tripId: 't3' },
    });
  });

  it('Counter NO es destino directo (necesita driverId) → degrada a TripActive', () => {
    expect(resolveDeepLink({ tripId: 't4', screen: 'Counter' })).toEqual({
      screen: 'TripActive',
      params: { tripId: 't4' },
    });
  });

  it('ignora valores no-string del data (FCM a veces manda objetos)', () => {
    expect(resolveDeepLink({ tripId: { nested: 'x' } as unknown as string })).toBeNull();
  });
});
