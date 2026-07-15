import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { Text, useTheme } from '@veo/ui-kit';

/**
 * Bandera de Perú estilizada (franjas rojo/blanco/rojo) dibujada como SVG (sin emoji).
 * Vive junto al wordmark para que toda la identidad del conductor salga de un único módulo.
 */
export function PeruFlag({
  width = 22,
  height = 14,
}: {
  width?: number;
  height?: number;
}): React.JSX.Element {
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

/** Tamaños del wordmark. */
export type VeoWordmarkSize = 'sm' | 'md' | 'lg' | 'xl';

/** Variante de composición del lockup. */
export type VeoWordmarkVariant = 'stacked' | 'inline';

export interface VeoWordmarkProps {
  /** Tamaño del lockup: sm (cabeceras) · md · lg · xl (splash). */
  size?: VeoWordmarkSize;
  /** `stacked`: "VEO" sobre "CONDUCTORES" centrado. `inline`: "VEO" + "CONDUCTORES" a la izquierda. */
  variant?: VeoWordmarkVariant;
  /** Añade "PERÚ" + bandera bajo el lockup (pantallas de país). */
  peru?: boolean;
  /**
   * Color de "VEO" en el lockup stacked. Default `accent` (cian) — la identidad en headers/estados.
   * El splash lo pide `ink` (blanco) sobre el fondo oscuro, como el frame del pen. Solo aplica al stacked.
   */
  veoColor?: 'accent' | 'ink';
  /**
   * Color de "CONDUCTORES" (sublabel) en el stacked. Default `brand` (azul) — headers/estados. El splash
   * lo pide `inkSubtle` (gris sutil), como el frame del pen. Solo aplica al stacked.
   */
  subColor?: 'brand' | 'inkSubtle';
  /**
   * Muestra el sublabel "CONDUCTORES" (y "PERÚ" si `peru`). Default `true`. El header del wizard lo pide
   * `false` → solo "VEO", como el frame del pen. Solo aplica al stacked.
   */
  sublabel?: boolean;
}

/** Escala tipográfica de "VEO" por tamaño. `xl` = splash, calibrado al frame del pen (60). */
const VEO_SIZE: Record<VeoWordmarkSize, number> = { sm: 22, md: 30, lg: 56, xl: 60 };
/** Escala del sublabel "Conductores" por tamaño. `xl` = splash, al frame del pen (13). */
const SUB_SIZE: Record<VeoWordmarkSize, number> = { sm: 11, md: 13, lg: 18, xl: 13 };

/** Sub-bloque reutilizable: "PERÚ" + bandera. */
function PeruRow(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.peruRow, { gap: theme.spacing.xs }]}>
      <Text variant="caption" color="inkMuted" style={styles.peruText}>
        PERÚ
      </Text>
      <PeruFlag />
    </View>
  );
}

/**
 * Wordmark único de VEO Conductores: tipografía pura — "VEO" + sublabel "CONDUCTORES" (sin motivo de
 * ruta ni badge: dirección Tesla, la marca es la tipografía y el aire). Centraliza la identidad del
 * conductor (splash, onboarding, login, registro y revisión) en un solo componente basado en tokens
 * del tema (`accent`, `brand`, `ink`). Reemplaza los logos ad-hoc dispersos por una sola marca.
 */
export function VeoWordmark({
  size = 'md',
  variant = 'stacked',
  peru = false,
  veoColor = 'accent',
  subColor = 'brand',
  sublabel = true,
}: VeoWordmarkProps): React.JSX.Element {
  const veoSize = VEO_SIZE[size];
  const subSize = SUB_SIZE[size];

  if (variant === 'inline') {
    // Lockup tipográfico puro (dirección Tesla): "VEO" con tracking ancho + "CONDUCTORES" como
    // label azul fino debajo. Sin badge/ícono — la marca es la tipografía y el aire, no un sello.
    return (
      <View style={styles.inlineWrap}>
        <Text
          variant="title2"
          color="ink"
          style={[styles.veoInline, { fontSize: veoSize, lineHeight: veoSize * 1.05 }]}
        >
          VEO
        </Text>
        <Text variant="label" color="brand" style={[styles.subInline, { fontSize: subSize }]}>
          CONDUCTORES
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text
        variant="title1"
        color={veoColor}
        style={[styles.veo, styles.veoStacked, { fontSize: veoSize, lineHeight: veoSize * 1.05 }]}
      >
        VEO
      </Text>
      {sublabel ? (
        <Text variant="label" color={subColor} style={[styles.sub, { fontSize: subSize }]}>
          CONDUCTORES
        </Text>
      ) : null}
      {sublabel && peru ? <PeruRow /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 2 },
  veo: { fontWeight: '800' },
  veoStacked: { letterSpacing: 1 },
  sub: { letterSpacing: 4, marginTop: -2 },
  subInline: { letterSpacing: 3, marginTop: 1 },
  inlineWrap: { alignItems: 'flex-start' },
  veoInline: { fontWeight: '800', letterSpacing: 2 },
  peruRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  peruText: { letterSpacing: 1 },
});
