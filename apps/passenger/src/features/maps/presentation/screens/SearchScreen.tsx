import type { MapPoint, PlaceSuggestion } from '@veo/api-client';
import { type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import {
  Banner,
  IconButton,
  ListItem,
  OriginDestinationField,
  SafeScreen,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { useCurrentLocation } from '../../../trip/presentation/hooks/useCurrentLocation';
import { SavedPlacesShortcuts } from '../../../places/presentation';
import type { SavedPlace } from '../../../places/domain/entities';
import type { RoutePlace } from '../../domain/entities';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { EnterView } from '../components/motion';
import { IconClose, IconPin, IconTarget } from '../../../trip/presentation/components/icons';
import { useRideDraftStore } from '../stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Convierte una sugerencia del bff en un lugar de ruta (punto + etiqueta). */
function toRoutePlace(suggestion: PlaceSuggestion): RoutePlace {
  return {
    point: { lat: suggestion.lat, lng: suggestion.lng },
    title: suggestion.title,
    subtitle: suggestion.subtitle,
  };
}

/**
 * Búsqueda inteligente de direcciones. Edita origen y destino (`OriginDestinationField`), busca con
 * autocompletado (debounce + sesgo por ubicación) y, al fijar AMBOS extremos, RESUELVE según el origen
 * del flujo (`route.params.flow`):
 *  - `'sheet'`: abierto desde el sheet unificado (QuotingBody edita un punto del trayecto) → `goBack()`
 *    al sheet, que sigue en fase `quoting` con el borrador actualizado. NO sale a la cadena legacy.
 *  - `'quote'` (default): flujo PROGRAMADO (`ScheduleNew`) y callers no migrados → navega a `RouteQuote`.
 * El origen se siembra con la ubicación actual (geocoding inverso real).
 */
export function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  // Origen del flujo: define a dónde se vuelve al fijar ambos extremos. Default 'quote' = camino legacy
  // (no rompe ScheduleNew ni callers viejos); el sheet pasa 'sheet' para volver a la cotización in-sheet.
  const flow = useRoute<RouteProp<RootStackParamList, 'Search'>>().params?.flow ?? 'quote';

  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const { point: myLocation } = useCurrentLocation();

  const origin = useRideDraftStore((s) => s.origin);
  const destination = useRideDraftStore((s) => s.destination);
  const editing = useRideDraftStore((s) => s.editing);
  const setOrigin = useRideDraftStore((s) => s.setOrigin);
  const setDestination = useRideDraftStore((s) => s.setDestination);
  const setWaypoint = useRideDraftStore((s) => s.setWaypoint);
  const setEditing = useRideDraftStore((s) => s.setEditing);

  const [query, setQuery] = useState('');

  // Punto del dispositivo en formato de la API de mapas (lng), para sesgo y origen por defecto.
  const myPoint = useMemo<MapPoint | null>(
    () => (myLocation ? { lat: myLocation.lat, lng: myLocation.lon } : null),
    [myLocation],
  );

  // Etiqueta legible de la ubicación actual (geocoding inverso real).
  const reverseQuery = useQuery({
    queryKey: ['maps', 'reverse', myPoint?.lat ?? null, myPoint?.lng ?? null],
    queryFn: () => reverseGeocode.execute(myPoint as MapPoint),
    enabled: Boolean(myPoint),
    staleTime: 60_000,
  });

  // Siembra el origen con la ubicación actual etiquetada (solo si aún no hay origen).
  useEffect(() => {
    if (!origin && reverseQuery.data) {
      setOrigin({
        point: { lat: reverseQuery.data.lat, lng: reverseQuery.data.lng },
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [origin, reverseQuery.data, setOrigin]);

  const { suggestions, loading, error, active } = useAutocomplete(query, myPoint);

  // Cambia el punto en edición (origen/destino/parada) y limpia el texto de búsqueda.
  const focusEndpoint = useCallback(
    (target: 'origin' | 'destination') => {
      setEditing({ kind: target });
      setQuery('');
    },
    [setEditing],
  );

  // Cierra el buscador hacia su origen una vez fijados ambos extremos: 'sheet' → vuelve al sheet
  // (fase quoting con el borrador actualizado); 'quote' (legacy/programado) → pantalla de cotización.
  const resolveFlow = useCallback(() => {
    if (flow === 'sheet') {
      navigation.goBack();
    } else {
      navigation.navigate('RouteQuote');
    }
  }, [flow, navigation]);

  // Aplica un lugar al punto en edición y avanza el flujo.
  const applyPlace = useCallback(
    (place: RoutePlace) => {
      if (editing.kind === 'waypoint') {
        // Fija la parada y vuelve al origen del flujo (el resto del trayecto ya estaba definido).
        setWaypoint(editing.index, place);
        resolveFlow();
        return;
      }
      if (editing.kind === 'origin') {
        setOrigin(place);
        if (destination) {
          resolveFlow();
        } else {
          focusEndpoint('destination');
        }
        return;
      }
      setDestination(place);
      if (origin) {
        resolveFlow();
      } else {
        focusEndpoint('origin');
      }
    },
    [editing, origin, destination, setOrigin, setDestination, setWaypoint, resolveFlow, focusEndpoint],
  );

  // Fija un lugar guardado (Casa/Trabajo/favorito) en el extremo en edición con un toque.
  const applySavedPlace = useCallback(
    (place: SavedPlace) => {
      applyPlace({
        point: place.point,
        title: place.label,
        ...(place.subtitle ? { subtitle: place.subtitle } : {}),
      });
    },
    [applyPlace],
  );

  const useCurrentAsOrigin = useCallback(() => {
    if (reverseQuery.data) {
      applyPlace({
        point: { lat: reverseQuery.data.lat, lng: reverseQuery.data.lng },
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [reverseQuery.data, applyPlace]);

  const showCurrentLocationRow =
    editing.kind === 'origin' && Boolean(reverseQuery.data) && !active;

  // Etiqueta del campo de búsqueda según el punto en edición (origen/destino/parada N).
  const fieldLabel =
    editing.kind === 'origin'
      ? t('home.origin')
      : editing.kind === 'waypoint'
        ? t('waypoints.stopLabel', { index: editing.index + 1 })
        : t('home.destination');

  return (
    <SafeScreen padded={false}>
      <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md }]}>
        <View style={styles.titleRow}>
          <Text variant="title2">{t('maps.searchTitle')}</Text>
          <IconButton
            accessibilityLabel={t('actions.close')}
            onPress={() => navigation.goBack()}
            variant="surface"
            icon={<IconClose color={theme.colors.inkMuted} size={20} />}
          />
        </View>

        <OriginDestinationField
          origin={{
            value: origin?.title,
            placeholder: t('maps.originPlaceholder'),
            onPress: () => focusEndpoint('origin'),
          }}
          destination={{
            value: destination?.title,
            placeholder: t('maps.destinationPlaceholder'),
            onPress: () => focusEndpoint('destination'),
          }}
        />

        <TextField
          label={fieldLabel}
          placeholder={t('maps.inputPlaceholder')}
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={suggestions}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
        }}
        ListHeaderComponent={
          <View style={{ gap: theme.spacing.md }}>
            {error ? <Banner tone="danger" title={t('maps.searchError')} /> : null}
            {showCurrentLocationRow ? (
              <ListItem
                title={t('maps.useCurrentLocation')}
                subtitle={reverseQuery.data?.subtitle}
                onPress={useCurrentAsOrigin}
                leading={<IconTarget color={theme.colors.accent} size={20} />}
              />
            ) : null}
            {/* Accesos rápidos a lugares guardados (fijan el extremo en edición con un toque). */}
            {!active ? <SavedPlacesShortcuts onSelect={applySavedPlace} /> : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <EnterView index={index} offsetY={6}>
            <ListItem
              title={item.title}
              subtitle={item.subtitle}
              onPress={() => applyPlace(toRoutePlace(item))}
              leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
            />
          </EnterView>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
              <Skeleton variant="text" height={20} />
              <Skeleton variant="text" height={20} />
              <Skeleton variant="text" height={20} />
            </View>
          ) : (
            <Text
              variant="footnote"
              color="inkSubtle"
              align="center"
              style={{ paddingTop: theme.spacing.xl }}
            >
              {active ? t('maps.noResults') : t('maps.typeMore')}
            </Text>
          )
        }
      />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
