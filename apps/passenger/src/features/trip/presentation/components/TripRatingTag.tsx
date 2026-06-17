import { hexAlpha, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { IconStarFilled } from './icons';

export interface TripRatingTagProps {
  /** Estrellas dadas (1–5) si el viaje YA fue calificado; `null` = aún sin calificar (nudge). */
  stars: number | null;
  /** Mientras se resuelve la consulta de rating no mostramos nada (evita parpadeo nudge↔score). */
  loading?: boolean;
}

/**
 * Sello de calificación de una fila del historial. Dos lecturas, una sola pieza:
 *  - SIN calificar → invitación cálida "Califica tu viaje" (tinte de marca, NO un rojo de error).
 *    Es un empujón, no un castigo: el viaje ya está cerrado, calificar es un regalo al conductor.
 *  - YA calificado → "★ N" compacto y discreto: cierra el bucle sin gritar.
 * El color nunca es el único indicador (siempre hay texto/ícono). Solo aplica a viajes completados.
 */
export function TripRatingTag({ stars, loading = false }: TripRatingTagProps): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useTranslation();

  if (loading) {
    return null;
  }

  if (stars == null) {
    return (
      <View
        style={[styles.nudge, { backgroundColor: hexAlpha(theme.colors.brand, theme.scheme === 'dark' ? 0.18 : 0.12) }]}
        accessibilityRole="text"
        accessibilityLabel={t('history.rateNudge')}
      >
        <IconStarFilled color={theme.colors.brand} size={12} />
        <Text variant="label" color="brand" numberOfLines={1}>
          {t('history.rateNudge')}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={styles.score}
      accessibilityRole="text"
      accessibilityLabel={t('history.ratedValue', { stars })}
    >
      <IconStarFilled color={theme.colors.warn} size={13} />
      <Text variant="subhead" color="inkMuted" tabular>
        {stars}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  score: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
