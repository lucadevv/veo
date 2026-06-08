import React, {useEffect, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import type {CompositeScreenProps} from '@react-navigation/native';
import type {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {GeoPoint} from '@veo/api-client';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  Card,
  MapShell,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
  type StatusTone,
} from '@veo/ui-kit';
import type {MainTabParamList, RootStackParamList} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {IconFlame, IconPower} from '../../../../shared/presentation/icons';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {formatPEN} from '../../../../shared/presentation/format';
import {LIMA_CENTER} from '../../../../shared/utils/geo';
import {useEarningsSummary} from '../../../earnings/presentation/hooks/useEarnings';
import {DemandLegend, useHeatCells, useHeatmap} from '../../../ops/presentation';
import {useDispatchStore} from '../../../realtime/presentation/state/dispatchStore';
import {useLocationSource} from '../../../realtime/presentation';
import {canStartShift, isOnShift, type ShiftStatus, type VehicleType} from '../../domain';
import {useEndShift, usePauseShift, useShiftState} from '../hooks/useShift';
import {useVehicleTypeStore} from '../state/vehicleTypeStore';
import {VehicleTypeSelector} from '../components/VehicleTypeSelector';
import {Appear, PressableScale, Pulse} from '../components/motion';

/**
 * "Inicio" es una tab dentro del stack `Main`. Tipamos la navegación de forma compuesta para poder
 * navegar tanto a tabs hermanas (`Ganancias`, `Cuenta`) como a pantallas full-screen del stack raíz
 * (`ShiftStart`, `TripActive`). Misma navegación de negocio que ya existía, con tipos correctos.
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Inicio'>,
  NativeStackScreenProps<RootStackParamList>
>;

/** Descriptor visual del `StatusPill` del header según el estado de turno. */
interface ShiftPill {
  label: string;
  tone: StatusTone;
  live: boolean;
}

/**
 * Mapea el estado de turno al pill del header. AVAILABLE comunica que se están buscando viajes
 * (tono éxito, pulsante); el resto reutiliza las etiquetas i18n existentes o "Desconectado".
 */
/** Etiqueta i18n del tipo de vehículo activo (para el indicador del header). */
function vehicleTypeLabel(type: VehicleType, t: TFunction): string {
  return t(`shift.vehicleType.${type === 'CAR' ? 'car' : 'moto'}`);
}

function shiftPill(status: ShiftStatus, t: TFunction): ShiftPill {
  switch (status) {
    case 'AVAILABLE':
      return {label: `${t('shift.status.available')} · Buscando viajes`, tone: 'success', live: true};
    case 'ON_TRIP':
      return {label: t('shift.status.onTrip'), tone: 'accent', live: true};
    case 'ON_BREAK':
      return {label: t('shift.status.onBreak'), tone: 'warn', live: false};
    default:
      return {label: 'Desconectado', tone: 'neutral', live: false};
  }
}

export const DashboardScreen = ({navigation}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const shift = useShiftState();
  const earnings = useEarningsSummary();
  const pause = usePauseShift();
  const end = useEndShift();
  const activeTripId = useDispatchStore(s => s.activeTripId);
  const vehicleType = useVehicleTypeStore(s => s.vehicleType);
  const [endConfirm, setEndConfirm] = useState(false);
  // Toggle "Zonas de demanda": pinta el mapa de calor sobre el mapa para orientar al conductor.
  const [demandOn, setDemandOn] = useState(false);

  // Ubicación del conductor: se suscribe a la fuente de GPS nativa ya existente
  // (`LocationSource` / background-geolocation). Si la oleada nativa aún no instaló una fuente
  // real (`available === false`), no emite y `driverPoint` queda en null → centramos en LIMA_CENTER
  // y omitimos el pin. No se introduce lógica de GPS nueva: solo se consume el puerto existente.
  const locationSource = useLocationSource();
  const [driverPoint, setDriverPoint] = useState<GeoPoint | null>(null);
  useEffect(() => {
    if (!locationSource.available) {
      return;
    }
    const unsubscribe = locationSource.subscribe(sample => {
      // Defensa: ignoramos fixes corruptos (lat/lon no finitos). Pasar coordenadas NaN al mapa puede
      // tumbar la vista nativa; mejor conservar el último punto válido (o ninguno → centramos en Lima).
      if (!sample || !Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) {
        return;
      }
      setDriverPoint({lat: sample.lat, lon: sample.lon});
    });
    return unsubscribe;
  }, [locationSource]);

  const status = shift.data?.status ?? 'UNKNOWN';
  const online = isOnShift(status);
  const pill = shiftPill(status, t);

  // Mapa de calor de demanda: solo cuando el conductor está en línea, sin viaje, con el toggle
  // activo y con ubicación conocida. Si falta cualquier condición, la query queda inactiva (null).
  const heatmapQuery =
    demandOn && online && !activeTripId && driverPoint
      ? {lat: driverPoint.lat, lng: driverPoint.lon}
      : null;
  const heatmap = useHeatmap(heatmapQuery);
  const heatCells = useHeatCells(heatmap.data);
  const showDemandToggle = online && !activeTripId;

  // Cabecera flotante: avatar (→ perfil) + saludo a la izquierda; pill de estado a la derecha.
  const topOverlay = (
    <View style={styles.topRow} pointerEvents="box-none">
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('shift.viewProfile')}
        onPress={() => navigation.navigate('Cuenta')}
        style={[
          styles.greetCard,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.pill,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.xs,
            ...theme.elevation.level2,
          },
        ]}>
        <Avatar name="VEO" size="sm" online={online} />
        <View style={styles.greetText}>
          <Text variant="footnote" color="inkSubtle">
            Hola,
          </Text>
          <Text variant="subhead" numberOfLines={1}>
            Conductor
          </Text>
        </View>
      </PressableScale>
      <View style={styles.topRight}>
        <StatusPill label={pill.label} tone={pill.tone} live={pill.live} dot />
        {/* Indicador del tipo de vehículo ACTIVO (Auto | Moto): el conductor ve de un vistazo con
            qué vehículo está operando, que es lo que el dispatch usa para ofrecerle viajes. */}
        <StatusPill label={vehicleTypeLabel(vehicleType, t)} tone="accent" dot />
        {/* Toggle "Zonas de demanda": pinta el mapa de calor para saber a dónde ir. */}
        {showDemandToggle ? (
          <PressableScale
            accessibilityRole="switch"
            accessibilityState={{checked: demandOn}}
            accessibilityLabel={t('ops.demand.toggle')}
            onPress={() => setDemandOn(prev => !prev)}
            style={[
              styles.demandToggle,
              {
                backgroundColor: demandOn ? theme.colors.accent : theme.colors.surface,
                borderColor: demandOn ? theme.colors.accent : theme.colors.border,
                borderRadius: theme.radii.pill,
                ...theme.elevation.level2,
              },
            ]}>
            <IconFlame
              size={16}
              color={demandOn ? theme.colors.onAccent : theme.colors.accent}
              strokeWidth={2}
            />
            <Text variant="caption" color={demandOn ? 'onAccent' : 'inkMuted'} numberOfLines={1}>
              {t('ops.demand.toggle')}
            </Text>
          </PressableScale>
        ) : null}
      </View>
    </View>
  );

  // Pin pulsante solo cuando está en línea y hay un fix real de GPS.
  const mapDriver = online ? driverPoint : null;

  // Métricas en vivo (reutiliza los campos reales del resumen: neto acumulado y por liquidar).
  const earningsMetrics =
    earnings.isLoading ? (
      <Skeleton height={56} />
    ) : earnings.isError || !earnings.data ? (
      <Banner tone="warn" title={t('shift.kpisUnavailable')} />
    ) : (
      <View style={styles.kpisRow}>
        <Appear style={styles.kpi} delay={40}>
          <Text variant="footnote" color="inkMuted">
            {t('shift.netTotal')}
          </Text>
          <Text variant="title3" tabular>
            {formatPEN(earnings.data.totalNetCents ?? 0)}
          </Text>
        </Appear>
        <Appear style={styles.kpi} delay={110}>
          <Text variant="footnote" color="inkMuted">
            {t('shift.pendingNet')}
          </Text>
          <Text variant="title3" color="warn" tabular>
            {formatPEN(earnings.data.pendingNetCents ?? 0)}
          </Text>
        </Appear>
      </View>
    );

  // ─── Dock inferior: estados de carga/error > viaje activo > en línea > desconectado.
  // El mapa de fondo se monta UNA sola vez (return único más abajo): nunca se desmonta entre
  // estados, evitando el reciclaje de la vista nativa en Fabric y la cancelación del estilo. ───
  let bottomOverlay: React.ReactNode;

  if (shift.isLoading) {
    bottomOverlay = (
      <Card variant="filled">
        <Skeleton height={96} />
      </Card>
    );
  } else if (shift.isError || !shift.data) {
    bottomOverlay = (
      <Card variant="filled">
        <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(shift.error, t)} />
        <Button label={t('common.retry')} fullWidth onPress={() => shift.refetch()} style={styles.spaced} />
      </Card>
    );
  } else if (activeTripId) {
    // Prioridad máxima: acceso directo al viaje en curso.
    bottomOverlay = (
      <Card variant="filled">
        <Text variant="subhead" color="inkMuted">
          {t('trips.activeTitle')}
        </Text>
        <Button
          label="Ver viaje activo"
          variant="accent"
          fullWidth
          onPress={() => navigation.navigate('TripActive', {tripId: activeTripId})}
          style={styles.spaced}
        />
      </Card>
    );
  } else if (online) {
    // En línea: sheet slim con métricas en vivo, pausa y desconexión (misma lógica de mutaciones).
    bottomOverlay = (
      <Appear key="online">
      <Card variant="filled" padding="lg">
        <View style={styles.onlineHead}>
          <Pulse active={status === 'AVAILABLE'} style={styles.liveDotWrap}>
            <View style={[styles.liveDot, {backgroundColor: theme.colors.success}]} />
          </Pulse>
          <Text variant="headline">Listo para recibir viajes</Text>
        </View>
        {/* Tipo de vehículo activo: editable en línea (bloqueado solo durante un viaje), porque es
            lo que decide qué viajes —Auto o Moto— le ofrece el dispatch. */}
        <View style={styles.spaced}>
          <VehicleTypeSelector disabled={status === 'ON_TRIP'} />
        </View>
        <View style={styles.spaced}>{earningsMetrics}</View>
        <View style={styles.actionsRow}>
          {status === 'AVAILABLE' ? (
            <Button
              label={t('shift.pause')}
              variant="secondary"
              fullWidth
              loading={pause.isPending}
              onPress={() => pause.mutate()}
              style={styles.actionItem}
            />
          ) : null}
          <Button
            label="Desconectarse"
            variant="ghost"
            fullWidth
            loading={end.isPending}
            onPress={() => setEndConfirm(true)}
            style={styles.actionItem}
          />
        </View>
        {pause.isError ? (
          <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(pause.error, t)} style={styles.spaced} />
        ) : null}
        {end.isError ? (
          <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(end.error, t)} style={styles.spaced} />
        ) : null}
      </Card>
      </Appear>
    );
  } else {
    // Desconectado / en pausa: dock con resumen de ganancias y CTA principal "Conéctate".
    bottomOverlay = (
      <Appear key="offline">
      <Card variant="filled">
        {/* Elige el vehículo ANTES de conectarte: define qué viajes recibirás al iniciar turno. */}
        <View style={styles.vehiclePicker}>
          <VehicleTypeSelector />
        </View>
        {earningsMetrics}
        <Button
            label={t('shift.viewEarnings')}
            variant="ghost"
            size="sm"
            onPress={() => navigation.navigate('Ganancias')}
          style={styles.spaced}
        />
        {canStartShift(status) ? (
          <Button
            label={status === 'ON_BREAK' ? t('shift.resume') : 'Conéctate'}
            size="lg"
            fullWidth
            leftIcon={<IconPower size={20} color={theme.colors.onAccent} />}
            onPress={() => navigation.navigate('ShiftStart')}
            style={styles.spaced}
          />
        ) : null}
        {end.isError ? (
          <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(end.error, t)} style={styles.spaced} />
        ) : null}
      </Card>
      </Appear>
    );
  }

  return (
    <SafeScreen padded={false}>
      <MapShell topOverlay={topOverlay} bottomOverlay={bottomOverlay} loading={shift.isLoading}>
        <AppMap
          center={driverPoint ?? LIMA_CENTER}
          driver={mapDriver}
          heatCells={demandOn ? heatCells : undefined}
          interactive={online}
        />
        {/* Atenuación del mapa cuando el conductor no está en línea. */}
        {!online ? (
          <View
            style={[styles.dim, {backgroundColor: theme.colors.bg}]}
            pointerEvents="none"
          />
        ) : null}
        {/* Leyenda / estado del mapa de calor cuando el toggle está activo. */}
        {demandOn && showDemandToggle ? (
          <View style={styles.legendWrap} pointerEvents="none">
            {heatmap.isError ? (
              <Banner tone="warn" title={t('ops.demand.unavailable')} />
            ) : heatmap.isLoading ? (
              <Skeleton height={56} radius={theme.radii.md} />
            ) : heatCells.length === 0 ? (
              <Banner tone="info" title={t('ops.demand.empty')} />
            ) : (
              <DemandLegend />
            )}
          </View>
        ) : null}
      </MapShell>

      <BottomSheet
        visible={endConfirm}
        onClose={() => setEndConfirm(false)}
        title={t('shift.endConfirmTitle')}
        footer={
          <View style={styles.sheetFooter}>
            <Button label={t('common.cancel')} variant="secondary" onPress={() => setEndConfirm(false)} />
            <Button
              label={t('shift.endShift')}
              variant="danger"
              onPress={() => {
                setEndConfirm(false);
                end.mutate();
              }}
            />
          </View>
        }>
        <Text variant="callout" color="inkMuted">
          {t('shift.endConfirmBody')}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  topRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  topRight: {alignItems: 'flex-end', gap: 8},
  demandToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  legendWrap: {position: 'absolute', left: 16, right: 16, bottom: 16},
  vehiclePicker: {marginBottom: 16},
  greetCard: {flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, maxWidth: 220},
  greetText: {flexShrink: 1, paddingRight: 4},
  dim: {...StyleSheet.absoluteFillObject, opacity: 0.55},
  kpisRow: {flexDirection: 'row', gap: 16},
  kpi: {flex: 1, gap: 2},
  onlineHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  liveDotWrap: {width: 10, height: 10, alignItems: 'center', justifyContent: 'center'},
  liveDot: {width: 10, height: 10, borderRadius: 999},
  actionsRow: {flexDirection: 'row', gap: 12, marginTop: 16},
  actionItem: {flex: 1},
  spaced: {marginTop: 12},
  sheetFooter: {flexDirection: 'row', justifyContent: 'flex-end', gap: 12},
});
