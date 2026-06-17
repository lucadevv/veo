import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

/**
 * Set de iconos del hub de cuenta (Profile / TripDetail) dibujados con `react-native-svg`. Portados
 * 1:1 del set `I` del design-handoff canónico (`screens-pass.jsx`), mismo patrón que los íconos del
 * flujo de ingreso (`auth/presentation/components/icons.tsx`): viewBox 24×24, trazo ~2px, color por
 * prop. Decorativos: el contenedor presionable (ListItem) aporta la etiqueta accesible.
 */

export interface GlyphProps {
  /** Color del trazo/relleno. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Campana (notificaciones push). Mismo trazo 2px del set. */
export function IconBell({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M10.3 21a2 2 0 0 0 3.4 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Verificación facial (escaneo de rostro). Espejo de `I.scan` del diseño. */
export function IconFaceScan({
  color,
  size = 22,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={11} r={2.6} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M8.5 16.5a4 4 0 0 1 7 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Grupo de personas (contactos de confianza / control de cámara). Espejo de `I.users`. */
export function IconUsers({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx={9}
        cy={8}
        r={3.4}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M3.5 19.5a5.5 5.5 0 0 1 11 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M16 5a3.3 3.3 0 0 1 0 6.3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M17.5 14a5 5 0 0 1 3.2 5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Niño/menor (modo niño). Espejo de `I.child`. */
export function IconChild({color, size = 22}: GlyphProps): React.JSX.Element {
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

/** Cámara (control de cámara). Espejo de `I.cam` del diseño (lente sin relleno). */
export function IconCamera({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12.5} r={3.2} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Compartir (nodos conectados). Espejo de `I.share`. */
export function IconShare({color, size = 22}: GlyphProps): React.JSX.Element {
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

/** Tarjeta (métodos de pago). Espejo de `I.card`. */
export function IconCard({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={2.5}
        y={5}
        width={19}
        height={14}
        rx={2.5}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path d="M2.5 9.5h19" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Pin de ubicación (lugares guardados). Espejo de `I.pin`. */
export function IconPin({color, size = 22}: GlyphProps): React.JSX.Element {
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

/** Reloj (viajes programados). Espejo de `I.clock`. */
export function IconClock({color, size = 22}: GlyphProps): React.JSX.Element {
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

/** Regalo (invita y gana). Espejo de `I.gift`. */
export function IconGift({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={8}
        width={18}
        height={13}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M3 12h18M12 8v13"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M12 8S10 3 7.5 4.5 9 8 12 8s2.5-2 4.5-3.5S12 8 12 8Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Ayuda (signo de interrogación en círculo). Espejo de `I.help`. */
export function IconHelp({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Circle cx={12} cy={17} r={0.7} fill={color} />
    </Svg>
  );
}

/** Botón de encendido/apagado (cerrar sesión). Espejo de `I.power`. */
export function IconPower({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3v9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M6.5 7a8 8 0 1 0 11 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Accesibilidad / globo de idioma (placeholder reutilizando `I.help` del diseño). */
export function IconAccessibility({
  color,
  size = 22,
}: GlyphProps): React.JSX.Element {
  return <IconHelp color={color} size={size} />;
}

/** Papelera (derecho al olvido · eliminar cuenta). Feather `trash-2`, mismo lenguaje de trazo. */
export function IconTrash({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h16"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M9.5 7V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M10 11v6M14 11v6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Escudo de seguridad (identidad verificada). Espejo de `I.shield` (sin relleno). */
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

/** Recibo/factura (TripDetail). Reutiliza el glyph de tarjeta del set. */
export function IconReceipt({color, size = 22}: GlyphProps): React.JSX.Element {
  return <IconCard color={color} size={size} />;
}

/** Lupa (buscar objeto olvidado, TripDetail). Espejo de `I.search`. */
export function IconSearch({color, size = 22}: GlyphProps): React.JSX.Element {
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
