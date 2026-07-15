import type {ChatMessage} from '../domain/entities';
import {withDayDividers} from './dayDividers';

const LABELS = {today: 'Hoy', yesterday: 'Ayer'};

/** Mensaje completo del contrato (solo `createdAt` importa para la derivación). */
function msg(id: string, createdAt: string): ChatMessage {
  return {
    id,
    tripId: 'trip-1',
    senderId: 'user-1',
    senderRole: 'PASSENGER',
    body: 'hola',
    createdAt,
  };
}

// "Ahora" fijo para que el test sea determinista: mié 2 jul 2026, 10:00 local.
const NOW = new Date(2026, 6, 2, 10, 0, 0);

describe('withDayDividers', () => {
  it('lista vacía → sin ítems (ni divisor huérfano)', () => {
    expect(withDayDividers([], LABELS, NOW)).toEqual([]);
  });

  it('inserta UN divisor por día y etiqueta Hoy/Ayer/fecha corta', () => {
    const items = withDayDividers(
      [
        msg('a', new Date(2026, 5, 29, 8, 12).toISOString()), // lun 29 jun
        msg('b', new Date(2026, 5, 29, 8, 20).toISOString()),
        msg('c', new Date(2026, 6, 1, 21, 5).toISOString()), // ayer
        msg('d', new Date(2026, 6, 2, 9, 40).toISOString()), // hoy
      ],
      LABELS,
      NOW,
    );

    expect(
      items.map(item =>
        item.kind === 'divider' ? item.label : item.message.id,
      ),
    ).toEqual(['Lun 29 jun', 'a', 'b', 'Ayer', 'c', 'Hoy', 'd']);
  });

  it('mensajes del MISMO día calendario no repiten divisor (aunque pasen horas)', () => {
    const items = withDayDividers(
      [
        msg('a', new Date(2026, 6, 2, 0, 5).toISOString()),
        msg('b', new Date(2026, 6, 2, 23, 55).toISOString()),
      ],
      LABELS,
      NOW,
    );
    expect(items.filter(item => item.kind === 'divider')).toHaveLength(1);
  });

  it('fecha inválida → el mensaje pasa sin divisor (sin etiqueta mentirosa)', () => {
    const items = withDayDividers([msg('a', 'no-es-fecha')], LABELS, NOW);
    expect(items).toEqual([{kind: 'message', message: expect.anything()}]);
  });
});
