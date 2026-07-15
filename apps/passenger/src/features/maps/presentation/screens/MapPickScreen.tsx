import type {GeoPoint, MapPoint} from '@veo/api-client';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery} from '@tanstack/react-query';
import {
  Banner,
  Button,
  IconButton,
  RoutePin,
  SafeScreen,
  Skeleton,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {isWithinLima, LIMA_CENTER} from '../../../../shared/utils/geo';
import {useCurrentLocation} from '../../../../core/location/useCurrentLocation';
import {LocationPermissionNotice} from '../../../../shared/presentation/components/LocationPermissionNotice';
import {IconClose} from '../../../trip/presentation/components/icons';
import {isWaypointSet, type RoutePlace} from '../../domain/entities';
import {useRideDraftStore} from '../stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** La API de mapas usa `lng`; el mapa/GeoPoint usa `lon`. Convertimos en el borde. */
const toMapPoint = (p: GeoPoint): MapPoint => ({lat: p.lat, lng: p.lon});

/**
 * Elegir un punto (recojo/destino/parada) ARRASTRANDO el mapa bajo un PIN FIJO al centro (patrón
 * Uber/Cabify), más preciso que el buscador de texto. Aplica al extremo `editing` del borrador y vuelve.
 * Degradación honesta: mientras resuelve la dirección muestra "buscando…"; fuera de Lima, bloquea el
 * confirm con un aviso; sin dato, confirma con una etiqueta genérica (NUNCA una dirección inventada).
 */
export function MapPickScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const {
    point: myLocation,
    status: locationStatus,
    retry: retryLocation,
  } = useCurrentLocation();

  const editing = useRideDraftStore(s => s.editing);
  const origin = useRideDraftStore(s => s.origin);
  const destination = useRideDraftStore(s => s.destination);
  const waypoints = useRideDraftStore(s => s.waypoints);
  const setOrigin = useRideDraftStore(s => s.setOrigin);
  const setDestination = useRideDraftStore(s => s.setDestination);
  const setWaypoint = useRideDraftStore(s => s.setWaypoint);

  // Abrimos el mapa centrado en el punto ACTUAL del extremo en edición (o en mi ubicación). lng→lon.
  const initialCenter = useMemo<GeoPoint | null>(() => {
    const place =
      editing.kind === 'origin'
        ? origin
        : editing.kind === 'destination'
          ? destination
          : waypoints[editing.index];
    if (place) return {lat: place.point.lat, lon: place.point.lng};
    if (myLocation) return myLocation;
    // Sin punto previo ni GPS (permiso denegado/sin fix): el picker es MANUAL (arrastrás el mapa bajo el
    // pin), así que caemos al centro de Lima en vez de dejar el centro NULO — que dejaba "Confirmar"
    // deshabilitado en silencio. El usuario arrastra a su recojo y el reverse-geocode resuelve sobre Lima.
    return LIMA_CENTER;
  }, [editing, origin, destination, waypoints, myLocation]);

  // Centro VIVO (lo reporta `onCenterChange` al hacer pan). `setCenter` (setter de useState) es estable,
  // y `initialCenter` se estabiliza al asentarse el GPS → el AppMap (React.memo) no re-renderiza y la
  // cámara NO hace snap-back tras el pan del usuario.
  const [center, setCenter] = useState<GeoPoint | null>(initialCenter);
  useEffect(() => {
    if (!center && initialCenter) setCenter(initialCenter);
  }, [center, initialCenter]);

  // Debounce del centro: no reverse-geocodear en cada frame del arrastre.
  const [debounced, setDebounced] = useState<GeoPoint | null>(initialCenter);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(center), 350);
    return () => clearTimeout(id);
  }, [center]);

  // Guard de confirmación única (anti doble-tap, lo lee `confirm`) + limpieza al salir sin confirmar.
  const confirmedRef = useRef(false);
  // #4 · si entramos a editar una parada RECIÉN agregada (placeholder vacío) y salimos SIN confirmar
  // (X / back / gesto), la quitamos del borrador para no dejar una fila "Parada N" muteada colgada en el
  // trayecto. Solo afecta paradas AÚN sin dirección — una parada ya fijada que se re-edita NO se borra.
  useEffect(() => {
    return () => {
      if (confirmedRef.current) return;
      const ed = useRideDraftStore.getState().editing;
      if (ed.kind !== 'waypoint') return;
      const wp = useRideDraftStore.getState().waypoints[ed.index];
      if (wp && !isWaypointSet(wp)) {
        useRideDraftStore.getState().removeWaypoint(ed.index);
      }
    };
  }, []);

  const inLima = center ? isWithinLima(center) : false;

  const reverse = useQuery({
    queryKey: [
      'maps',
      'reverse',
      debounced?.lat ?? null,
      debounced?.lon ?? null,
    ],
    queryFn: () => reverseGeocode.execute(toMapPoint(debounced as GeoPoint)),
    enabled:
      Boolean(debounced) && (debounced ? isWithinLima(debounced) : false),
    staleTime: 60_000,
  });

  const title =
    editing.kind === 'origin'
      ? t('maps.pickup.titleOrigin')
      : editing.kind === 'destination'
        ? t('maps.pickup.titleDestination')
        : t('maps.pickup.titleStop', {index: editing.index + 1});

  const pinVariant =
    editing.kind === 'destination'
      ? 'destination'
      : editing.kind === 'waypoint'
        ? 'stop'
        : 'origin';

  const confirm = useCallback(() => {
    // Guard anti doble-tap: `confirm` hace `goBack()`; dos taps rápidos harían un doble-pop del stack
    // (deja al usuario en una pantalla inesperada). El ref corta la 2da ejecución en el mismo frame.
    if (confirmedRef.current) return;
    if (!center || !isWithinLima(center)) return;
    confirmedRef.current = true;
    const place: RoutePlace = {
      point: {lat: center.lat, lng: center.lon},
      title: reverse.data?.title ?? t('maps.pickedPoint'),
      subtitle: reverse.data?.subtitle,
    };
    if (editing.kind === 'origin') setOrigin(place);
    else if (editing.kind === 'destination') setDestination(place);
    else setWaypoint(editing.index, place);
    navigation.goBack();
  }, [
    center,
    reverse.data,
    editing,
    setOrigin,
    setDestination,
    setWaypoint,
    navigation,
    t,
  ]);

  return (
    <SafeScreen padded={false}>
      <View style={StyleSheet.absoluteFill}>
        <AppMap center={initialCenter} interactive onCenterChange={setCenter} />
      </View>

      {/* PIN FIJO al centro: el mapa se mueve debajo. No intercepta gestos (pointerEvents none). El "puck"
          de superficie + elevación da CONTRASTE sobre cualquier fondo (tierra/agua/noche) y aire al pin.
          Accesible para lector de pantalla: anuncia qué marca el pin (el mapa es puramente visual). */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${title}. ${reverse.data?.title ?? t('maps.pickup.resolving')}`}>
        <View style={styles.pinCenter}>
          <View style={styles.pinFloat}>
            <View
              style={[
                styles.pinPuck,
                {
                  backgroundColor: theme.colors.surface,
                  ...theme.elevation.level3,
                },
              ]}>
              <RoutePin variant={pinVariant} size={20} />
            </View>
          </View>
          <View
            style={[styles.pinShadow, {backgroundColor: theme.colors.overlay}]}
          />
        </View>
      </View>

      {/* Header flotante: cerrar + título del extremo en edición. */}
      <View
        style={[
          styles.header,
          {
            top: insets.top + theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
          },
        ]}
        pointerEvents="box-none">
        <IconButton
          accessibilityLabel={t('actions.close')}
          variant="surface"
          onPress={() => navigation.goBack()}
          icon={<IconClose color={theme.colors.ink} size={20} />}
        />
        <View
          style={[
            styles.titlePill,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radii.pill,
              ...theme.elevation.level2,
            },
          ]}>
          <Text variant="subhead" numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      {/* Tarjeta inferior compacta: dirección en vivo + confirmar. El pin queda al centro de pantalla. */}
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            paddingBottom: insets.bottom + theme.spacing.lg,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            ...theme.elevation.level3,
          },
        ]}>
        {/* Hint (pen V2ri8F): #B0BEC5 (inkSubtle), no inkMuted. */}
        <Text variant="footnote" color="inkSubtle">
          {t('maps.pickup.hint')}
        </Text>
        {/* Permiso/GPS negado: el picker YA degrada al centro de Lima (arrastre manual), pero antes no
            explicaba por qué no arrancó en tu ubicación. Aviso honesto, no bloquea el confirmar. */}
        <LocationPermissionNotice
          status={locationStatus}
          onRetry={retryLocation}
        />
        <View style={styles.addressRow}>
          {!inLima ? (
            <Banner tone="warn" title={t('maps.pickup.outsideLima')} />
          ) : reverse.isLoading || reverse.isFetching ? (
            <Skeleton variant="text" height={20} />
          ) : reverse.data ? (
            <>
              <Text variant="bodyStrong" numberOfLines={1}>
                {reverse.data.title}
              </Text>
              {reverse.data.subtitle ? (
                <Text variant="footnote" color="inkMuted" numberOfLines={1}>
                  {reverse.data.subtitle}
                </Text>
              ) : null}
            </>
          ) : reverse.isError ? (
            // Degradación honesta: no resolvimos la dirección (red), pero el punto es válido → igual confirma.
            <Text variant="footnote" color="inkMuted">
              {t('maps.pickup.resolveError')}
            </Text>
          ) : (
            <Text variant="body" color="inkMuted">
              {t('maps.pickup.resolving')}
            </Text>
          )}
        </View>
        <Button
          label={t('maps.pickup.confirm')}
          variant="primary"
          fullWidth
          disabled={!center || !inLima}
          // a11y: explica POR QUÉ está deshabilitado (fuera de Lima / aún sin centro), que el Banner visual
          // no le anuncia al lector de pantalla.
          accessibilityHint={
            !inLima
              ? t('maps.pickup.outsideLima')
              : !center
                ? t('maps.pickup.hint')
                : undefined
          }
          onPress={confirm}
        />
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  pinCenter: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  // El pin "flota" unos px arriba del punto exacto; la sombra marca el punto en el mapa.
  pinFloat: {transform: [{translateY: -12}]},
  // "Puck" de superficie tras el glifo: contraste garantizado sobre tierra/agua/noche + elevación real.
  pinPuck: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinShadow: {width: 16, height: 5, borderRadius: 8, opacity: 0.45},
  header: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titlePill: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  headerSpacer: {width: 44},
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 12,
  },
  addressRow: {minHeight: 44, justifyContent: 'center', gap: 2},
});
