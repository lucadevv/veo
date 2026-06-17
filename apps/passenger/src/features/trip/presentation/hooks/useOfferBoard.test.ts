import {resolveBoardOverride, TERMINAL_BOARD_STATUS} from './useOfferBoard';
import type {OfferBoardState} from './useOfferBoard';

/**
 * Regla de diseño (audit/puja-cancel-zombie): la fase `noOffers` sale EXCLUSIVAMENTE de la verdad del
 * trip (status EXPIRED real). El board NUNCA fuerza `noOffers`, porque GONE es AMBIGUO: el dispatch abre
 * el board ASYNC vía Kafka ~1-2s tras el 201 del POST /trips, así que un primer poll que llega antes ve
 * `{ board: GONE }` aunque la puja recién empieza. Sólo la cancelación EXPLÍCITA (CANCELLED) re-deriva.
 */
describe('resolveBoardOverride · el board re-deriva la fase SOLO ante cancelación explícita', () => {
  const board = (
    status: OfferBoardState['status'],
    expiresAt: number | null = null,
  ): OfferBoardState => ({
    status,
    expiresAt,
  });

  it('GONE → null: NO fuerza fase (board aún no abierto vs TTL es AMBIGUO) → manda el trip real', () => {
    expect(resolveBoardOverride(board('GONE'))).toBeNull();
  });

  it('EXPIRED → null: la fase noOffers la decide el trip EXPIRED real, no el board (sin doble fuente)', () => {
    expect(resolveBoardOverride(board('EXPIRED'))).toBeNull();
  });

  it('CANCELLED → "CANCELLED": cancelación EXPLÍCITA del usuario → vuelta al home sin esperar al socket', () => {
    expect(resolveBoardOverride(board('CANCELLED'))).toBe('CANCELLED');
  });

  it('OPEN → null: la puja sigue viva → manda el socket/poll', () => {
    expect(resolveBoardOverride(board('OPEN'))).toBeNull();
  });

  it('CLOSED_MATCHED → null: el match lo trae el socket (ASSIGNED), no lo adivina el board', () => {
    expect(resolveBoardOverride(board('CLOSED_MATCHED'))).toBeNull();
  });

  it('board null (sin snapshot todavía) → null: manda el socket/poll', () => {
    expect(resolveBoardOverride(null)).toBeNull();
  });

  it('board GONE con expiresAt null no rompe: override null y el countdown cae al fallback local', () => {
    const b = board('GONE', null);
    expect(resolveBoardOverride(b)).toBeNull();
    // expiresAt null → OffersBody usa el estimado local de 60s → "Buscando conductores…" sin parpadeos.
    expect(b.expiresAt).toBeNull();
  });
});

describe('TERMINAL_BOARD_STATUS · sólo CANCELLED es terminal para la fase', () => {
  it('EXPIRED y GONE NO mapean a EXPIRED (se quitó el re-derive que pintaba noOffers fantasma)', () => {
    expect(TERMINAL_BOARD_STATUS.EXPIRED).toBeNull();
    expect(TERMINAL_BOARD_STATUS.GONE).toBeNull();
  });

  it('CANCELLED conserva el mapeo explícito (clear/ended sin esperar al socket)', () => {
    expect(TERMINAL_BOARD_STATUS.CANCELLED).toBe('CANCELLED');
  });
});
