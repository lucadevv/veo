import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * Set de iconos del flujo de ingreso dibujados con `react-native-svg` (ya instalado y enlazado en la
 * app — lo usa también `shared/.../RouteMotif`). Trazos vectoriales nítidos a cualquier escala,
 * trazo consistente (~2px), color por prop, fieles al diseño canónico (viewBox 24×24).
 * Decorativos: el consumidor aporta la etiqueta accesible en el contenedor presionable.
 */

export interface GlyphProps {
  /** Color del trazo/relleno. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Chevron hacia la izquierda (volver). Espejo del `chevR` del diseño. */
export function IconChevronLeft({ color, size = 22 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 6l-6 6 6 6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Marca de verificación (check). */
export function IconCheck({ color, size = 16 }: GlyphProps): React.JSX.Element {
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

/** Reloj (cuenta regresiva de reenvío). */
export function IconClock({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={STROKE} />
      <Path d="M12 7v5l3 2" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Lápiz (editar / cambiar número). Feather `edit-2`. */
export function IconPencil({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export interface CameraProps extends GlyphProps {
  /** Color del "hueco" del lente (igual al fondo del botón). */
  holeColor: string;
}

/** Cámara (FAB para agregar foto de perfil). */
export function IconCamera({ color, holeColor, size = 22 }: CameraProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12.5} r={3.2} stroke={color} strokeWidth={STROKE} fill={holeColor} />
    </Svg>
  );
}

/** Silueta de persona (placeholder de avatar). Feather `user`. */
export function IconPerson({ color, size = 56 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
      <Path
        d="M4 21a8 8 0 0 1 16 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export interface ShieldCheckProps extends GlyphProps {
  /** Color del check sobre el campo del escudo (contraste con `color`). */
  onColor: string;
}

/** Insignia de seguridad (escudo) con check interior. */
export function IconShieldCheck({ color, onColor, size = 18 }: ShieldCheckProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"
        fill={color}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M8.5 12.2l2.4 2.4 4.6-5"
        stroke={onColor}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Sobre / correo (continuar con correo). Feather `mail`. */
export function IconMail({ color, size = 20 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={5} width={18} height={14} rx={2} stroke={color} strokeWidth={STROKE} />
      <Path
        d="m3 7 9 6 9-6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Teléfono / auricular (continuar con teléfono). Handset del diseño canónico. */
export function IconPhone({ color, size = 20 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L19 16l-1 3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M16 21a13 13 0 0 1-13-13"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Logo oficial de Apple (manzana) para el botón "Continuar con Apple". Apple HIG permite un botón
 * custom siempre que use el LOGO de Apple + texto aprobado. Es un glyph relleno de un solo trazo,
 * tintado por `color` (usamos `theme.colors.ink`, igual que IconMail/IconPhone). viewBox 24×24.
 */
export function IconApple({ color, size = 20 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M16.36 12.78c.02 2.2 1.93 2.94 1.95 2.95-.02.05-.31 1.05-1.02 2.08-.61.9-1.25 1.79-2.26 1.81-.99.02-1.31-.59-2.44-.59s-1.49.57-2.42.61c-.97.04-1.71-.97-2.33-1.86-1.27-1.84-2.24-5.19-.94-7.46.65-1.12 1.8-1.84 3.06-1.86.96-.02 1.86.64 2.44.64.58 0 1.68-.79 2.83-.68.48.02 1.83.19 2.7 1.46-.07.04-1.61.94-1.59 2.8zM14.54 6.6c.51-.62.86-1.49.77-2.35-.74.03-1.64.49-2.17 1.11-.47.55-.89 1.43-.78 2.27.83.07 1.67-.42 2.18-1.03z"
        fill={color}
      />
    </Svg>
  );
}

/**
 * Marca de un proveedor de identidad de terceros (Google "G", Facebook "f", etc.) dibujada como
 * insignia circular SVG con la inicial centrada. El color de marca explícito viene por prop (lo
 * pide el diseño: letra-badge limpia, no logo multicolor).
 */
export interface BrandBadgeProps {
  /** Letra de la marca (p. ej. "G" o "f"). */
  letter: string;
  /** Color de fondo de la insignia (color de marca de terceros). */
  background: string;
  /** Color de la letra (normalmente blanco). */
  foreground: string;
  /** Diámetro de la insignia (px). */
  size?: number;
}

/** Glyphs vectoriales de las iniciales de marca, centrados en un viewBox 24×24. */
const BRAND_LETTER_PATHS: Record<string, string> = {
  // "G" geométrica con barra interior (estilo Google wordmark, en blanco sobre el círculo).
  G: 'M12 6.4a5.6 5.6 0 1 0 5.4 7H12V11h7.4a8 8 0 1 1-2.3-6.1l-1.8 1.8A5.55 5.55 0 0 0 12 6.4Z',
  // "f" de Facebook.
  f: 'M14.4 8.2h-1.3c-.5 0-.8.3-.8.9V11h2.1l-.3 2.2h-1.8V19h-2.3v-5.8H8.4V11h1.6V8.7c0-1.9 1.1-3 2.9-3 .9 0 1.5.1 1.5.1Z',
};

/** Insignia circular con inicial vectorial para proveedores de login social. */
export function BrandBadge({
  letter,
  background,
  foreground,
  size = 20,
}: BrandBadgeProps): React.JSX.Element {
  const path = BRAND_LETTER_PATHS[letter];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={12} fill={background} />
      {path ? <Path d={path} fill={foreground} /> : null}
    </Svg>
  );
}

/**
 * Ícono de WhatsApp: glyph oficial del logo (auricular dentro de la burbuja con cola). Path limpio
 * de un solo trazo relleno, tintado por `color` (color de marca #25D366 lo aporta el consumidor).
 */
export function IconWhatsapp({ color, size = 20 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.5A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.9.9-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2Z"
        fill={color}
      />
      <Path
        d="M9.1 7.4c-.2-.5-.4-.5-.6-.5h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-1 2.3c0 1.3 1 2.6 1.1 2.8s1.9 3 4.7 4.1c2.3 1 2.8.8 3.3.7s1.5-.6 1.7-1.2.2-1.1.2-1.2l-.5-.3-1.7-.8c-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.3 7.3 0 0 1-1.3-1.7c-.1-.2 0-.4.1-.5l.4-.5a1.8 1.8 0 0 0 .3-.4.5.5 0 0 0 0-.5c0-.1-.6-1.5-.8-2.1Z"
        fill={color}
      />
    </Svg>
  );
}

/** Ojo (insignia de marca del paso inicial). */
export function IconEye({ color, size = 22 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Candado (pantalla de sesión expirada). */
export function IconLock({ color, size = 24 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={10} width={16} height={11} rx={2.5} stroke={color} strokeWidth={STROKE} />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}
