import React from 'react';
import Svg, {Circle, Path} from 'react-native-svg';

/**
 * Set de iconos del flujo de KYC (intro + stepper del reto de liveness) dibujados con
 * `react-native-svg`. Mismo patrón que los sets vecinos (`panic/.../icons.tsx`,
 * `profile/.../icons.tsx`): viewBox 24×24, trazo ~2px, color por prop. Decorativos: el texto
 * adjunto (chip del stepper / instrucción) aporta la etiqueta accesible.
 */

export interface GlyphProps {
  /** Color del trazo. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Silueta de persona (óvalo guía del intro). Espejo de `user` de lucide (pen jPGX1). */
export function IconUser({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Escaneo de rostro (chip "Rostro" del stepper). Espejo de `scan-face` de lucide. */
export function IconScanFace({
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
      <Path
        d="M9 9h.01M15 9h.01M8.5 14a4 4 0 0 0 7 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Ojo (chip "Parpadeo"/gesto del stepper). Espejo de `eye` de lucide (pen jPGX1). */
export function IconEye({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Check (chip "Listo" del stepper). Mismo trazo del set. */
export function IconCheck({color, size = 22}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 12l5 5 9-10"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
