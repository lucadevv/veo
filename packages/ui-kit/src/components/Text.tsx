import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type TextStyleToken } from '../tokens/typography';
import { type ThemeColors } from '../tokens/themes';

export interface TextProps extends RNTextProps {
  /** Rol tipográfico (escala VEO). Por defecto `body`. */
  variant?: TextStyleToken;
  /** Color por token semántico. Por defecto `ink`. */
  color?: keyof ThemeColors;
  /** Atajo de alineación. */
  align?: TextStyle['textAlign'];
  /** Números tabulares (tarifas, ETAs, timers, placas). */
  tabular?: boolean;
}

/**
 * Texto tematizado. Toda tipografía de la app pasa por aquí: nada de tamaños/colores sueltos.
 * Soporta Dynamic Type del sistema (no fija `allowFontScaling`).
 */
export function Text({
  variant = 'body',
  color = 'ink',
  align,
  tabular = false,
  style,
  children,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const token = theme.typography.text[variant];

  return (
    <RNText
      style={[
        {
          fontFamily: token.fontFamily,
          fontSize: token.fontSize,
          lineHeight: token.lineHeight,
          fontWeight: token.fontWeight,
          letterSpacing: token.letterSpacing,
          color: theme.colors[color],
          textAlign: align,
          fontVariant: tabular ? ['tabular-nums'] : undefined,
          // Android agrega padding vertical FANTASMA a cada Text (ascent/descent de la fuente):
          // rompe el ritmo vertical de todo lo que apila texto (cards, filas, héroes). Apagarlo
          // app-wide es el detalle que hace que Android se vea tan intencional como iOS.
          includeFontPadding: false,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
