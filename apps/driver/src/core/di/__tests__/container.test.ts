import { getContainer, resetContainer } from '../container';

describe('AppContainer (DI)', () => {
  beforeEach(() => resetContainer());

  it('registra un repositorio por cada feature, expuesto por su interfaz', () => {
    const container = getContainer();
    const { auth, shift, trips, earnings, profile, documents, registration, chat, ops, support } =
      container.repositories;

    expect(typeof auth.requestOtp).toBe('function');
    expect(typeof auth.verifyOtp).toBe('function');
    expect(typeof shift.start).toBe('function');
    expect(typeof shift.getState).toBe('function');
    expect(typeof trips.getTrip).toBe('function');
    expect(typeof trips.accept).toBe('function');
    expect(typeof earnings.getSummary).toBe('function');
    expect(typeof profile.getMe).toBe('function');
    expect(typeof documents.list).toBe('function');
    expect(typeof documents.register).toBe('function');
    expect(typeof registration.listDocuments).toBe('function');
    expect(typeof registration.submitDocument).toBe('function');
    expect(typeof registration.onboardLicense).toBe('function');
    expect(typeof registration.enrollBiometric).toBe('function');
    expect(typeof chat.listMessages).toBe('function');
    expect(typeof chat.sendMessage).toBe('function');
    expect(typeof ops.getHeatmap).toBe('function');
    expect(typeof ops.listIncentives).toBe('function');
    expect(typeof support.createTicket).toBe('function');
    expect(typeof support.listTickets).toBe('function');
  });

  it('expone el cliente HTTP y la fábrica del socket /driver', () => {
    const container = getContainer();
    expect(container.httpClient).toBeDefined();
    expect(typeof container.createDriverSocket).toBe('function');
  });

  it('devuelve el mismo singleton entre llamadas', () => {
    expect(getContainer()).toBe(getContainer());
  });
});
