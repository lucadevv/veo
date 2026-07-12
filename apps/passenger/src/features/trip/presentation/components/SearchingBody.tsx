import type {PlaceSuggestion} from '@veo/api-client';
import {Banner, ListItem, Skeleton, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import type {SavedPlace} from '../../../places/domain/entities';
import {IconHome, IconPin, IconStar, IconWork} from './icons';
import {EnterView} from './motion';
import {ShortcutChip} from './ShortcutChip';

export interface SearchingBodyProps {
  /** Lugares guardados del pasajero (Casa/Trabajo/favoritos) para los chips de 1 toque. */
  savedPlaces: SavedPlace[];
  /** Fija un lugar guardado como destino con un toque. */
  onSelectSaved: (place: SavedPlace) => void;
  /** Abre la gestión de lugares guardados (chip "Favoritos" y añadir Casa/Trabajo faltante). */
  onOpenSavedPlaces: () => void;
  /** "Ver mapa": elegir el destino arrastrando el mapa (pickOnMap). */
  onViewMap: () => void;
  suggestions: PlaceSuggestion[];
  loading: boolean;
  error: boolean;
  active: boolean;
  onSelectSuggestion: (suggestion: PlaceSuggestion) => void;
}

/**
 * Cuerpo SCROLLABLE del modo búsqueda (DENTRO del sheet · design/veo.pen P/HomeSearch): chips
 * Casa/Trabajo/Favoritos, encabezado "Sugerencias"/"Ver mapa" y la lista de resultados del
 * autocompletado real. La fila de ORIGEN y el input de destino viven en el HEADER FIJO
 * (`HomeSearchFlowHeader`), así al scrollear los resultados el buscador NO se va de pantalla.
 */
export function SearchingBody({
  savedPlaces,
  onSelectSaved,
  onOpenSavedPlaces,
  onViewMap,
  suggestions,
  loading,
  error,
  active,
  onSelectSuggestion,
}: SearchingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const home = savedPlaces.find(place => place.kind === 'HOME');
  const work = savedPlaces.find(place => place.kind === 'WORK');

  return (
    <>
      {error ? <Banner tone="danger" title={t('maps.searchError')} /> : null}

      {/* Chips Casa/Trabajo/Favoritos (pen ShortcutChips) — solo SIN búsqueda activa; al tipear mandan
          las sugerencias. Casa/Trabajo fijan el lugar guardado (o abren su gestión si falta);
          Favoritos abre los lugares guardados. */}
      {!active ? (
        <View style={styles.chipsRow}>
          <ShortcutChip
            label={t('home.shortcutHome')}
            Icon={IconHome}
            present={Boolean(home)}
            onPress={() => (home ? onSelectSaved(home) : onOpenSavedPlaces())}
          />
          <ShortcutChip
            label={t('home.shortcutWork')}
            Icon={IconWork}
            present={Boolean(work)}
            onPress={() => (work ? onSelectSaved(work) : onOpenSavedPlaces())}
          />
          <ShortcutChip
            label={t('home.shortcutFavorites')}
            Icon={IconStar}
            present
            onPress={onOpenSavedPlaces}
          />
        </View>
      ) : null}

      {/* Encabezado de resultados (pen SuggestionsHeader): "Sugerencias" + atajo "Ver mapa". */}
      <View style={styles.suggestionsHeader}>
        <Text variant="subhead" color="ink" style={styles.suggestionsTitle}>
          {t('maps.suggestions')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('maps.viewMap')}
          hitSlop={8}
          onPress={onViewMap}>
          <Text variant="subhead" color="accent">
            {t('maps.viewMap')}
          </Text>
        </Pressable>
      </View>

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
        <View style={{gap: theme.spacing.md, paddingTop: theme.spacing.md}}>
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
          <Skeleton variant="text" height={20} />
        </View>
      ) : null}

      {suggestions.length === 0 && !loading ? (
        <Text
          variant="footnote"
          color="inkSubtle"
          align="center"
          style={{paddingTop: theme.spacing.lg}}>
          {active ? t('maps.noResults') : t('maps.typeMore')}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chipsRow: {flexDirection: 'row', gap: 8},
  suggestionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  suggestionsTitle: {fontWeight: '600'},
});
