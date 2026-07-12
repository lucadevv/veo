import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useTheme } from '@veo/ui-kit';

/**
 * Círculo de cuenta atrás (frame OfferSheet / C/Puja del board): pastilla circular con borde teal,
 * el número de segundos grande + la unidad debajo. Componente canónico reusado en TripIncoming (oferta)
 * y en la Puja (contraoferta) — antes se dibujaba inline en cada pantalla.
 */
export interface CountdownBadgeProps {
  /** Segundos restantes a mostrar. */
  seconds: number;
  /** Diámetro del círculo. Default 56 (board). */
  size?: number;
  style?: ViewStyle;
}

export function CountdownBadge({ seconds, size = 56, style }: CountdownBadgeProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          // Brand-dim (container del primary) + borde teal — token del sistema, no rgba suelto.
          backgroundColor: theme.colors.brandDim,
          borderColor: theme.colors.accent,
        },
        style,
      ]}
    >
      <Text variant="title3" color="accent" tabular style={styles.num}>
        {seconds}
      </Text>
      <Text color="accent" style={styles.unit}>
        {t('trips.secondsShort')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  num: { fontSize: 20, lineHeight: 22 },
  unit: { fontSize: 9, lineHeight: 11, fontWeight: '500' },
});
