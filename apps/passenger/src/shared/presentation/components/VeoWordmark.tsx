import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View, type ViewStyle} from 'react-native';
import {RouteMotif} from './RouteMotif';

/** Color de marca admitido (mismo contrato de color que el `Text` del ui-kit: token del tema). */
type BrandColor = NonNullable<React.ComponentProps<typeof Text>['color']>;

/** Tamaño del wordmark. Define tipografía y proporciones del motivo de ruta. */
export type VeoWordmarkSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Variante de composición:
 *  - `wordmark`: solo el wordmark "VEO".
 *  - `route`: wordmark + motivo de ruta lima punteada con glow.
 *  - `tagline`: wordmark + tagline corta debajo.
 */
export type VeoWordmarkVariant = 'wordmark' | 'route' | 'tagline';

export interface VeoWordmarkProps {
  /** Tamaño tipográfico/proporción. Por defecto `lg`. */
  size?: VeoWordmarkSize;
  /** Composición. Por defecto `wordmark`. */
  variant?: VeoWordmarkVariant;
  /** Color del wordmark (token del tema). Por defecto `brand` (lima). */
  color?: BrandColor;
  /** Tagline a mostrar en la variante `tagline`. Por defecto la tagline de marca Perú. */
  tagline?: string;
  /** Si el motivo de ruta se dibuja animado al montar (solo `route`). */
  animated?: boolean;
  /** Alineación horizontal del grupo. Por defecto `center`. */
  align?: 'center' | 'left';
  style?: ViewStyle | ViewStyle[];
  /** Etiqueta accesible del logotipo (por defecto "VEO"). */
  accessibilityLabel?: string;
}

interface SizeSpec {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  motifWidth: number;
  motifHeight: number;
  motifOffset: number;
  taglineVariant: React.ComponentProps<typeof Text>['variant'];
}

/** Proporciones por tamaño (el motivo se alinea bajo el wordmark con un solape sutil). */
const SIZES: Record<VeoWordmarkSize, SizeSpec> = {
  sm: {
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: 0.5,
    motifWidth: 84,
    motifHeight: 26,
    motifOffset: -6,
    taglineVariant: 'caption',
  },
  md: {
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.4,
    motifWidth: 110,
    motifHeight: 34,
    motifOffset: -8,
    taglineVariant: 'caption',
  },
  lg: {
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -1,
    motifWidth: 150,
    motifHeight: 44,
    motifOffset: -12,
    taglineVariant: 'callout',
  },
  xl: {
    fontSize: 72,
    lineHeight: 90,
    letterSpacing: 3,
    motifWidth: 240,
    motifHeight: 64,
    motifOffset: -18,
    taglineVariant: 'callout',
  },
};

/**
 * Logotipo VEO reutilizable: wordmark + (opcional) motivo de ruta lima o tagline. Es la ÚNICA
 * fuente de la identidad del pasajero en el flujo de ingreso (Splash/Onboarding/Auth/Completar
 * perfil): centraliza tipografía, color y proporciones con tokens del tema.
 *
 * Nota de implementación: el wordmark "VEO" es tipografía (`Text` del ui-kit, igual que el conductor)
 * y el motivo de ruta se dibuja con `react-native-svg` (ver `RouteMotif`), parametrizable por
 * color/tamaño. El color del wordmark y del motivo sale del tema (`theme.colors[color]`).
 *
 * NATIVO: `react-native-svg` requiere `pod install` (iOS) y un rebuild nativo tras instalarse.
 */
export function VeoWordmark({
  size = 'lg',
  variant = 'wordmark',
  color = 'brand',
  tagline,
  animated = false,
  align = 'center',
  style,
  accessibilityLabel,
}: VeoWordmarkProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const spec = SIZES[size];
  const wordmark = t('appName');
  const resolvedTagline = tagline ?? t('brandTaglinePeru');

  return (
    <View
      style={[align === 'center' ? styles.center : styles.left, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? wordmark}>
      <Text
        color={color}
        align={align === 'center' ? 'center' : 'left'}
        style={{
          fontSize: spec.fontSize,
          lineHeight: spec.lineHeight,
          fontWeight: '700',
          letterSpacing: spec.letterSpacing,
        }}>
        {wordmark}
      </Text>

      {variant === 'route' ? (
        <RouteMotif
          width={spec.motifWidth}
          height={spec.motifHeight}
          color={theme.colors[color]}
          animated={animated}
          style={{marginTop: spec.motifOffset}}
        />
      ) : null}

      {variant === 'tagline' ? (
        <Text
          variant={spec.taglineVariant}
          color="inkMuted"
          align={align === 'center' ? 'center' : 'left'}
          style={styles.tagline}>
          {resolvedTagline}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {alignItems: 'center'},
  left: {alignItems: 'flex-start'},
  tagline: {marginTop: 4},
});
