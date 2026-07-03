import React from 'react';
import Svg, {Circle, Path} from 'react-native-svg';

/**
 * Set de iconos de la pantalla de PÁNICO ("¿Necesitas ayuda?") dibujados con `react-native-svg`.
 * Portados 1:1 del set `I` del design-handoff canónico (`screens-pass.jsx`), mismo patrón que los
 * íconos del flujo de viaje (`trip/.../icons.tsx`) y de ingreso (`auth/.../icons.tsx`): viewBox
 * 24×24, trazo ~2px, color por prop. Decorativos: el contenedor presionable o el texto adjunto
 * aporta la etiqueta accesible.
 */

export interface GlyphProps {
  /** Color del trazo. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Escudo (seguridad / alerta de pánico). Espejo de `I.shield`. */
export function IconShield({color, size = 20}: GlyphProps): React.JSX.Element {
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

/** Check (alerta enviada / confirmación). Espejo de `I.check`. */
export function IconCheck({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 12l5 5 9-10"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Escudo con check (alerta CONFIRMADA / emblema "vas protegido"). El pen (EZSxZ, rUe5b) usa
 * `shield-check` de lucide, no un check pelado: mismo escudo del set + check adentro.
 */
export function IconShieldCheck({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M9 11.8l2.1 2.1L15 9.6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Numeral (chip compacto del ID de alerta). Espejo de `hash` de lucide (pen EZSxZ). */
export function IconHash({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Teléfono (CTA "Llamar al 105"). Espejo de `phone` de lucide (pen EZSxZ). */
export function IconPhone({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Pin de ubicación (confirmación "Ubicación compartida"). Espejo de `map-pin` de lucide. */
export function IconMapPin({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={10} r={3} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Grupo de personas (confirmación "Contactos notificados"). Espejo de `users` de lucide. */
export function IconUsers({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={9} cy={7} r={4} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M1 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M16 3.13a4 4 0 0 1 0 7.75M23 21v-2a4 4 0 0 0-3-3.85"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Torre de radio (confirmación "Central VEO en línea"). Espejo de `radio-tower` de lucide. */
export function IconRadioTower({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9M7.8 4.7a6.14 6.14 0 0 0-.8 7.5M16.2 4.8c2 2 2.26 5.11.8 7.47M19.1 1.9a9.96 9.96 0 0 1 0 14.1M9.5 18h5M8 22l4-11 4 11"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={9} r={2} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}
