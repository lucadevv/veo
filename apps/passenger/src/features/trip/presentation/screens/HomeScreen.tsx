import type { MapPoint, TripResource } from '@veo/api-client';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Card,
  IconButton,
  ListItem,
  MapShell,
  SafeScreen,
  SearchField,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import type { RootStackParamList } from '../../../../navigation/types';
import type { SavedPlace, SavedPlaceKind } from '../../../places/domain/entities';
import { useSavedPlacesStore } from '../../../places/presentation/stores/savedPlacesStore';
import type { RoutePlace } from '../../../maps/domain/entities';
import { useRideDraftStore } from '../../../maps/presentation/stores/rideDraftStore';
import { useCurrentLocation } from '../hooks/useCurrentLocation';
import { Animated, EnterView, usePressScale } from '../components/motion';
import { IconBell, IconHome, IconPin, IconSearch, IconStar, IconWork, type GlyphProps } from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Máximo de destinos recientes mostrados como atajos. */
const MAX_RECENTS = 3;

/** Glyph por tipo de lugar guardado (set `I` del diseño · home/work/star), reemplaza emojis. */
const PLACE_GLYPH: Record<SavedPlaceKind, (props: GlyphProps) => React.JSX.Element> = {
  HOME: IconHome,
  WORK: IconWork,
  FAVORITE: IconStar,
};

/** Extrae destinos recientes únicos del historial local (recursos reales del bff). */
function recentDestinations(trips: TripResource[]): TripResource['destination'][] {
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

/** Convierte un lugar guardado (MapPoint local) en el `RoutePlace` que consume el borrador. */
function placeToRoute(place: SavedPlace): RoutePlace {
  return {
    point: place.point,
    title: place.label,
    ...(place.subtitle ? { subtitle: place.subtitle } : {}),
  };
}

/**
 * LEGACY / CÓDIGO MUERTO: NO está montada en ningún navigator (el tab Home = `RequestFlowScreen`). Era el
 * Home original que navegaba a `Search`/`RouteQuote`; el flujo NORMAL ya vive ENTERO en el sheet de
 * `RequestFlowScreen`. Se conserva solo como referencia de diseño; no la cablees al stack.
 *
 * Home del pasajero (Midnight Motion · "¿A dónde vas?"): mapa oscuro a pantalla completa con el punto
 * de ubicación real. Sobre el mapa, fiel al design-handoff canónico (`Home` de `screens-pass.jsx`):
 * arriba una pastilla con tu ubicación (geocoding inverso real), campana de avisos y avatar de perfil;
 * abajo una fila de atajos (lugares guardados + destinos recientes con íconos SVG del set), el campo
 * "¿A dónde vamos?" y la tarjeta de lugares guardados (Casa/Trabajo). Siembra el origen del borrador
 * con la ubicación actual y, al tocar un atajo, fija el destino y va a la cotización.
 */
export function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();

  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);

  const { point: myLocation, loading: locating, error: locationError } = useCurrentLocation();
  const origin = useRideDraftStore((s) => s.origin);
  const setOrigin = useRideDraftStore((s) => s.setOrigin);
  const setDestination = useRideDraftStore((s) => s.setDestination);
  const setEditing = useRideDraftStore((s) => s.setEditing);
  const savedPlaces = useSavedPlacesStore((s) => s.places);

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

  // Perfil para el avatar (foto real si existe).
  const profileQuery = useQuery({
    queryKey: ['profile', 'me'],
    queryFn: () => getProfile.execute(),
    staleTime: 5 * 60_000,
  });

  // Siembra el origen del borrador con la ubicación actual etiquetada.
  useEffect(() => {
    if (!origin && reverseQuery.data) {
      setOrigin({
        point: { lat: reverseQuery.data.lat, lng: reverseQuery.data.lng },
        title: reverseQuery.data.title,
        subtitle: reverseQuery.data.subtitle,
      });
    }
  }, [origin, reverseQuery.data, setOrigin]);

  const openSearch = useCallback(() => {
    setEditing({ kind: 'destination' });
    navigation.navigate('Search');
  }, [navigation, setEditing]);

  const selectDestination = useCallback(
    (place: RoutePlace) => {
      setDestination(place);
      navigation.navigate('RouteQuote');
    },
    [navigation, setDestination],
  );

  const recents = useMemo(() => recentDestinations(history.list()), [history]);

  // Estado de la pastilla de ubicación: error claro (sin pantalla pelada), ubicando, o la dirección.
  const locationFailed = Boolean(locationError) && !myLocation;
  const userLabel = locationFailed
    ? t('home.locationUnavailable')
    : reverseQuery.data?.title ?? (locating ? t('home.locating') : t('home.yourLocation'));

  // Atajos (chips horizontales): lugares guardados primero, luego recientes — todos con SVG del set.
  const hasShortcuts = savedPlaces.length > 0 || recents.length > 0;

  return (
    <SafeScreen padded={false}>
      <MapShell
        loading={locating && !myLocation}
        topOverlay={
          <View style={styles.topRow} pointerEvents="box-none">
            <View
              style={[
                styles.locationPill,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: locationFailed ? theme.colors.warn : theme.colors.border,
                  borderRadius: theme.radii.pill,
                  ...theme.elevation.level2,
                },
              ]}
            >
              <View
                style={[
                  styles.locationDot,
                  { backgroundColor: locationFailed ? theme.colors.warn : theme.colors.accent },
                ]}
              />
              <Text variant="subhead" numberOfLines={1} style={styles.locationLabel}>
                {userLabel}
              </Text>
            </View>
            <View style={styles.topActions} pointerEvents="box-none">
              <IconButton
                accessibilityLabel={t('home.notifications')}
                variant="surface"
                onPress={() => navigation.navigate('Notifications')}
                icon={<IconBell color={theme.colors.ink} size={20} />}
                style={{ ...theme.elevation.level2 }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('screens.profile')}
                onPress={() => navigation.navigate('Main', { screen: 'Profile' })}
              >
                <Avatar
                  uri={profileQuery.data?.photoUrl ?? undefined}
                  name={profileQuery.data?.name ?? t('appName')}
                  size="md"
                />
              </Pressable>
            </View>
          </View>
        }
        bottomOverlay={
          <View style={{ gap: theme.spacing.md }} pointerEvents="box-none">
            {hasShortcuts ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: theme.spacing.sm }}
                keyboardShouldPersistTaps="handled"
              >
                {savedPlaces.map((place, index) => (
                  <PlaceShortcut
                    key={place.id}
                    index={index}
                    label={place.label}
                    icon={PLACE_GLYPH[place.kind]}
                    onPress={() => selectDestination(placeToRoute(place))}
                  />
                ))}
                {recents.map((point, index) => (
                  <RecentChip
                    key={`${point.lat}-${point.lon}-${index}`}
                    point={point}
                    index={savedPlaces.length + index}
                    onSelect={selectDestination}
                  />
                ))}
              </ScrollView>
            ) : null}

            <EnterView delay={hasShortcuts ? 120 : 0}>
              <SearchField
                placeholder={t('home.whereTo')}
                onPress={openSearch}
                leftIcon={<IconSearch color={theme.colors.accent} size={20} />}
              />
            </EnterView>

            {savedPlaces.length > 0 ? (
              <EnterView delay={160}>
                <Card variant="filled" padding="sm">
                  {savedPlaces.map((place) => {
                    const Glyph = PLACE_GLYPH[place.kind];
                    return (
                      <ListItem
                        key={place.id}
                        title={place.label}
                        subtitle={place.subtitle}
                        leading={<Glyph color={theme.colors.accent} size={20} />}
                        chevron
                        onPress={() => selectDestination(placeToRoute(place))}
                      />
                    );
                  })}
                </Card>
              </EnterView>
            ) : null}
          </View>
        }
      >
        <AppMap center={myLocation} userPoint={myLocation} interactive />
      </MapShell>
    </SafeScreen>
  );
}

interface PlaceShortcutProps {
  label: string;
  icon: (props: GlyphProps) => React.JSX.Element;
  index: number;
  onPress: () => void;
}

/** Chip de atajo (lugar guardado): ícono del set + etiqueta. Fija el destino y va a cotizar. */
function PlaceShortcut({ label, icon: Glyph, index, onPress }: PlaceShortcutProps): React.JSX.Element {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();

  return (
    <EnterView index={index} offsetY={0}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onPress}
      >
        <Animated.View
          style={[
            styles.chip,
            animatedStyle,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.pill,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.sm,
              ...theme.elevation.level1,
            },
          ]}
        >
          <Glyph color={theme.colors.accent} size={16} />
          <Text variant="subhead" numberOfLines={1} style={styles.chipLabel}>
            {label}
          </Text>
        </Animated.View>
      </Pressable>
    </EnterView>
  );
}

interface RecentChipProps {
  point: TripResource['destination'];
  index: number;
  onSelect: (place: RoutePlace) => void;
}

/**
 * Atajo de destino reciente: etiqueta el punto con geocoding inverso real y, al tocarlo, fija el
 * destino del borrador y navega a la cotización. El origen ya está sembrado por la ubicación actual.
 */
function RecentChip({ point, index, onSelect }: RecentChipProps): React.JSX.Element | null {
  const theme = useTheme();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();
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
    <EnterView index={index} offsetY={0}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={labelQuery.data.title}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={() =>
          onSelect({
            point: { lat: labelQuery.data!.lat, lng: labelQuery.data!.lng },
            title: labelQuery.data!.title,
            subtitle: labelQuery.data!.subtitle,
          })
        }
      >
        <Animated.View
          style={[
            styles.chip,
            animatedStyle,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.pill,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.sm,
              ...theme.elevation.level1,
            },
          ]}
        >
          <IconPin color={theme.colors.accent} size={16} />
          <Text variant="subhead" numberOfLines={1} style={styles.chipLabel}>
            {labelQuery.data.title}
          </Text>
        </Animated.View>
      </Pressable>
    </EnterView>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  locationPill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  locationDot: { width: 7, height: 7, borderRadius: 999 },
  locationLabel: { flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, maxWidth: 220 },
  chipLabel: { flexShrink: 1 },
});
