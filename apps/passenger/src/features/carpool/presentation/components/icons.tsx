import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import type {GlyphProps} from '../../../trip/presentation/components/icons';

/**
 * Íconos propios del carpooling (estados de la solicitud · design/veo.pen sección 5) que el set
 * del flujo de viaje no trae: reloj de arena (esperando aprobación, lucide `hourglass`) y
 * calendario tachado (reserva no confirmada, lucide `calendar-x`). Mismo patrón que
 * `trip/.../icons.tsx`: viewBox 24×24, trazo 2px, color por prop, decorativos.
 */

const STROKE = 2;

/** Reloj de arena (P/WaitingApproval). Espejo del `hourglass` de lucide. */
export function IconHourglass({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 22h14"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M5 2h14"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Calendario tachado (P/BookingRejected). Espejo del `calendar-x` de lucide. */
export function IconCalendarX({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={4}
        width={18}
        height={18}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M16 2v4M8 2v4M3 10h18"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="m14.5 13.5-5 5m0-5 5 5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Círculo con check (P/BookingApproved). Espejo del `circle-check` de lucide. */
export function IconCircleCheck({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={STROKE} />
      <Path
        d="m8.5 12.3 2.4 2.4 4.6-5.2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
