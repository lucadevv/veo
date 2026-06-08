import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { PressableScale } from '../../../../shared/presentation/components/motion';

export interface OtpKeypadProps {
  /** Agrega un dígito al código (el padre recorta a la longitud máxima). */
  onPress: (digit: string) => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * Teclado numérico propio del paso OTP (fiel al diseño: grilla 1-9 en 3 columnas + 0 a ancho
 * completo, altura 44, gap 9). Coexiste con el `OtpField`: ambos escriben el mismo `code` vía el
 * callback `onPress` del padre, sin romper el autofill SMS del `OtpField`. Cada tecla tiene área
 * táctil ≥44pt y etiqueta accesible.
 */
export function OtpKeypad({ onPress }: OtpKeypadProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const keyStyle = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.radii.md,
  } as const;

  return (
    <View
      accessibilityLabel={t('auth.otpKeypadLabel')}
      style={[styles.grid, { gap: KEY_GAP }]}
    >
      {KEYS.map((digit) => (
        <PressableScale
          key={digit}
          accessibilityRole="button"
          accessibilityLabel={t('auth.otpKeyLabel', { digit })}
          onPress={() => onPress(digit)}
          contentStyle={[styles.key, keyStyle]}
        >
          <Text variant="title3" tabular>
            {digit}
          </Text>
        </PressableScale>
      ))}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('auth.otpKeyLabel', { digit: '0' })}
        onPress={() => onPress('0')}
        contentStyle={[styles.keyWide, keyStyle]}
      >
        <Text variant="title3" tabular>
          0
        </Text>
      </PressableScale>
    </View>
  );
}

/** Gap del diseño (9px) entre teclas. */
const KEY_GAP = 9;
/** Altura del diseño (44px = área táctil mínima). */
const KEY_HEIGHT = 44;

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // 3 columnas con gap 9: (100% - 2·9) / 3 ≈ 30% (medida del diseño).
  key: {
    width: '30%',
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  keyWide: {
    width: '100%',
    height: KEY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
