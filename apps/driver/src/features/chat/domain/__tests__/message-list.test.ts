import type { Message } from '../entities';
import {
  isOwnMessage,
  mergeMessages,
  sortMessages,
  upsertMessage,
} from '../value-objects/message-list';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'createdAt'>): Message {
  return {
    tripId: 't1',
    senderId: 's1',
    senderRole: 'PASSENGER',
    body: 'hola',
    ...partial,
  };
}

describe('chat/message-list', () => {
  describe('isOwnMessage', () => {
    it('marca como propio solo el rol DRIVER', () => {
      expect(
        isOwnMessage(msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z', senderRole: 'DRIVER' })),
      ).toBe(true);
      expect(
        isOwnMessage(
          msg({ id: 'b', createdAt: '2026-05-30T10:00:00.000Z', senderRole: 'PASSENGER' }),
        ),
      ).toBe(false);
    });
  });

  describe('sortMessages', () => {
    it('ordena cronológicamente ascendente (más antiguo primero)', () => {
      const out = sortMessages([
        msg({ id: 'c', createdAt: '2026-05-30T10:02:00.000Z' }),
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
        msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }),
      ]);
      expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('desempata por id de forma estable cuando comparten createdAt', () => {
      const out = sortMessages([
        msg({ id: 'z', createdAt: '2026-05-30T10:00:00.000Z' }),
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
      ]);
      expect(out.map((m) => m.id)).toEqual(['a', 'z']);
    });

    it('no muta la lista de entrada', () => {
      const input = [
        msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }),
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
      ];
      sortMessages(input);
      expect(input.map((m) => m.id)).toEqual(['b', 'a']);
    });

    it('coloca al final los mensajes con fecha inválida (tratada como 0)', () => {
      const out = sortMessages([
        msg({ id: 'good', createdAt: '2026-05-30T10:00:00.000Z' }),
        msg({ id: 'bad', createdAt: 'no-es-fecha' }),
      ]);
      expect(out.map((m) => m.id)).toEqual(['bad', 'good']);
    });
  });

  describe('upsertMessage', () => {
    it('agrega un mensaje nuevo y reordena', () => {
      const base = [msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' })];
      const out = upsertMessage(base, msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }));
      expect(out.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('es idempotente: reentregar el mismo id no duplica la burbuja', () => {
      const base = [msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z', body: 'v1' })];
      const out = upsertMessage(
        base,
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z', body: 'v2' }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.body).toBe('v2');
    });
  });

  describe('mergeMessages', () => {
    it('fusiona historial REST con lo recibido en vivo sin duplicar por id', () => {
      const live = [
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
        msg({ id: 'c', createdAt: '2026-05-30T10:02:00.000Z' }),
      ];
      const history = [
        msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
        msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }),
      ];
      const out = mergeMessages(live, history);
      expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
