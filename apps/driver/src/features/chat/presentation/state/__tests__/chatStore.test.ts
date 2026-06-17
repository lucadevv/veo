import type { Message } from '../../../domain';
import { selectMessages, selectUnread, useChatStore } from '../chatStore';

function msg(partial: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    tripId: 't1',
    senderId: 's1',
    senderRole: 'PASSENGER',
    body: 'hola',
    createdAt: '2026-05-30T10:00:00.000Z',
    ...partial,
  };
}

describe('chatStore', () => {
  beforeEach(() => useChatStore.setState({ byTrip: {} }));

  it('suma no leídos solo por mensajes del pasajero', () => {
    const { receiveMessage } = useChatStore.getState();
    receiveMessage(msg({ id: 'a', senderRole: 'PASSENGER' }));
    receiveMessage(msg({ id: 'b', senderRole: 'DRIVER' }));
    expect(selectUnread('t1')(useChatStore.getState())).toBe(1);
    expect(selectMessages('t1')(useChatStore.getState())).toHaveLength(2);
  });

  it('no duplica ni recuenta un mensaje reentregado (idempotente)', () => {
    const { receiveMessage } = useChatStore.getState();
    receiveMessage(msg({ id: 'a', senderRole: 'PASSENGER' }));
    receiveMessage(msg({ id: 'a', senderRole: 'PASSENGER' }));
    expect(selectMessages('t1')(useChatStore.getState())).toHaveLength(1);
    expect(selectUnread('t1')(useChatStore.getState())).toBe(1);
  });

  it('appendOwn agrega el eco propio sin tocar no leídos', () => {
    const { appendOwn } = useChatStore.getState();
    appendOwn(msg({ id: 'a', senderRole: 'DRIVER', body: 'yo' }));
    expect(selectMessages('t1')(useChatStore.getState())).toHaveLength(1);
    expect(selectUnread('t1')(useChatStore.getState())).toBe(0);
  });

  it('hydrate funde el historial sin duplicar lo ya recibido en vivo', () => {
    const { receiveMessage, hydrate } = useChatStore.getState();
    receiveMessage(msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }));
    hydrate('t1', [
      msg({ id: 'a', createdAt: '2026-05-30T10:00:00.000Z' }),
      msg({ id: 'b', createdAt: '2026-05-30T10:01:00.000Z' }),
    ]);
    expect(selectMessages('t1')(useChatStore.getState()).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('markRead pone no leídos en 0 y clear elimina el viaje', () => {
    const { receiveMessage, markRead, clear } = useChatStore.getState();
    receiveMessage(msg({ id: 'a' }));
    markRead('t1');
    expect(selectUnread('t1')(useChatStore.getState())).toBe(0);
    clear('t1');
    expect(selectMessages('t1')(useChatStore.getState())).toHaveLength(0);
  });

  it('mantiene conversaciones de viajes distintos separadas', () => {
    const { receiveMessage } = useChatStore.getState();
    receiveMessage(msg({ id: 'a', tripId: 't1' }));
    receiveMessage(msg({ id: 'b', tripId: 't2' }));
    expect(selectUnread('t1')(useChatStore.getState())).toBe(1);
    expect(selectUnread('t2')(useChatStore.getState())).toBe(1);
    expect(selectMessages('t1')(useChatStore.getState())).toHaveLength(1);
  });
});
