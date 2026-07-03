import type {ChatMessage} from '../domain/entities';
import {calendarDaysAgo} from '../../../shared/utils/format';
import {formatDayShort} from '../../carpool/presentation/formatDay';

/**
 * Ítem de la lista del chat: un mensaje real o un DIVISOR sintético de día (design/veo.pen hPrJt
 * DayDivider: "Hoy" / "Ayer" / "Lun 30 jun" centrado entre mensajes de días distintos). El divisor
 * se DERIVA de los timestamps reales de los mensajes — no viene del backend ni se inventa.
 */
export type ChatListItem =
  | {kind: 'divider'; id: string; label: string}
  | {kind: 'message'; message: ChatMessage};

/** Etiquetas localizadas que la pantalla inyecta (la derivación queda pura, sin i18n adentro). */
export interface DayDividerLabels {
  today: string;
  yesterday: string;
}

/** Clave de día calendario LOCAL (no UTC: en Lima un mensaje de las 23:00 no debe saltar de día). */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Hoy" / "Ayer" / "Lun 30 jun" según la distancia en DÍAS CALENDARIO (no bloques de 24 h). */
function dayLabel(iso: string, labels: DayDividerLabels, now: Date): string {
  const daysAgo = calendarDaysAgo(iso, now);
  if (daysAgo === 0) {
    return labels.today;
  }
  if (daysAgo === 1) {
    return labels.yesterday;
  }
  return formatDayShort(new Date(iso));
}

/**
 * Inserta un divisor de fecha ANTES del primer mensaje de cada día distinto (la lista ya viene
 * ordenada ascendente por `mergeMessages`). Mensajes con fecha inválida se dejan pasar sin divisor
 * (degradación honesta: mejor sin etiqueta que con una etiqueta mentirosa).
 */
export function withDayDividers(
  messages: ChatMessage[],
  labels: DayDividerLabels,
  now: Date = new Date(),
): ChatListItem[] {
  const items: ChatListItem[] = [];
  let lastDay: string | null = null;
  for (const message of messages) {
    const date = new Date(message.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const day = localDayKey(date);
      if (day !== lastDay) {
        lastDay = day;
        items.push({
          kind: 'divider',
          id: `divider-${day}`,
          label: dayLabel(message.createdAt, labels, now),
        });
      }
    }
    items.push({kind: 'message', message});
  }
  return items;
}
