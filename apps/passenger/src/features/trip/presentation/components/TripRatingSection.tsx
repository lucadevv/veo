import {Button, Card, Text, useTheme} from '@veo/ui-kit';
import {useQueryClient} from '@tanstack/react-query';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {RatingBody} from '../../../ratings/presentation/components/RatingBody';
import {
  myTripRatingKey,
  useMyTripRating,
} from '../../../ratings/presentation/useMyTripRating';
import {RatingSheet} from './RatingSheet';

export interface TripRatingSectionProps {
  tripId: string;
  driverId: string;
  /** Estrellas embebidas en el detalle (`tripActiveView.myRatingStars`): pinta el estado SIN un GET extra. */
  embeddedStars: number | null;
  /** Tras calificar: refresca el detalle (re-trae `myRatingStars`) además del cache de rating. */
  onRated: () => void;
}

/** Estrellas de solo-lectura (★ llenas / ☆ vacías) con el mismo carácter tipográfico del selector. */
function ReadOnlyStars({value}: {value: number}): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <View
      style={styles.stars}
      accessibilityRole="image"
      accessibilityLabel={t('ratings.givenStars', {stars: value})}>
      {[1, 2, 3, 4, 5].map(star => (
        <Text
          key={star}
          variant="title3"
          color={star <= value ? 'warn' : 'inkSubtle'}>
          {star <= value ? '★' : '☆'}
        </Text>
      ))}
    </View>
  );
}

/**
 * Estado de CALIFICACIÓN integrado en el detalle del viaje. Dos caras:
 *  - YA calificado → tarjeta de solo-lectura: "Calificaste este viaje" + tus estrellas + tu comentario
 *    (si dejaste uno). Cierra el bucle de forma honesta; no vuelve a pedir lo ya hecho.
 *  - SIN calificar → CTA claro "Califica tu viaje" que abre el `RatingBody` CANÓNICO en un sheet (el
 *    mismo que maneja el 409 "ya calificaste" con gracia). Al terminar, invalida el cache y refresca el
 *    detalle, que vuelve pintado como "ya calificado". Sin navegar a la pantalla cruda que ignora el 409.
 *
 * Fuente de verdad: las estrellas vienen embebidas en el detalle (`myRatingStars`); el comentario se
 * pide perezosamente vía `useMyTripRating` SOLO cuando hay calificación (1 GET, cacheado), porque el
 * detalle no embebe el texto.
 */
export function TripRatingSection({
  tripId,
  driverId,
  embeddedStars,
  onRated,
}: TripRatingSectionProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);

  const rated = embeddedStars != null;

  // Comentario (y confirmación) solo si ya hay calificación. Cacheado y compartido con el historial.
  const ratingQuery = useMyTripRating(tripId, {enabled: rated});
  const stars = ratingQuery.data?.stars ?? embeddedStars;
  const comment = ratingQuery.data?.comment?.trim();

  const handleDone = (): void => {
    setSheetOpen(false);
    // Refresca ambas verdades: el cache por-viaje (lista + esta sección) y el detalle (myRatingStars).
    void queryClient.invalidateQueries({queryKey: myTripRatingKey(tripId)});
    onRated();
  };

  if (rated && stars != null) {
    return (
      <Card variant="outlined" padding="lg">
        <Text variant="footnote" color="inkMuted">
          {t('ratings.yourRating')}
        </Text>
        <View style={[styles.ratedHeader, {marginTop: theme.spacing.xs}]}>
          <Text variant="bodyStrong">{t('ratings.youRated')}</Text>
          <ReadOnlyStars value={stars} />
        </View>
        {comment ? (
          <Text
            variant="callout"
            color="inkMuted"
            style={{marginTop: theme.spacing.sm}}>
            {comment}
          </Text>
        ) : null}
      </Card>
    );
  }

  return (
    <>
      <Card variant="filled" padding="lg">
        <Text variant="bodyStrong">{t('ratings.ctaTitle')}</Text>
        <Text
          variant="callout"
          color="inkMuted"
          style={{marginTop: theme.spacing.xs}}>
          {t('ratings.ctaBody')}
        </Text>
        <Button
          label={t('ratings.ctaButton')}
          variant="accent"
          fullWidth
          onPress={() => setSheetOpen(true)}
          style={{marginTop: theme.spacing.md}}
        />
      </Card>

      <RatingSheet visible={sheetOpen} onClose={() => setSheetOpen(false)}>
        <RatingBody tripId={tripId} driverId={driverId} onDone={handleDone} />
      </RatingSheet>
    </>
  );
}

const styles = StyleSheet.create({
  stars: {flexDirection: 'row', gap: 2},
  ratedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
});
