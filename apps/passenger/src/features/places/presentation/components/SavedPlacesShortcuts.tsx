import { Card, ListItem, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import {
  IconHome,
  IconStar,
  IconWork,
  type GlyphProps,
} from '../../../trip/presentation/components/icons';
import type { SavedPlace, SavedPlaceKind } from '../../domain/entities';
import { useSavedPlacesStore } from '../stores/savedPlacesStore';

/** Glyph SVG del set `I` por tipo de lugar (mismo lenguaje que la Home y la gestión). Sin emojis. */
const KIND_ICON: Record<SavedPlaceKind, (props: GlyphProps) => React.JSX.Element> = {
  HOME: IconHome,
  WORK: IconWork,
  FAVORITE: IconStar,
};

export interface SavedPlacesShortcutsProps {
  /** Selecciona un lugar guardado (p. ej. para fijarlo como destino). */
  onSelect: (place: SavedPlace) => void;
}

/**
 * Accesos rápidos a los Lugares guardados (Casa/Trabajo/favoritos) para fijar destino con un toque.
 * Se monta en el buscador. Si no hay lugares, no renderiza nada (no estorba el flujo de búsqueda).
 */
export function SavedPlacesShortcuts({ onSelect }: SavedPlacesShortcutsProps): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useTranslation();
  const places = useSavedPlacesStore((s) => s.places);

  if (places.length === 0) {
    return null;
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="subhead" color="inkMuted">
        {t('places.quickAccess')}
      </Text>
      <Card variant="outlined" padding="sm">
        {places.map((place) => {
          const Glyph = KIND_ICON[place.kind];
          return (
            <ListItem
              key={place.id}
              title={place.label}
              subtitle={place.subtitle}
              leading={<Glyph color={theme.colors.accent} size={20} />}
              onPress={() => onSelect(place)}
            />
          );
        })}
      </Card>
    </View>
  );
}
