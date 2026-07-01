import React, { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GeoPoint } from '@veo/api-client';
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
import type { MainTabParamList, RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { IconFlame, IconPower } from '../../../../shared/presentation/icons';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN } from '../../../../shared/presentation/format';
import { vehicleClassLabelKey } from '../../../../shared/presentation/vehicle-class';
import { LIMA_CENTER } from '../../../../shared/utils/geo';
import { useEarningsSummary } from '../../../earnings/presentation/hooks/useEarnings';
import { useProfile } from '../../../profile/presentation/hooks/useProfile';
import { DemandLegend, useHeatCells, useHeatmap } from '../../../ops/presentation';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import {
  useLocationAvailability,
  useLocationSource,
  useTipStore,
} from '../../../realtime/presentation';
import {
  canStartShift,
  isOnShift,
  isSuspended,
  type ShiftStatus,
  type VehicleType,
} from '../../domain';
import { useEndShift, usePauseShift, useShiftState } from '../hooks/useShift';
import { useActiveVehicle } from '../../../registration/presentation';
import { VehicleTypeSelector } from '../components/VehicleTypeSelector';
import { Appear, PressableScale, Pulse } from '../components/motion';

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
/** Etiqueta i18n del tipo de vehículo activo (registro exhaustivo clase→clave, ADR 013 §1.6). */
function vehicleTypeLabel(type: VehicleType, t: TFunction): string {
  return t(vehicleClassLabelKey(type));
}

function shiftPill(status: ShiftStatus, t: TFunction): ShiftPill {
  switch (status) {
    case 'AVAILABLE':
      return {
        label: t('shift.status.availableSearching'),
        tone: 'success',
        live: true,
      };
    case 'ASSIGNED':
    case 'ON_TRIP':
      return { label: t('shift.status.onTrip'), tone: 'accent', live: true };
    case 'ON_BREAK':
      return { label: t('shift.status.onBreak'), tone: 'warn', live: false };
    case 'SUSPENDED':
      return { label: t('shift.status.suspended'), tone: 'danger', live: false };
    default:
      return { label: t('shift.status.offline'), tone: 'neutral', live: false };
  }
}

/**
 * Nombre de saludo a partir del nombre legal (onboarding). Lo presenta en Title Case: el OCR suele venir en
 * MAYÚSCULAS y "Hola, CARRANZA" grita. `null` (sin nombre aún) → el saludo cae al rol genérico ("Conductor").
 */
function greetingName(fullName: string | null | undefined): string | null {
  const name = fullName?.trim();
  if (!name) {
    return null;
  }
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export const DashboardScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const shift = useShiftState();
  const earnings = useEarningsSummary();
  // Nombre del conductor para el saludo (perfil server-authoritative). Mientras carga → cae al rol genérico.
  const profile = useProfile();
  const driverName = greetingName(profile.data?.fullName);
  const pause = usePauseShift();
  const end = useEndShift();
  const activeTripId = useDispatchStore((s) => s.activeTripId);
  const lastTip = useTipStore((s) => s.lastTip);
  const clearTip = useTipStore((s) => s.clearTip);
  const activeVehicle = useActiveVehicle();
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
    const unsubscribe = locationSource.subscribe((sample) => {
      // Defensa: ignoramos fixes corruptos (lat/lon no finitos). Pasar coordenadas NaN al mapa puede
      // tumbar la vista nativa; mejor conservar el último punto válido (o ninguno → centramos en Lima).
      if (!sample || !Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) {
        return;
      }
      setDriverPoint({ lat: sample.lat, lon: sample.lon });
    });
    return unsubscribe;
  }, [locationSource]);

  const status = shift.data?.status ?? 'UNKNOWN';
  const online = isOnShift(status);
  const pill = shiftPill(status, t);

  // Disponibilidad del GPS (servicios del SO + permiso). Si el conductor está EN TURNO pero apagó la
  // ubicación o no dio permiso, NO emite su posición y el dispatch no lo ve, aunque la UI lo muestre
  // "en línea". Avisamos explícito para que lo corrija (gap operativo silencioso, no data falsa).
  const gpsAvailability = useLocationAvailability();
  const gpsUnavailable =
    online &&
    gpsAvailability != null &&
    (!gpsAvailability.servicesEnabled || !gpsAvailability.permissionGranted);
  // Mensaje según la causa concreta: permiso denegado vs. servicio de ubicación apagado.
  const gpsBannerBody =
    gpsAvailability && !gpsAvailability.permissionGranted
      ? t('shift.gpsPermissionBody')
      : t('shift.gpsServicesBody');

  // Mapa de calor de demanda: solo cuando el conductor está en línea, sin viaje, con el toggle
  // activo y con ubicación conocida. Si falta cualquier condición, la query queda inactiva (null).
  const heatmapQuery =
    demandOn && online && !activeTripId && driverPoint
      ? { lat: driverPoint.lat, lng: driverPoint.lon }
      : null;
  const heatmap = useHeatmap(heatmapQuery);
  const heatCells = useHeatCells(heatmap.data);
  const showDemandToggle = online && !activeTripId;

  // Cabecera flotante: avatar (→ perfil) + saludo a la izquierda; pill de estado a la derecha.
  const topOverlay = (
    <View style={[styles.topRow, { paddingTop: insets.top }]} pointerEvents="box-none">
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
        ]}
      >
        <Avatar name={driverName ?? 'VEO'} size="sm" online={online} />
        <View style={styles.greetText}>
          <Text variant="footnote" color="inkSubtle">
            {t('shift.greetingHi')}
          </Text>
          <Text variant="subhead" numberOfLines={1}>
            {driverName ?? t('shift.greetingRole')}
          </Text>
        </View>
      </PressableScale>
      <View style={styles.topRight}>
        <StatusPill label={pill.label} tone={pill.tone} live={pill.live} dot />
        {/* Indicador del vehículo ACTIVO (server-authoritative): con qué vehículo opera, que es lo que el
            dispatch usa para ofrecerle viajes. Solo EN TURNO: fuera de turno el vehículo no es relevante y
            mostrarlo pegado a "Fuera de turno" leía raro ("Fuera de turno · Moto"). */}
        {online && activeVehicle.data ? (
          <StatusPill
            label={vehicleTypeLabel(activeVehicle.data.vehicleType, t)}
            tone="accent"
            dot
          />
        ) : null}
        {/* Toggle "Zonas de demanda": pinta el mapa de calor para saber a dónde ir. */}
        {showDemandToggle ? (
          <PressableScale
            accessibilityRole="switch"
            accessibilityState={{ checked: demandOn }}
            accessibilityLabel={t('ops.demand.toggle')}
            onPress={() => setDemandOn((prev) => !prev)}
            style={[
              styles.demandToggle,
              {
                backgroundColor: demandOn ? theme.colors.accent : theme.colors.surface,
                borderColor: demandOn ? theme.colors.accent : theme.colors.border,
                borderRadius: theme.radii.pill,
                ...theme.elevation.level2,
              },
            ]}
          >
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
  const earningsMetrics = earnings.isLoading ? (
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
        <Banner
          tone="danger"
          title={t('errors.generic')}
          description={toErrorMessage(shift.error, t)}
        />
        <Button
          label={t('common.retry')}
          fullWidth
          onPress={() => shift.refetch()}
          style={styles.spaced}
        />
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
          label={t('shift.viewActiveTrip')}
          variant="accent"
          fullWidth
          onPress={() => navigation.navigate('TripActive', { tripId: activeTripId })}
          style={styles.spaced}
        />
      </Card>
    );
  } else if (online) {
    // En línea: sheet slim con métricas en vivo, pausa y desconexión (misma lógica de mutaciones).
    bottomOverlay = (
      <Appear key="online">
        <Card variant="filled" padding="lg">
          {/* GPS apagado/sin permiso EN TURNO: el conductor no emite posición y el dispatch no lo ve.
            Aviso prioritario (arriba de todo) para que lo corrija antes de seguir esperando viajes. */}
          {gpsUnavailable ? (
            <Banner
              tone="danger"
              title={t('shift.gpsUnavailableTitle')}
              description={gpsBannerBody}
              // Acción directa: abre los ajustes del SO de la app, donde el conductor activa el permiso o
              // el servicio de ubicación. Sin esto el banner solo informaba y el conductor debía adivinar.
              action={{ label: t('shift.gpsOpenSettings'), onPress: () => Linking.openSettings() }}
              style={styles.bannerBelow}
            />
          ) : null}
          <View style={styles.onlineHead}>
            <Pulse active={status === 'AVAILABLE'} style={styles.liveDotWrap}>
              <View style={[styles.liveDot, { backgroundColor: theme.colors.success }]} />
            </Pulse>
            <Text variant="headline">{t('shift.readyForTrips')}</Text>
          </View>
          {/* Tipo de vehículo activo: editable en línea (bloqueado solo durante un viaje), porque es
            lo que decide qué viajes —Auto o Moto— le ofrece el dispatch. */}
          <View style={styles.spaced}>
            <VehicleTypeSelector disabled={status === 'ON_TRIP' || status === 'ASSIGNED'} />
          </View>
          <View style={styles.spaced}>{earningsMetrics}</View>
          {/* Pujas abiertas: el conductor entra al marketplace "proponé tu precio" para ofertar/contraofertar. */}
          <Button
            label={t('trips.bid.screenTitle')}
            variant="accent"
            fullWidth
            leftIcon={<IconFlame size={18} color={theme.colors.onAccent} strokeWidth={2} />}
            onPress={() => navigation.navigate('Bids')}
            style={styles.spaced}
          />
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
              label={t('shift.goOffline')}
              variant="ghost"
              fullWidth
              loading={end.isPending}
              onPress={() => setEndConfirm(true)}
              style={styles.actionItem}
            />
          </View>
          {pause.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(pause.error, t)}
              style={styles.spaced}
            />
          ) : null}
          {end.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(end.error, t)}
              style={styles.spaced}
            />
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
            {/* Gestionar/registrar vehículos (p. ej. sumar una moto para poder cambiar de tipo). */}
            <Button
              label={t('vehicles.manage')}
              variant="ghost"
              size="sm"
              onPress={() => navigation.navigate('Vehicles')}
              style={styles.spaced}
            />
          </View>
          {earningsMetrics}
          <Button
            label={t('shift.viewEarnings')}
            variant="ghost"
            size="sm"
            onPress={() => navigation.navigate('Ganancias')}
            style={styles.spaced}
          />
          {/* SUSPENDED (regla de seguridad): el conductor NO puede operar. Aviso claro + salida a soporte,
            en vez del CTA "Conéctate" (que canStartShift ya bloquea para este estado). */}
          {isSuspended(status) ? (
            <Banner
              tone="danger"
              title={t('shift.suspendedTitle')}
              description={t('shift.suspendedBody')}
              action={{
                label: t('shift.contactSupport'),
                onPress: () => navigation.navigate('Support'),
              }}
              style={styles.spaced}
            />
          ) : canStartShift(status) ? (
            <Button
              label={status === 'ON_BREAK' ? t('shift.resume') : t('shift.connect')}
              size="lg"
              fullWidth
              leftIcon={<IconPower size={20} color={theme.colors.onAccent} />}
              onPress={() => navigation.navigate('ShiftStart')}
              style={styles.spaced}
            />
          ) : (
            /* Estado NO reconocido (UNKNOWN): ni suspendido ni conectable. En vez de un dock sin CTA ni
             explicación (conductor confundido), avisamos honesto y ofrecemos reintentar la lectura. */
            <Banner
              tone="warn"
              title={t('shift.unknownStateTitle')}
              description={t('shift.unknownStateBody')}
              action={{ label: t('common.retry'), onPress: () => shift.refetch() }}
              style={styles.spaced}
            />
          )}
          {end.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(end.error, t)}
              style={styles.spaced}
            />
          ) : null}
        </Card>
      </Appear>
    );
  }

  return (
    <SafeScreen padded={false} topInset={false}>
      <MapShell topOverlay={topOverlay} bottomOverlay={bottomOverlay} loading={shift.isLoading}>
        <AppMap
          center={driverPoint ?? LIMA_CENTER}
          driver={mapDriver}
          heatCells={demandOn ? heatCells : undefined}
          interactive={online}
        />
        {/* Atenuación del mapa cuando el conductor no está en línea. */}
        {!online ? (
          <View style={[styles.dim, { backgroundColor: theme.colors.bg }]} pointerEvents="none" />
        ) : null}
        {/* Propina recibida en vivo (100% del conductor): banner celebratorio flotante, descartable.
            Aparece en cualquier estado de turno; el monto real ya entró a ganancias. */}
        {lastTip ? (
          <View style={styles.tipWrap}>
            <Banner
              tone="success"
              title={t('shift.tipReceivedTitle', { amount: formatPEN(lastTip.tipCents) })}
              description={t('shift.tipReceivedBody')}
              action={{ label: t('common.gotIt'), onPress: clearTip }}
            />
          </View>
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
            <Button
              label={t('common.cancel')}
              variant="secondary"
              onPress={() => setEndConfirm(false)}
            />
            <Button
              label={t('shift.endShift')}
              variant="danger"
              onPress={() => {
                setEndConfirm(false);
                end.mutate();
              }}
            />
          </View>
        }
      >
        <Text variant="callout" color="inkMuted">
          {t('shift.endConfirmBody')}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  topRight: { alignItems: 'flex-end', gap: 8 },
  demandToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  legendWrap: { position: 'absolute', left: 16, right: 16, bottom: 16 },
  tipWrap: { position: 'absolute', left: 16, right: 16, top: 96 },
  vehiclePicker: { marginBottom: 16 },
  greetCard: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, maxWidth: 220 },
  greetText: { flexShrink: 1, paddingRight: 4 },
  dim: { ...StyleSheet.absoluteFill, opacity: 0.55 },
  kpisRow: { flexDirection: 'row', gap: 16 },
  kpi: { flex: 1, gap: 2 },
  onlineHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDotWrap: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  liveDot: { width: 10, height: 10, borderRadius: 999 },
  actionsRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  actionItem: { flex: 1 },
  spaced: { marginTop: 12 },
  bannerBelow: { marginBottom: 12 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
});
