import type { PlaceSuggestion } from '@veo/api-client';
import { Banner, ListItem, Skeleton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { SavedPlace } from '../../../places/domain/entities';
import { SavedPlacesShortcuts } from '../../../places/presentation';
import { IconPin, IconTarget } from './icons';
import { EnterView } from './motion';

export interface SearchingBodyProps {
  showCurrentLocation: boolean;
  currentLocationSubtitle?: string;
  onUseCurrentLocation: () => void;
  suggestions: PlaceSuggestion[];
  loading: boolean;
  error: boolean;
  active: boolean;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => void;
  onSelectSaved: (place: SavedPlace) => void;
}

/**
 * Cuerpo SCROLLABLE del modo búsqueda (DENTRO del sheet): "usar mi ubicación", atajos de guardados y
 * sugerencias de autocompletado real. El input con autofocus + cerrar viven en el HEADER FIJO, así que
 * al scrollear las sugerencias el buscador NO se va de pantalla.
 */
export function SearchingBody({
  showCurrentLocation,
  currentLocationSubtitle,
  onUseCurrentLocation,
  suggestions,
  loading,
  error,
  active,
  onSelectSuggestion,
  onSelectSaved,
}: SearchingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <>
      {error ? <Banner tone="danger" title={t('maps.searchError')} /> : null}

      {showCurrentLocation ? (
        <ListItem
          title={t('maps.useCurrentLocation')}
          subtitle={currentLocationSubtitle}
          onPress={onUseCurrentLocation}
          leading={<IconTarget color={theme.colors.accent} size={20} />}
        />
      ) : null}

      {!active ? <SavedPlacesShortcuts onSelect={onSelectSaved} /> : null}

      {suggestions.length > 0
        ? suggestions.map((item, index) => (
            <EnterView key={item.id} index={index} offsetY={6}>
              <ListItem
                title={item.title}
                subtitle={item.subtitle}
                onPress={() => onSelectSuggestion(item)}
                leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
              />
            </EnterView>
          ))
        : null}

      {suggestions.length === 0 && loading ? (
        <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
        </View>
      ) : null}

      {suggestions.length === 0 && !loading ? (
        <Text variant="footnote" color="inkSubtle" align="center" style={{ paddingTop: theme.spacing.lg }}>
          {active ? t('maps.noResults') : t('maps.typeMore')}
        </Text>
      ) : null}
    </>
  );
}
