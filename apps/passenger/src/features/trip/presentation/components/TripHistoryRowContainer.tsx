import type {TripHistoryItem, TripStatus} from '@veo/api-client';
import React from 'react';
import {useMyTripRating} from '../hooks/useMyTripRating';
import {TripHistoryRow} from './TripHistoryRow';

export interface TripHistoryRowContainerProps {
  trip: TripHistoryItem;
  onPress: () => void;
}

/**
 * Conecta una fila del historial con su calificación. La consulta SOLO se habilita para viajes
 * COMPLETADOS con conductor (los únicos calificables): cancelados/vivos no piden nada. Como la
 * `SectionList` solo monta filas visibles y el cache es largo (30 min, calificación inmutable), esto
 * es un fan-out acotado y cacheado, NO un N+1 ciego. Mantiene la fila presentacional (sin server-state).
 */
export function TripHistoryRowContainer({
  trip,
  onPress,
}: TripHistoryRowContainerProps): React.JSX.Element {
  const status = trip.status.toUpperCase() as TripStatus;
  const rateable = status === 'COMPLETED' && trip.driverId != null;

  const ratingQuery = useMyTripRating(trip.id, {enabled: rateable});

  return (
    <TripHistoryRow
      trip={trip}
      ratingStars={rateable ? (ratingQuery.data?.stars ?? null) : undefined}
      ratingLoading={rateable && ratingQuery.isLoading}
      onPress={onPress}
    />
  );
}
