import {Avatar, Card, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import type {LastDriver} from '../hooks/useLastDriver';
import {IconStarFilled} from './icons';

export interface LastDriverCardProps {
  driver: LastDriver;
}

/** Cantidad de estrellas de la escala de rating (1..5). */
const STAR_SCALE = 5;

/**
 * Tarjeta del ÚLTIMO conductor con quien viajó el pasajero (atajo de confianza del Home idle, fiel a
 * la referencia: avatar + nombre + vehículo + ★★★★★). La rinde el Home SOLO cuando hay un conductor
 * real (`useLastDriver` devuelve `null` si no hay historial con conductor): nunca se inventa el dato.
 *
 * Degrada con gracia campo a campo: sin nombre cae a "Tu último conductor"; sin vehículo o sin rating
 * esas filas no se pintan (no muestra placeholders falsos). El rating se redondea a la estrella entera
 * más cercana para la escala visual; la cifra exacta acompaña al lado.
 */
export function LastDriverCard({
  driver,
}: LastDriverCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const name = driver.name ?? t('home.lastDriverTitle');
  const filledStars = driver.rating != null ? Math.round(driver.rating) : 0;

  return (
    <Card variant="elevated" padding="lg" style={styles.card}>
      <View style={[styles.row, {gap: theme.spacing.md}]}>
        <Avatar name={driver.name ?? undefined} size="lg" />
        <View style={styles.identity}>
          <Text variant="headline" color="ink" numberOfLines={1}>
            {name}
          </Text>
          {driver.vehicleLabel ? (
            <Text variant="footnote" color="inkMuted" numberOfLines={1}>
              {driver.vehicleLabel}
            </Text>
          ) : null}
        </View>
        {driver.rating != null ? (
          <View style={[styles.rating, {gap: theme.spacing.xs}]}>
            <View style={styles.stars}>
              {Array.from({length: STAR_SCALE}).map((_, index) => (
                <IconStarFilled
                  key={index}
                  size={14}
                  color={
                    index < filledStars
                      ? theme.colors.warn
                      : theme.colors.borderStrong
                  }
                />
              ))}
            </View>
            <Text variant="caption" color="inkMuted">
              {driver.rating.toFixed(1)}
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {alignSelf: 'stretch'},
  row: {flexDirection: 'row', alignItems: 'center'},
  identity: {flex: 1, justifyContent: 'center'},
  rating: {alignItems: 'flex-end'},
  stars: {flexDirection: 'row', gap: 2},
});
