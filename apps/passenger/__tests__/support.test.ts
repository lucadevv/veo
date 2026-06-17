import type {CreateTicketRequest, SupportTicket} from '@veo/api-client';
import type {SupportRepository} from '../src/features/support/domain/supportRepository';
import {
  CreateTicketUseCase,
  ListTicketsUseCase,
  TicketValidationError,
  ticketStatusTone,
} from '../src/features/support/domain/usecases';

class FakeSupportRepository implements SupportRepository {
  createTicket = jest.fn(
    async (input: CreateTicketRequest): Promise<SupportTicket> => ({
      id: 't-1',
      userId: 'pax',
      role: 'PASSENGER',
      category: input.category,
      subject: input.subject,
      body: input.body,
      status: 'OPEN',
      tripId: input.tripId ?? null,
      createdAt: '2026-05-30T10:00:00.000Z',
    }),
  );
  listTickets = jest.fn(async (): Promise<SupportTicket[]> => []);
}

describe('CreateTicketUseCase', () => {
  it('recorta espacios y crea el ticket cuando es válido', async () => {
    const repo = new FakeSupportRepository();
    const useCase = new CreateTicketUseCase(repo);

    await useCase.execute({
      category: 'TRIP',
      subject: '  Cobro incorrecto  ',
      body: '  Me cobraron de más en mi último viaje.  ',
    });

    expect(repo.createTicket).toHaveBeenCalledWith({
      category: 'TRIP',
      subject: 'Cobro incorrecto',
      body: 'Me cobraron de más en mi último viaje.',
    });
  });

  it('adjunta el tripId solo cuando se proporciona', async () => {
    const repo = new FakeSupportRepository();
    const useCase = new CreateTicketUseCase(repo);

    await useCase.execute({
      category: 'PAYMENT',
      subject: 'Asunto válido',
      body: 'Mensaje con suficiente longitud.',
      tripId: 'trip-123',
    });

    expect(repo.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({tripId: 'trip-123'}),
    );
  });

  it('rechaza un asunto demasiado corto (sin tocar la red)', () => {
    const repo = new FakeSupportRepository();
    const useCase = new CreateTicketUseCase(repo);

    expect(() =>
      useCase.execute({
        category: 'OTHER',
        subject: 'ab',
        body: 'Mensaje suficientemente largo.',
      }),
    ).toThrow(TicketValidationError);
    expect(repo.createTicket).not.toHaveBeenCalled();
  });

  it('rechaza un mensaje demasiado corto e informa el campo', () => {
    const repo = new FakeSupportRepository();
    const useCase = new CreateTicketUseCase(repo);

    try {
      useCase.execute({
        category: 'OTHER',
        subject: 'Asunto válido',
        body: 'corto',
      });
      throw new Error('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(TicketValidationError);
      expect((error as TicketValidationError).field).toBe('body');
    }
    expect(repo.createTicket).not.toHaveBeenCalled();
  });
});

describe('ListTicketsUseCase', () => {
  it('delega en el repositorio', async () => {
    const repo = new FakeSupportRepository();
    const useCase = new ListTicketsUseCase(repo);

    await useCase.execute();

    expect(repo.listTickets).toHaveBeenCalledTimes(1);
  });
});

describe('ticketStatusTone', () => {
  it('mapea cada estado a su tono semántico', () => {
    expect(ticketStatusTone('OPEN')).toBe('warn');
    expect(ticketStatusTone('IN_PROGRESS')).toBe('accent');
    expect(ticketStatusTone('RESOLVED')).toBe('success');
  });
});
