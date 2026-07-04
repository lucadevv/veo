import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

/**
 * Set de iconos del flujo de VIAJE del pasajero (Home "¿A dónde vamos?", búsqueda, cotización/PUJA,
 * board de ofertas y viaje activo) dibujados con `react-native-svg`. Portados 1:1 del set `I` del
 * design-handoff canónico (`screens-pass.jsx`), mismo patrón que los íconos del flujo de ingreso
 * (`auth/.../icons.tsx`) y del hub de cuenta (`profile/.../icons.tsx`): viewBox 24×24, trazo ~2px,
 * color por prop. Decorativos: el contenedor presionable aporta la etiqueta accesible.
 */

export interface GlyphProps {
  /** Color del trazo/relleno. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Lupa (buscar destino). Espejo de `I.search`. */
export function IconSearch({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={11} cy={11} r={7} stroke={color} strokeWidth={STROKE} />
      <Path
        d="m20 20-3.2-3.2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Calendario (fecha de un viaje programado · design/veo.pen UcekU, lucide calendar-days). */
export function IconCalendar({
  color,
  size = 16,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3.5}
        y={5}
        width={17}
        height={16}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M8 3v4M16 3v4M3.5 10h17"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Pin de ubicación (lugar/destino). Espejo de `I.pin`. */
export function IconPin({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={10} r={2.4} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Historial (filas de "Tus últimos viajes" del Home — pen P/Home · RecentTripsSection). */
export function IconHistory({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 12a9 9 0 1 0 2.64-6.36L3 8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path d="M3 3v5h5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M12 7v5l4 2" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Mapa plegado (atajo "Elegir en el mapa" del buscador del Home — pen P/Home · SearchField). */
export function IconMap({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 4 3.5 6.2a1 1 0 0 0-.5.9v11.4a1 1 0 0 0 1.4.9L9 17.5l6 2.5 5.5-2.2a1 1 0 0 0 .5-.9V5.5a1 1 0 0 0-1.4-.9L15 6.5 9 4Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path d="M9 4v13.5M15 6.5V20" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Casa (atajo "Casa" / lugar guardado HOME). Espejo de `I.home`. */
export function IconHome({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 11l9-8 9 8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M5 10v10h14V10"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Maletín (atajo "Trabajo" / lugar guardado WORK). Espejo de `I.work`. */
export function IconWork({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 7h18a0 0 0 0 1 0 0v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a0 0 0 0 1 0 0Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Estrella (lugar guardado FAVORITE). Espejo de `I.star` (sin relleno). */
export function IconStar({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Cruz (cerrar / quitar). Espejo de `I.x`. */
export function IconClose({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 6 6 18M6 6l12 12"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Campana de notificaciones. Espejo del glyph de campana de la Home del diseño. */
export function IconBell({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M13.5 21a2 2 0 0 1-3 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Flecha hacia la izquierda (volver). Espejo de `I.arrowL`. */
export function IconArrowLeft({
  color,
  size = 22,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18l-6-6 6-6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Flecha derecha (comparación "tu oferta → su precio" del pen u1306). Espejo horizontal de IconArrowLeft. */
export function IconArrowRight({
  color,
  size = 18,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 6l6 6-6 6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Chevron hacia abajo (minimizar el sheet del viaje activo, pen fLKdk MinBtn). */
export function IconChevronDown({
  color,
  size = 22,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 9l6 6 6-6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Diana / mira (usar mi ubicación actual). Espejo del glyph de target del diseño. */
export function IconTarget({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={STROKE} />
      <Circle cx={12} cy={12} r={2.4} fill={color} />
    </Svg>
  );
}

/** Estrella (rating del conductor). Espejo de `I.star` RELLENA (usada en ratings). */
export function IconStarFilled({
  color,
  size = 14,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"
        fill={color}
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Globo de chat (mensajería con el conductor). Espejo de `I.chat`. */
export function IconChat({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.7A8 8 0 1 1 21 12Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Ruta con nodos (cambiar destino). Espejo de `I.route`. */
export function IconRoute({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={6} cy={19} r={2.2} stroke={color} strokeWidth={STROKE} />
      <Circle cx={18} cy={5} r={2.2} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Intercambiar (dos flechas verticales opuestas): permuta ORIGEN ↔ DESTINO. Vive en el botón
 * circular entre las dos filas de la tarjeta de ruta del Home (mismo gesto que `rideDraftStore.swap`).
 */
export function IconSwapVertical({
  color,
  size = 18,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 4v15m0 0-3-3m3 3 3-3M17 20V5m0 0-3 3m3-3 3 3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Compartir (nodos conectados). Espejo de `I.share`. */
export function IconShare({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={6} cy={12} r={2.5} stroke={color} strokeWidth={STROKE} />
      <Circle cx={18} cy={6} r={2.5} stroke={color} strokeWidth={STROKE} />
      <Circle cx={18} cy={18} r={2.5} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M8.2 10.8 15.8 7M8.2 13.2 15.8 17"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Menos (bajar la oferta en el stepper de PUJA). Espejo de `I.minus`. */
export function IconMinus({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 12h14"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Más (subir la oferta en el stepper de PUJA). Espejo de `I.plus`. */
export function IconPlus({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 5v14M5 12h14"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Mascota / niño (solicitud especial). Espejo de `I.child` del diseño. */
export function IconChild({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx={12}
        cy={6.5}
        r={3}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M6 21v-2a6 6 0 0 1 12 0v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Cámara (cámara del habitáculo / compartir cámara). Espejo de `I.cam` del diseño. */
export function IconCamera({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 8.5A2 2 0 0 1 5 6.5h2l1.4-2h7.2L17 6.5h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12.5} r={3.2} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Dos personas (contactos verificados / "quién puede ver"). Espejo de `I.users` del diseño. */
export function IconUsers({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={9} cy={8} r={3.2} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M3 20v-1.5a5 5 0 0 1 10 0V20"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 20v-1.5a5 5 0 0 0-2.4-4.3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Reloj (programación / hora del viaje). Espejo de `I.clock` del diseño. */
export function IconClock({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M12 7v5l3 2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Escudo (nota de seguridad / mediación). Espejo de `I.shield` del diseño. */
export function IconShield({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Candado (grabación cifrada / nota de seguridad). Espejo de `I.lock` del diseño. */
export function IconLock({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={5}
        y={10.5}
        width={14}
        height={9.5}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Maletín / equipaje (solicitud especial). Espejo de `I.work` del diseño. */
export function IconLuggage({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={7}
        width={18}
        height={13}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Auto (tier CAR del historial). Silueta lateral simple, mismo trazo 2px del set. */
export function IconCar({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 16v-3l2-5a2 2 0 0 1 1.9-1.3h8.2A2 2 0 0 1 18 8l2 5v3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M3 16h18"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Circle cx={7.5} cy={16.5} r={1.6} stroke={color} strokeWidth={STROKE} />
      <Circle cx={16.5} cy={16.5} r={1.6} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Moto (tier MOTO del historial / moto-taxi). Espejo del set de tiers. */
export function IconMoto({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={5.5} cy={16.5} r={2.5} stroke={color} strokeWidth={STROKE} />
      <Circle cx={18.5} cy={16.5} r={2.5} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M8 16.5h6l-2.5-5H9m5.5 5 3-7H20m-5.5 7-3-7"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Check (calificación enviada / confirmación). Espejo del check del set de cierre. */
export function IconCheck({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m5 12.5 4.2 4.2L19 7"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Copiar (duplicado del set de referidos, para el "Copiar" del enlace — pen zKyic CopyBtn). */
export function IconCopy({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={9}
        y={9}
        width={12}
        height={12}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Globo de chat cuadrado (canal "Mensajes"/SMS — pen zKyic, lucide message-square). */
export function IconMessageSquare({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Rayo (modo "Ahora" del toggle del Home). Espejo del `zap` del design/veo.pen: relleno sólido. */
export function IconBolt({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"
        fill={color}
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
