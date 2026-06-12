import type { TripResource } from '@veo/api-client';
import { Card, ListItem, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { RoutePlace } from '../../../maps/domain/entities';
import type { SavedPlace } from '../../../places/domain/entities';
import { IconStar } from './icons';
import { placeToRoute } from './routePlace';
import { RecentRow } from './RecentRow';
import { SectionHeader } from './SectionHeader';

export interface IdleBodyProps {
  savedPlaces: SavedPlace[];
  recents: TripResource['destination'][];
  onSelect: (place: RoutePlace) => void;
  onSeeAllSaved: () => void;
  onSeeAllRecents: () => void;
}

/**
 * Cuerpo SCROLLABLE del peek: favoritos guardados + recientes, cada sección con "ver todas". Casa y
 * Trabajo NO van acá (son chips del header fijo); acá solo favoritos. El buscador vive en el header.
 */
export function IdleBody({
  savedPlaces,
  recents,
  onSelect,
  onSeeAllSaved,
  onSeeAllRecents,
}: IdleBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const favorites = savedPlaces.filter((p) => p.kind === 'FAVORITE');

  return (
    <>
      {favorites.length > 0 ? (
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t('home.savedTitle')} actionLabel={t('home.seeAll')} onAction={onSeeAllSaved} />
          <Card variant="filled" padding="sm">
            {favorites.map((place) => (
              <ListItem
                key={place.id}
                title={place.label}
                subtitle={place.subtitle}
                leading={<IconStar color={theme.colors.accent} size={20} />}
                chevron
                onPress={() => onSelect(placeToRoute(place))}
              />
            ))}
          </Card>
        </View>
      ) : null}

      {recents.length > 0 ? (
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader
            title={t('home.shortcutRecent')}
            actionLabel={t('home.seeAll')}
            onAction={onSeeAllRecents}
          />
          <Card variant="outlined" padding="sm">
            {recents.map((point, index) => (
              <RecentRow key={`${point.lat}-${point.lon}-${index}`} point={point} onSelect={onSelect} />
            ))}
          </Card>
        </View>
      ) : null}
    </>
  );
}
