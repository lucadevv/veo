import type { MapPoint, TripResource } from '@veo/api-client';
import { useQuery } from '@tanstack/react-query';
import { ListItem, useTheme } from '@veo/ui-kit';
import React, { useMemo } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RoutePlace } from '../../../maps/domain/entities';
import { IconPin } from './icons';

export interface RecentRowProps {
  point: TripResource['destination'];
  onSelect: (place: RoutePlace) => void;
}

/** Fila de destino reciente: etiqueta el punto con geocoding inverso real y, al tocar, lo fija. */
export function RecentRow({ point, onSelect }: RecentRowProps): React.JSX.Element | null {
  const theme = useTheme();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const mapPoint = useMemo<MapPoint>(() => ({ lat: point.lat, lng: point.lon }), [point]);

  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', mapPoint.lat, mapPoint.lng],
    queryFn: () => reverseGeocode.execute(mapPoint),
    staleTime: 5 * 60_000,
  });

  if (!labelQuery.data) {
    return null;
  }

  return (
    <ListItem
      title={labelQuery.data.title}
      subtitle={labelQuery.data.subtitle}
      leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
      onPress={() =>
        onSelect({
          point: { lat: labelQuery.data!.lat, lng: labelQuery.data!.lng },
          title: labelQuery.data!.title,
          subtitle: labelQuery.data!.subtitle,
        })
      }
    />
  );
}
