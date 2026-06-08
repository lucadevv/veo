import type { ChatMessage } from '@veo/api-client';
import type { ChatRepository } from '../src/features/chat/domain/chatRepository';
import {
  isChatActive,
  isOwnMessage,
  mergeMessages,
} from '../src/features/chat/domain/entities';
import { ChatMessageError, SendMessageUseCase } from '../src/features/chat/domain/usecases';

function msg(id: string, createdAt: string, role: ChatMessage['senderRole'] = 'DRIVER'): ChatMessage {
  return { id, tripId: 't-1', senderId: 's', senderRole: role, body: id, createdAt };
}

describe('isOwnMessage', () => {
  it('reconoce los mensajes del pasajero como propios', () => {
    expect(isOwnMessage({ senderRole: 'PASSENGER' })).toBe(true);
    expect(isOwnMessage({ senderRole: 'DRIVER' })).toBe(false);
  });
});

describe('isChatActive', () => {
  it('está activo en estados no terminales y desactivo al completar/cancelar', () => {
    expect(isChatActive('IN_PROGRESS')).toBe(true);
    expect(isChatActive('ARRIVING')).toBe(true);
    expect(isChatActive('COMPLETED')).toBe(false);
    expect(isChatActive('CANCELLED')).toBe(false);
    expect(isChatActive(null)).toBe(false);
  });
});

describe('mergeMessages', () => {
  it('deduplica por id y ordena por createdAt ascendente', () => {
    const history = [msg('a', '2026-05-30T10:00:00.000Z'), msg('b', '2026-05-30T10:01:00.000Z')];
    const incoming = [
      msg('b', '2026-05-30T10:01:00.000Z'), // duplicado
      msg('c', '2026-05-30T09:59:00.000Z'), // anterior
    ];

    const merged = mergeMessages(history, incoming);

    expect(merged.map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('SendMessageUseCase', () => {
  class FakeChatRepository implements ChatRepository {
    list = jest.fn(async (): Promise<ChatMessage[]> => []);
    send = jest.fn(async (_tripId: string, _body: string): Promise<ChatMessage> =>
      msg('new', '2026-05-30T10:02:00.000Z', 'PASSENGER'),
    );
  }

  it('recorta y envía un mensaje válido', async () => {
    const repo = new FakeChatRepository();
    const useCase = new SendMessageUseCase(repo);

    await useCase.execute('t-1', '  Ya salgo  ');

    expect(repo.send).toHaveBeenCalledWith('t-1', 'Ya salgo');
  });

  it('rechaza un mensaje vacío sin llamar al repo', () => {
    const repo = new FakeChatRepository();
    const useCase = new SendMessageUseCase(repo);

    expect(() => useCase.execute('t-1', '   ')).toThrow(ChatMessageError);
    expect(repo.send).not.toHaveBeenCalled();
  });

  it('rechaza un mensaje que excede el máximo', () => {
    const repo = new FakeChatRepository();
    const useCase = new SendMessageUseCase(repo);

    expect(() => useCase.execute('t-1', 'x'.repeat(501))).toThrow(/tooLong/);
    expect(repo.send).not.toHaveBeenCalled();
  });
});
