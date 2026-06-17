import { describe, expect, it, vi } from 'vitest';
import { createTicketAuth } from './ops-socket';

/**
 * El núcleo del fix de "realtime muerto": el ticket es de un solo uso (Redis GETDEL), así que
 * el `auth` de socket.io debe ser una FUNCIÓN que re-mintea un ticket fresco en CADA (re)conexión.
 * Estos tests cubren la lógica pura del provider sin un socket real.
 */
describe('createTicketAuth', () => {
  it('re-mintea un ticket FRESCO en cada invocación (no reusa el primero)', async () => {
    const fetchTicket = vi
      .fn<(signal?: AbortSignal) => Promise<string | null>>()
      .mockResolvedValueOnce('ticket-1')
      .mockResolvedValueOnce('ticket-2');
    const auth = createTicketAuth(fetchTicket);

    const first = await invoke(auth);
    const second = await invoke(auth);

    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ ticket: 'ticket-1' });
    expect(second).toEqual({ ticket: 'ticket-2' });
  });

  it('ante fallo de red (ticket null) emite payload vacío sin reventar', async () => {
    const fetchTicket = vi
      .fn<(signal?: AbortSignal) => Promise<string | null>>()
      .mockResolvedValue(null);
    const auth = createTicketAuth(fetchTicket);

    const payload = await invoke(auth);

    // Sin ticket: el gateway rechaza, pero socket.io reintenta con backoff (no queda colgado).
    expect(payload).toEqual({});
  });

  it('si el fetch lanza, blinda el rejection y emite payload vacío (no cuelga la reconexión)', async () => {
    const fetchTicket = vi
      .fn<(signal?: AbortSignal) => Promise<string | null>>()
      .mockRejectedValue(new Error('network down'));
    const auth = createTicketAuth(fetchTicket);

    const payload = await invoke(auth);

    // Defensa en profundidad: el provider captura el error y responde {} para que socket.io reintente.
    expect(payload).toEqual({});
  });

  it('respeta AbortSignal: si está abortado tras el fetch, no invoca el callback', async () => {
    const ac = new AbortController();
    const fetchTicket = vi
      .fn<(signal?: AbortSignal) => Promise<string | null>>()
      .mockImplementation(async () => {
        ac.abort();
        return 'late-ticket';
      });
    const auth = createTicketAuth(fetchTicket, ac.signal);
    const cb = vi.fn();

    auth(cb);
    await flush();

    expect(cb).not.toHaveBeenCalled();
  });
});

/** Invoca el provider y resuelve con el payload que recibió el callback. */
function invoke(
  auth: (cb: (p: { ticket?: string }) => void) => void,
): Promise<{ ticket?: string }> {
  return new Promise((resolve) => auth(resolve));
}

/** Deja correr las microtareas pendientes. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
