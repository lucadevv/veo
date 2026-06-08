/**
 * Contrato de copy (es-PE) del cierre post-viaje. Los componentes del settlement y rating leen estas
 * claves por `t(...)`; si faltan, la UI muestra la clave cruda. Cubre las claves agregadas en los
 * fixes F4 (reembolso honesto) y F6 (rating ya enviado / 409 amigable).
 */
import { common } from '../src/i18n/locales/es-PE/common';

describe('es-PE · copy del cierre post-viaje', () => {
  it('F4 · expone el copy NEUTRAL de reembolso (ni "pagado" ni propina)', () => {
    expect(common.settlement.refundedTitle).toBe('Este viaje fue reembolsado');
    // Interpola el monto devuelto y deja claro que no hay nada que pagar.
    expect(common.settlement.refundedBody).toContain('{{amount}}');
  });

  it('F6 · expone el copy de "ya calificaste" para el 409 amigable', () => {
    expect(common.ratings.alreadyRated).toBeDefined();
    expect(common.ratings.alreadyRated.length).toBeGreaterThan(0);
  });

  it('cierre canónico · el rating cierra el ciclo con "Volver al inicio" (no un genérico "Cerrar")', () => {
    // Handoff (screens-pass.jsx): estado post-envío = check + "¡Gracias!" + "Volver al inicio".
    expect(common.ratings.thanks).toBe('¡Gracias!');
    expect(common.ratings.backHome).toBe('Volver al inicio');
    // El skip se lee como salida clara, no un "Omitir" mudo.
    expect(common.ratings.skip).toBe('Ahora no');
  });
});

describe('es-PE · copy de la PUJA sin ofertas (NoOffersBody, in-sheet)', () => {
  it('expone título honesto + dos salidas (re-pujar / salir) y el fallback sin precio', () => {
    expect(common.noOffers.title).toBe('No hubo ofertas esta vez');
    // Re-pujar interpola el precio cuando se conoce; el fallback no bloquea esperando el piso.
    expect(common.noOffers.rebid).toContain('{{price}}');
    expect(common.noOffers.rebidNoPrice).toBeDefined();
    expect(common.noOffers.rebidNoPrice.length).toBeGreaterThan(0);
    // Salir SIEMPRE disponible (salida local de un EXPIRED, no un cancel server-side).
    expect(common.noOffers.exit).toBe('Salir');
    // Explicación honesta también cuando aún no llegó la oferta actual.
    expect(common.noOffers.bodyNoPrice).toBeDefined();
    expect(common.noOffers.bodyNoPrice.length).toBeGreaterThan(0);
  });
});
