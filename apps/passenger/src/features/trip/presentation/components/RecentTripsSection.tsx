import { Card, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { RoutePlace } from '../../../maps/domain/entities';
import { useTripHistory } from '../hooks/useTripHistory';
import { RecentTripRow } from './RecentTripRow';
import { SectionHeader } from './SectionHeader';

/** Cuántos viajes recientes muestra el Home idle (decisión del dueño: los últimos 3). */
const RECENT_TRIPS_LIMIT = 3;

export interface RecentTripsSectionProps {
  /** Re-pedir el viaje: fija el destino del viaje tocado → entra a cotización. */
  onSelect: (place: RoutePlace) => void;
  /** "Ver todas" → pantalla de historial completo. */
  onSeeAll: () => void;
}

/**
 * Sección "Tus últimos viajes" del Home idle: los ÚLTIMOS 3 viajes REALES del historial del servidor
 * (`useTripHistory`, ya cacheado/compartido con el tab Historial). CONSOLIDA y reemplaza la antigua
 * sección de "Recientes" (que deduplicaba solo destinos): acá un viaje se lee como un viaje (destino +
 * cuándo + distancia · duración), y tocarlo RE-PIDE ese destino.
 *
 * DEGRADACIÓN HONESTA: si no hay historial (cuenta nueva, primer uso, u offline sin cache) la sección NO
 * se muestra — no inventamos viajes ni dejamos un bloque vacío.
 */
export function RecentTripsSection({ onSelect, onSeeAll }: RecentTripsSectionProps): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useTranslation();
  const { items } = useTripHistory();

  const recentTrips = items.slice(0, RECENT_TRIPS_LIMIT);

  if (recentTrips.length === 0) {
    return null;
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <SectionHeader
        title={t('home.recentTripsTitle')}
        actionLabel={t('home.seeAll')}
        onAction={onSeeAll}
      />
      <Card variant="outlined" padding="sm">
        {recentTrips.map((trip) => (
          <RecentTripRow key={trip.id} trip={trip} onSelect={onSelect} />
        ))}
      </Card>
    </View>
  );
}
