import {Card, ListItem, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import type {RoutePlace} from '../../../maps/domain/entities';
import type {SavedPlace} from '../../../places/domain/entities';
import {IconStar} from './icons';
import {placeToRoute} from './routePlace';
import {RecentTripsSection} from './RecentTripsSection';
import {SectionHeader} from './SectionHeader';

export interface IdleBodyProps {
  savedPlaces: SavedPlace[];
  onSelect: (place: RoutePlace) => void;
  onSeeAllSaved: () => void;
  onSeeAllRecents: () => void;
}

/**
 * Cuerpo SCROLLABLE del peek: favoritos guardados + "Tus últimos viajes". Casa y Trabajo NO van acá (son
 * chips del header fijo); acá solo favoritos. El buscador vive en el header.
 *
 * "Tus últimos viajes" (sección propia, data-driven desde `useTripHistory`) CONSOLIDA la antigua sección
 * de "Recientes": un solo bloque claro de viajes reales (no dos que se pisen). Se oculta sola si no hay
 * historial (degradación honesta).
 */
export function IdleBody({
  savedPlaces,
  onSelect,
  onSeeAllSaved,
  onSeeAllRecents,
}: IdleBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const favorites = savedPlaces.filter(p => p.kind === 'FAVORITE');

  return (
    // View con gap (no fragment): en el pen ambas secciones son hijas directas del HomeContent y
    // reciben su gap $s-lg — como fragment quedaban PEGADAS (el gap del scroll no llega adentro).
    <View style={{gap: theme.spacing.lg}}>
      {favorites.length > 0 ? (
        <View style={{gap: theme.spacing.sm}}>
          <SectionHeader
            title={t('home.savedTitle')}
            actionLabel={t('home.seeAll')}
            onAction={onSeeAllSaved}
          />
          <Card variant="filled" padding="sm">
            {favorites.map(place => (
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

      <RecentTripsSection onSelect={onSelect} onSeeAll={onSeeAllRecents} />
    </View>
  );
}
