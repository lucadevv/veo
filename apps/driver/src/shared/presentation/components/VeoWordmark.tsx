import React from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {Circle, Path, Rect} from 'react-native-svg';
import {Text, useTheme} from '@veo/ui-kit';

/**
 * Bandera de Perú estilizada (franjas rojo/blanco/rojo) dibujada como SVG (sin emoji).
 * Vive junto al wordmark para que toda la identidad del conductor salga de un único módulo.
 */
export function PeruFlag({width = 22, height = 14}: {width?: number; height?: number}): React.JSX.Element {
  const unit = width / 3;
  const red = '#D91023';
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={unit} height={height} rx={1.5} fill={red} />
      <Rect x={unit} y={0} width={unit} height={height} fill="#F4F6F8" />
      <Rect x={unit * 2} y={0} width={unit} height={height} rx={1.5} fill={red} />
    </Svg>
  );
}

/** Tamaños del wordmark (tipografía + motivo de ruta escalan juntos). */
export type VeoWordmarkSize = 'sm' | 'md' | 'lg' | 'xl';

/** Variante de composición del lockup. */
export type VeoWordmarkVariant = 'stacked' | 'inline';

export interface VeoWordmarkProps {
  /** Tamaño del lockup: sm (cabeceras) · md · lg · xl (splash). */
  size?: VeoWordmarkSize;
  /** `stacked`: "VEO" sobre "Conductores" centrado. `inline`: marca cian + texto a la derecha. */
  variant?: VeoWordmarkVariant;
  /** Dibuja el motivo de ruta cian con glow (apagado en splash, que ya anima su propia ruta). */
  showRoute?: boolean;
  /** Añade "PERÚ" + bandera bajo el lockup (pantallas de país). */
  peru?: boolean;
}

/** Escala tipográfica de "VEO" por tamaño. */
const VEO_SIZE: Record<VeoWordmarkSize, number> = {sm: 22, md: 30, lg: 56, xl: 84};
/** Escala del sublabel "Conductores" por tamaño. */
const SUB_SIZE: Record<VeoWordmarkSize, number> = {sm: 11, md: 13, lg: 18, xl: 22};
/** Ancho del motivo de ruta por tamaño. */
const ROUTE_WIDTH: Record<VeoWordmarkSize, number> = {sm: 96, md: 120, lg: 180, xl: 240};

/**
 * Motivo de ruta cian del conductor: curva con glow (halo translúcido + línea nítida) que termina
 * en un pin de destino. Mismo lenguaje que la ruta del mapa ("Midnight Motion"), reusado como firma
 * de marca. `pointerEvents="none"`: es decorativo.
 */
function RouteMotif({width, color, glow}: {width: number; color: string; glow: string}): React.JSX.Element {
  const height = Math.round(width * 0.22);
  // viewBox fijo: la curva sube de izquierda a derecha hasta el pin (sello de "llegada").
  const d = 'M6 30 C 40 30, 56 12, 96 12 S 168 8, 184 8';
  return (
    <Svg width={width} height={height} viewBox="0 0 192 40" fill="none" pointerEvents="none">
      <Path d={d} stroke={glow} strokeWidth={11} strokeLinecap="round" fill="none" />
      <Path
        d={d}
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray="1 9"
        fill="none"
      />
      <Circle cx={184} cy={8} r={6} fill={color} />
      <Circle cx={184} cy={8} r={11} stroke={glow} strokeWidth={2} fill="none" />
      <Circle cx={6} cy={30} r={4} fill="none" stroke={color} strokeWidth={3} />
    </Svg>
  );
}

/** Sello compacto "marca" del conductor (badge cian con flecha de ruta) para la variante inline. */
function RouteBadge({size, bg, on}: {size: number; bg: string; on: string}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.badge,
        {width: size, height: size, backgroundColor: bg, borderRadius: theme.radii.lg},
      ]}>
      <Svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <Path d="M12 3 20 20l-8-4-8 4 8-17Z" stroke={on} strokeWidth={2.2} strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}

/** Sub-bloque reutilizable: "PERÚ" + bandera. */
function PeruRow(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.peruRow, {gap: theme.spacing.xs}]}>
      <Text variant="caption" color="inkMuted" style={styles.peruText}>
        PERÚ
      </Text>
      <PeruFlag />
    </View>
  );
}

/**
 * Wordmark único de VEO Conductores: "VEO" en cian + sublabel "Conductores" + motivo de ruta cian
 * con glow. Centraliza la identidad del conductor (splash, onboarding, login, registro y revisión)
 * en un solo componente basado en tokens del tema (`accent`, `brand`, `ink`). Reemplaza los logos
 * ad-hoc dispersos para garantizar una sola marca consistente.
 */
export function VeoWordmark({
  size = 'md',
  variant = 'stacked',
  showRoute = true,
  peru = false,
}: VeoWordmarkProps): React.JSX.Element {
  const theme = useTheme();
  const veoSize = VEO_SIZE[size];
  const subSize = SUB_SIZE[size];
  // Glow cian translúcido derivado del acento del tema (mismo halo que la ruta del mapa).
  const glow = hexAlpha(theme.colors.accent, 0.3);

  if (variant === 'inline') {
    const badgeSize = veoSize + 22;
    return (
      <View style={[styles.inlineWrap, {gap: theme.spacing.md}]}>
        <RouteBadge size={badgeSize} bg={theme.colors.accent} on={theme.colors.onAccent} />
        <View>
          <Text
            variant="title2"
            color="ink"
            style={[styles.veo, {fontSize: veoSize, lineHeight: veoSize * 1.05}]}>
            VEO
          </Text>
          <Text variant="label" color="brand" style={[styles.subInline, {fontSize: subSize}]}>
            CONDUCTORES
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {showRoute ? <RouteMotif width={ROUTE_WIDTH[size]} color={theme.colors.accent} glow={glow} /> : null}
      <Text
        variant="title1"
        color="accent"
        style={[styles.veo, styles.veoStacked, {fontSize: veoSize, lineHeight: veoSize * 1.05}]}>
        VEO
      </Text>
      <Text variant="label" color="brand" style={[styles.sub, {fontSize: subSize}]}>
        CONDUCTORES
      </Text>
      {peru ? <PeruRow /> : null}
    </View>
  );
}

/**
 * Aplica alpha a un color hex de 6 dígitos (#RRGGBB → #RRGGBBAA). Si no es hex de 6 dígitos
 * (rgba/transparent), lo devuelve igual. Local para no acoplar el wordmark a un feature.
 */
function hexAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return color;
  }
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${a}`.toUpperCase();
}

const styles = StyleSheet.create({
  wrap: {alignItems: 'center', gap: 2},
  veo: {fontWeight: '800'},
  veoStacked: {letterSpacing: 1},
  sub: {letterSpacing: 4, marginTop: -2},
  subInline: {letterSpacing: 2},
  inlineWrap: {flexDirection: 'row', alignItems: 'center'},
  badge: {alignItems: 'center', justifyContent: 'center'},
  peruRow: {flexDirection: 'row', alignItems: 'center', marginTop: 4},
  peruText: {letterSpacing: 1},
});
