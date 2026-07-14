import type {
  GeoPoint,
  MapPoint,
  PlaceSuggestion,
  TripResource,
} from '@veo/api-client';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery} from '@tanstack/react-query';
import {
  Banner,
  ListItem,
  OriginDestinationField,
  SafeScreen,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {FlatList, Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {distanceMeters} from '../../../../shared/utils/geo';
import {formatDistance} from '../../../../shared/utils/format';
import {useCurrentLocation} from '../../../../core/location/useCurrentLocation';
import {LocationPermissionNotice} from '../../../../shared/presentation/components/LocationPermissionNotice';
import {SavedPlacesShortcuts} from '../../../places/presentation';
import type {SavedPlace} from '../../../places/domain/entities';
import type {RoutePlace} from '../../domain/entities';
import {useAutocomplete} from '../../../../shared/presentation/hooks/useAutocomplete';
import {EnterView} from '../components/motion';
import {
  IconArrowLeft,
  IconPin,
  IconTarget,
} from '../../../trip/presentation/components/icons';
import {useRideDraftStore} from '../stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Máximo de destinos recientes mostrados en la sección "Recientes" (design/veo.pen P/Search). */
const MAX_RECENTS = 3;

/** Convierte una sugerencia del bff en un lugar de ruta (punto + etiqueta). */
function toRoutePlace(suggestion: PlaceSuggestion): RoutePlace {
  return {
    point: {lat: suggestion.lat, lng: suggestion.lng},
    title: suggestion.title,
    subtitle: suggestion.subtitle,
  };
}

/**
 * Destinos recientes ÚNICOS del historial local (recursos reales del bff):
 * dedup por coordenada redondeada (~1m) y tope en MAX_RECENTS.
 */
function recentDestinations(
  trips: TripResource[],
): TripResource['destination'][] {
  const seen = new Set<string>();
  const result: TripResource['destination'][] = [];
  for (const trip of trips) {
    const key = `${trip.destination.lat.toFixed(5)},${trip.destination.lon.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trip.destination);
    }
    if (result.length >= MAX_RECENTS) {
      break;
    }
  }
  return result;
}

/**
 * Distancia legible desde la ubicación actual hasta un punto ("3.1 km", pen P/Search), o `null`
 * sin fix de GPS — degradación honesta: la fila simplemente no muestra distancia, no inventa una.
 */
function distanceLabel(from: GeoPoint | null, to: GeoPoint): string | null {
  return from ? formatDistance(distanceMeters(from, to)) : null;
}

/**
 * Búsqueda inteligente de direcciones. Edita origen y destino (`OriginDestinationField`), busca con
 * autocompletado (debounce + sesgo por ubicación) y, al fijar AMBOS extremos, hace `goBack()` a quien
 * la abrió: SIEMPRE el sheet unificado (`RequestFlowScreen`/`QuotingBody`, que la pushea para editar un
 * punto del trayecto y sigue en fase `quoting` con el borrador actualizado). El origen se siembra con la
 * ubicación actual (geocoding inverso real).
 */
export function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();

  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);
  const {
    point: myLocation,
    status: locationStatus,
    retry: retryLocation,
  } = useCurrentLocation();

  // Destinos recientes únicos (hasta 3) del historial local, para la sección "Recientes" (pen P/Search).
  const recents = useMemo(() => recentDestinations(history.list()), [history]);

  const origin = useRideDraftStore(s => s.origin);
  const destination = useRideDraftStore(s => s.destination);
  const editing = useRideDraftStore(s => s.editing);
  const setOrigin = useRideDraftStore(s => s.setOrigin);
  const setDestination = useRideDraftStore(s => s.setDestination);
  const setWaypoint = useRideDraftStore(s => s.setWaypoint);
  const setEditing = useRideDraftStore(s => s.setEditing);

  const [query, setQuery] = useState('');

  // Punto del dispositivo en formato de la API de mapas (lng), para sesgo y origen por defecto.
  const myPoint = useMemo<MapPoint | null>(
    () => (myLocation ? {lat: myLocation.lat, lng: myLocation.lon} : null),
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
        point: {lat: reverseQuery.data.lat, lng: reverseQuery.data.lng},
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [origin, reverseQuery.data, setOrigin]);

  const {suggestions, loading, error, active} = useAutocomplete(query, myPoint);

  // Cambia el punto en edición (origen/destino/parada) y limpia el texto de búsqueda.
  const focusEndpoint = useCallback(
    (target: 'origin' | 'destination') => {
      setEditing({kind: target});
      setQuery('');
    },
    [setEditing],
  );

  // Cierra el buscador una vez fijados ambos extremos: `goBack()` al sheet unificado que la abrió
  // (fase quoting con el borrador actualizado). Es el ÚNICO camino de retorno — el flujo programado
  // también vive en el sheet (ver ScheduleNew), así que ya no hay pantalla de cotización legacy.
  const resolveFlow = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

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
    [
      editing,
      origin,
      destination,
      setOrigin,
      setDestination,
      setWaypoint,
      resolveFlow,
      focusEndpoint,
    ],
  );

  // Fija un lugar guardado (Casa/Trabajo/favorito) en el extremo en edición con un toque.
  const applySavedPlace = useCallback(
    (place: SavedPlace) => {
      applyPlace({
        point: place.point,
        title: place.label,
        ...(place.subtitle ? {subtitle: place.subtitle} : {}),
      });
    },
    [applyPlace],
  );

  const useCurrentAsOrigin = useCallback(() => {
    if (reverseQuery.data) {
      applyPlace({
        point: {lat: reverseQuery.data.lat, lng: reverseQuery.data.lng},
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
        ? t('waypoints.stopLabel', {index: editing.index + 1})
        : t('home.destination');

  return (
    <SafeScreen padded={false}>
      <View
        style={[
          styles.header,
          {paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md},
        ]}>
        {/* Header per pen P/Search: botón VOLVER (flecha) a la IZQUIERDA + título "Buscar destino".
            El placeholder "¿A dónde vamos?" del home no se toca (vive en maps.searchTitle). */}
        <View style={styles.titleRow}>
          {/* Back = SOLO el chevron ‹ de iOS, sin círculo/container (regla del dueño, mismo back en
              TODA la app — espeja a ScreenHeader/HeaderBackChevron). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('actions.back')}
            hitSlop={12}
            onPress={() => navigation.goBack()}>
            <IconArrowLeft color={theme.colors.ink} size={28} />
          </Pressable>
          {/* Fiel a design/veo.pen P/Search (Title aXWyE): 20px (title3), no 24 (title2). */}
          <Text variant="title3">{t('maps.searchScreenTitle')}</Text>
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
        keyExtractor={item => item.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
        }}
        ListHeaderComponent={
          <View style={{gap: theme.spacing.md}}>
            {/* Permiso/GPS de ubicación negado: aviso honesto (antes invisible — la fila "usar mi
                ubicación" y las distancias simplemente no aparecían, sin explicar por qué). */}
            <LocationPermissionNotice
              status={locationStatus}
              onRetry={retryLocation}
            />
            {error ? (
              <Banner tone="danger" title={t('maps.searchError')} />
            ) : null}
            {showCurrentLocationRow ? (
              <ListItem
                title={t('maps.useCurrentLocation')}
                subtitle={reverseQuery.data?.subtitle}
                onPress={useCurrentAsOrigin}
                leading={<IconTarget color={theme.colors.accent} size={20} />}
              />
            ) : null}
            {/* Elegir el punto en edición ARRASTRANDO el mapa (recojo/destino/parada). SIEMPRE visible:
                es el fallback natural cuando la búsqueda por texto no encuentra el punto. Antes se
                escondía con `!active` justo al tipear — exactamente cuando más falta hace. */}
            <ListItem
              title={t('maps.pickOnMap')}
              onPress={() => navigation.navigate('MapPick')}
              leading={<IconPin color={theme.colors.accent} size={20} />}
            />
            {/* Accesos rápidos a lugares guardados (fijan el extremo en edición con un toque). */}
            {!active ? (
              <SavedPlacesShortcuts onSelect={applySavedPlace} />
            ) : null}
            {/* Recientes (pen P/Search): hasta 3 destinos únicos del historial, SOLO sin búsqueda
                activa (al tipear, las sugerencias mandan). Cada fila se etiqueta con geocoding
                inverso real (mismo patrón que el RecentChip del legacy) + distancia desde acá. */}
            {!active && recents.length > 0 ? (
              <View style={{gap: theme.spacing.sm}}>
                {/* "Recientes" (pen OlKIP): #B0BEC5 (inkSubtle), no inkMuted. */}
                <Text variant="subhead" color="inkSubtle">
                  {t('maps.recents')}
                </Text>
                {recents.map((point, index) => (
                  <RecentRow
                    key={`${point.lat}-${point.lon}-${index}`}
                    point={point}
                    myLocation={myLocation}
                    onSelect={applyPlace}
                  />
                ))}
              </View>
            ) : null}
          </View>
        }
        renderItem={({item, index}) => (
          <EnterView index={index} offsetY={6}>
            <ListItem
              title={item.title}
              subtitle={item.subtitle}
              onPress={() => applyPlace(toRoutePlace(item))}
              leading={<IconPin color={theme.colors.inkSubtle} size={18} />}
              // Distancia real desde la ubicación actual (pen "3.1 km"); sin fix de GPS no se inventa.
              trailing={
                distanceLabel(myLocation, {lat: item.lat, lon: item.lng}) ? (
                  <Text variant="footnote" color="inkSubtle" tabular>
                    {distanceLabel(myLocation, {lat: item.lat, lon: item.lng})}
                  </Text>
                ) : undefined
              }
            />
          </EnterView>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={{gap: theme.spacing.md, paddingTop: theme.spacing.md}}>
              <Skeleton variant="text" height={20} />
              <Skeleton variant="text" height={20} />
              <Skeleton variant="text" height={20} />
            </View>
          ) : (
            <Text
              variant="footnote"
              color="inkSubtle"
              align="center"
              style={{paddingTop: theme.spacing.xl}}>
              {active ? t('maps.noResults') : t('maps.typeMore')}
            </Text>
          )
        }
      />
    </SafeScreen>
  );
}

interface RecentRowProps {
  /** Destino del historial ({lat, lon} del recurso real del bff). */
  point: TripResource['destination'];
  /** Ubicación actual para la distancia de la fila; `null` sin fix (la distancia se omite). */
  myLocation: GeoPoint | null;
  onSelect: (place: RoutePlace) => void;
}

/**
 * Fila de destino RECIENTE (pen P/Search · Recientes): etiqueta el punto con geocoding inverso real
 * y muestra la distancia desde la ubicación actual. Mientras el geocoding no resuelve, la fila no
 * se renderiza (sin placeholders inventados).
 */
function RecentRow({
  point,
  myLocation,
  onSelect,
}: RecentRowProps): React.JSX.Element | null {
  const theme = useTheme();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const mapPoint = useMemo<MapPoint>(
    () => ({lat: point.lat, lng: point.lon}),
    [point],
  );

  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', mapPoint.lat, mapPoint.lng],
    queryFn: () => reverseGeocode.execute(mapPoint),
    staleTime: 5 * 60_000,
  });

  const resolved = labelQuery.data;
  if (!resolved) {
    return null;
  }

  const distance = distanceLabel(myLocation, point);

  return (
    <ListItem
      title={resolved.title}
      subtitle={resolved.subtitle}
      leading={<IconPin color={theme.colors.accent} size={18} />}
      trailing={
        distance ? (
          <Text variant="footnote" color="inkSubtle" tabular>
            {distance}
          </Text>
        ) : undefined
      }
      onPress={() =>
        onSelect({
          point: {lat: resolved.lat, lng: resolved.lng},
          title: resolved.title,
          subtitle: resolved.subtitle,
        })
      }
    />
  );
}

const styles = StyleSheet.create({
  header: {paddingTop: 8},
  // Header pen P/Search: volver a la izquierda + título al lado (ya no título/cerrar en extremos).
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
