import React, { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
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
  MapShell,
  SafeScreen,
  Skeleton,
  Text,
  useTheme,
} from '@veo/ui-kit';
import type { MainTabParamList, RootStackParamList } from '../../../../navigation/types';
import { useDriverTabBarHeight } from '../../../../navigation/DriverTabBar';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { GlassSheet } from '../../../../shared/presentation/components/GlassSheet';
import { MapTopScrim } from '../../../../shared/presentation/components/MapTopScrim';
import { NoticeHero } from '../../../../shared/presentation/components/NoticeHero';
import {
  IconAlert,
  IconFlame,
  IconChevronRight,
  IconPause,
  IconCoins,
} from '../../../../shared/presentation/icons';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { abbreviateGreetingName, formatPEN, formatPersonName } from '../../../../shared/presentation/format';
import { vehicleClassGlyph, vehicleClassLabelKey } from '../../../../shared/presentation/vehicle-class';
import { LIMA_CENTER } from '../../../../shared/utils/geo';
import { quantizePx } from '../../../../shared/utils/mapCamera';
import { useEarningsBreakdown, useEarningsSummary } from '../hooks/useEarnings';
import { useProfileData } from '../hooks/useProfileData';
import { isBlocking } from '../../../documents/domain';
import { useDocuments } from '../hooks/useDocuments';
import { DemandLegend } from '../../../ops/presentation';
import { useHeatCells, useHeatmap } from '../hooks/useDemand';
import { useDispatchStore } from '../../../realtime/presentation/state/dispatchStore';
import { useTipStore } from '../../../realtime/presentation';
import { useLocationSource } from '../../../../core/location/LocationSourceProvider';
import { useLocationAvailability } from '../../../../core/location/useLocationAvailability';
import {
  canStartShift,
  isOnShift,
  isSuspended,
  type VehicleType,
} from '../../domain';
import { useEndShift, usePauseShift, useShiftState } from '../hooks/useShift';
import { consumeShiftStartedAt } from '../state/shiftClock';
import { useActiveVehicle } from '../hooks/useVehicleCatalog';
import { Appear, PressableScale, Pulse } from '../components/motion';
import { useOpenBids } from '../../../bidding/presentation/hooks/useBids';
import { BidCard } from '../../../bidding/presentation/components/BidCard';
import { CounterOfferSheet } from '../../../bidding/presentation/components/CounterOfferSheet';
import type { OpenBid } from '../../../bidding/domain';
import { FixedOfferCard } from '../../../trips/presentation/components/FixedOfferCard';
import { useConfirmCash, usePendingCashConfirm } from '../../../trips/presentation/hooks/useTrips';

/**
 * "Inicio" es una tab dentro del stack `Main`. Tipamos la navegación de forma compuesta para poder
 * navegar tanto a tabs hermanas (`Ganancias`, `Cuenta`) como a pantallas full-screen del stack raíz
 * (`ShiftStart`, `TripActive`). Misma navegación de negocio que ya existía, con tipos correctos.
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Inicio'>,
  NativeStackScreenProps<RootStackParamList>
>;

/** Etiqueta i18n del tipo de vehículo activo (registro exhaustivo clase→clave, ADR 013 §1.6). */
function vehicleTypeLabel(type: VehicleType, t: TFunction): string {
  return t(vehicleClassLabelKey(type));
}

/** Offset de los slots overlay del MapShell (ui-kit `styles.top`/`styles.bottom` → 12), espejo. */
const MAPSHELL_OVERLAY_OFFSET_PX = 12;
/** Cuantización de los insets de cámara: jitter de layout no re-anima la cámara. */
const MAP_INSET_QUANTUM_PX = 8;

export const DashboardScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const shift = useShiftState();
  const earnings = useEarningsSummary();
  // "Neto de hoy"/"Ganado hoy" sale del DESGLOSE (cobros CAPTURED del día de Lima, payment-service),
  // NO del resumen de payouts: summary.totalNetCents es el neto LIQUIDADO histórico y quedaba
  // congelado en el último payout semanal aunque el conductor completara viajes durante el día.
  const breakdown = useEarningsBreakdown();
  // Nombre del conductor para el saludo (perfil server-authoritative). Mientras carga → cae al rol genérico.
  const profile = useProfileData();
  const driverName = formatPersonName(profile.data?.fullName);
  // Saludo compacto fiel al frame ("Carlos R."): primer nombre + inicial del apellido.
  const greetingName = abbreviateGreetingName(profile.data?.fullName);
  const pause = usePauseShift();
  const end = useEndShift();
  const activeTripId = useDispatchStore((s) => s.activeTripId);
  // Oferta FIXED entrante ("Nuevo viaje"): ya NO abre un full-screen — se surfacea como card en la columna
  // flotante (arriba de las pujas). Al aceptarla, el store setea activeTripId y navegamos al viaje activo.
  const incomingOffer = useDispatchStore((s) => s.incomingOffer);
  // Salud del socket `/driver`: si está caído, el conductor NO publica GPS → el dispatch/admin dejan de verlo.
  const connected = useDispatchStore((s) => s.connected);
  const lastTip = useTipStore((s) => s.lastTip);
  const clearTip = useTipStore((s) => s.clearTip);
  const activeVehicle = useActiveVehicle();
  // El tab bar flota SOBRE el mapa (absolute, no reserva alto): el dock debe elevarse por encima de él.
  const tabBarHeight = useDriverTabBarHeight();
  const { height: screenH } = useWindowDimensions();
  const dockLift = { marginBottom: tabBarHeight - 4 };
  const [endConfirm, setEndConfirm] = useState(false);
  // EFECTIVO (resiliencia del force-close) · cobro CASH que el conductor dejó SIN confirmar tras completar un
  // viaje (cerró la app antes de tocar "Sí, recibí"): el Payment quedaba PENDING para siempre. Esta query lo
  // PERSIGUE al reabrir → banner sobre el mapa + sheet de confirmación. `data` = null si no hay ninguno.
  const pendingCash = usePendingCashConfirm();
  const pendingCashData = pendingCash.data ?? null;
  const [cashSheetOpen, setCashSheetOpen] = useState(false);
  // Mutación de confirmar el cobro pendiente (tripId del pendiente; '' cuando no hay → la mutation no se
  // dispara). Su onSuccess invalida PENDING_CASH_QUERY_KEY → el banner desaparece solo al confirmar.
  const confirmPendingCash = useConfirmCash(pendingCashData?.tripId ?? '');
  // Toggle "Zonas de demanda": pinta el mapa de calor sobre el mapa para orientar al conductor.
  const [demandOn, setDemandOn] = useState(false);
  // Altos medidos del chrome flotante (header arriba, dock abajo): la cámara centra el puck en el
  // área VISIBLE entre ambos, no en la pantalla completa. La columna de pujas es transitoria y se
  // ignora adrede (re-encuadrar por cada puja entrante marearía).
  const [headerPx, setHeaderPx] = useState(0);
  const [dockPx, setDockPx] = useState(0);

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

  // Pujas OPEN cercanas (llegan por socket, `dispatch:offer` invalida la query): en el dock online se
  // listan como cards EDITORIALES para TOMAR/OFERTAR sin salir del dashboard (estilo cola inDrive). Solo
  // se consulta en turno y sin viaje activo (offline el backend daría []/403; en viaje no se puja).
  const openBids = useOpenBids(online && !activeTripId);
  const [selectedBid, setSelectedBid] = useState<OpenBid | null>(null);
  // Si el conductor GANA una puja, el dock salta al viaje activo → cerramos el sheet para que no quede
  // overlaid sobre el viaje (mismo guard que BidsScreen: "La puja venció" sin forma de cerrar).
  useEffect(() => {
    if (activeTripId) {
      setSelectedBid(null);
    }
  }, [activeTripId]);
  // La puja abierta en el sheet desapareció de la lista viva (otro la tomó / venció): el sheet lo refleja.
  const selectedBidGone =
    selectedBid !== null &&
    openBids.data !== undefined &&
    !openBids.data.some((b) => b.tripId === selectedBid.tripId);

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

  // Gate de iniciar turno. Documentos BLOQUEANTES (vencido/rechazado): sin ellos vigentes el conductor
  // no puede operar (frame C/Turno-DocsVencidos). Si la lista aún no cargó, NO bloqueamos (degradación
  // honesta: mejor dejar iniciar que bloquear por un dato ausente; el backend igual valida).
  const documents = useDocuments();
  const hasBlockingDocs = (documents.data ?? []).some((doc) => isBlocking(doc.simpleStatus));
  // Permiso de ubicación denegado: sin GPS el dispatch no lo ve → pantalla dedicada (C/Permiso-Ubicacion).
  // Solo cuando el adapter nativo reportó disponibilidad (null = sin GPS nativo en dev → no gateamos).
  const locationPermissionDenied =
    gpsAvailability != null && !gpsAvailability.permissionGranted;

  /**
   * Inicia (o reanuda) el turno con dos gates previos, en orden: (1) documentos bloqueantes →
   * `ShiftBlocked`; (2) permiso de ubicación denegado → `LocationPermission`. Si no aplica ninguno,
   * sigue el flujo normal a `ShiftStart`.
   */
  const handleConnect = () => {
    if (hasBlockingDocs) {
      navigation.navigate('ShiftBlocked');
      return;
    }
    if (locationPermissionDenied) {
      navigation.navigate('LocationPermission');
      return;
    }
    navigation.navigate('ShiftStart');
  };

  // Confirma (o reporta la discrepancia de) el cobro EFECTIVO pendiente. `useConfirmCash` resuelve el paymentId
  // server-side por el tripId y captura/reporta; al terminar OK cierra el sheet (su onSuccess ya invalida la
  // query del pendiente → el banner desaparece solo). Si falla, el sheet queda abierto y muestra el error.
  const handleConfirmCash = (collected: boolean) => {
    // Al OK: mostramos el feedback de éxito EN el sheet (~1.4s) y RECIÉN ahí cerramos — así el conductor
    // VE que se registró (no depende solo de que el banner desaparezca, que confundía). El banner igual
    // se va por la invalidación del onSuccess de la mutation.
    confirmPendingCash.mutate(collected, {
      onSuccess: () => setTimeout(() => setCashSheetOpen(false), 2500),
    });
  };
  // Abre el sheet FRESCO (resetea el estado de la mutación previa → no arrastra un "éxito" viejo).
  const openCashSheet = () => {
    confirmPendingCash.reset();
    setCashSheetOpen(true);
  };

  // Mapa de calor de demanda: solo cuando el conductor está en línea, sin viaje, con el toggle
  // activo y con ubicación conocida. Si falta cualquier condición, la query queda inactiva (null).
  const heatmapQuery =
    demandOn && online && !activeTripId && driverPoint
      ? { lat: driverPoint.lat, lng: driverPoint.lon }
      : null;
  const heatmap = useHeatmap(heatmapQuery);
  const heatCells = useHeatCells(heatmap.data);
  const showDemandToggle = online && !activeTripId;

  // Cuenta suspendida (frame C/Cuenta-Suspendida): NO es un banner sobre el dashboard — es un layout
  // dedicado a pantalla completa que reemplaza el mapa/dock, porque el conductor no puede operar. Aviso
  // crítico centrado + salida a Documentos (regularizar) o a soporte. Colocado tras TODOS los hooks para
  // no romper las reglas de hooks.
  // BACKEND: el "motivo" de la suspensión (el pill "Motivo: documento vencido" del frame) NO viene del
  // servidor; se OMITE el pill en vez de inventar la causa. GLYPH: el frame usa `octagon-alert`, que no
  // existe en el set propio — usamos `IconAlert` (triángulo de alerta, el glifo de peligro ya en uso).
  // ADR-022 §P-A · BLOQUEO por DEUDA de comisiones (frame de cuenta en pausa). Prioridad SOBRE la suspensión
  // genérica: el conductor debe saber que la salida es SALDAR (no "actualizar documentos"). El bloqueo NO se
  // materializa como currentStatus=SUSPENDED (bloqueo tipo A: el viaje en curso termina normal), así que se
  // detecta con el flag `debtBlocked` que identity expone en el perfil — no con `isSuspended(status)`. Es
  // imposible de ignorar: reemplaza el mapa/dock a pantalla completa, el conductor no puede operar. El monto
  // sale del resumen de ganancias (pendingDebtCents); si aún carga, se omite el subtítulo del monto (no se
  // inventa). Colocado tras TODOS los hooks (reglas de hooks), antes de la suspensión genérica.
  const debtBlocked = profile.data?.debtBlocked === true;
  const pendingDebtCents = earnings.data?.pendingDebtCents ?? 0;
  if (debtBlocked) {
    return (
      <SafeScreen
        footer={
          <View style={styles.suspendedFooter}>
            <Button
              label={t('shift.debtBlock.settleCta')}
              variant="primary"
              fullWidth
              onPress={() => navigation.navigate('SettleDebt')}
            />
            <Button
              label={t('shift.contactSupport')}
              variant="ghost"
              fullWidth
              onPress={() => navigation.navigate('Support')}
            />
          </View>
        }
      >
        <NoticeHero
          tone="danger"
          icon={({ size, color }) => <IconAlert size={size} color={color} strokeWidth={2} />}
          title={t('shift.debtBlock.title')}
          description={
            pendingDebtCents > 0
              ? t('shift.debtBlock.bodyWithAmount', { amount: formatPEN(pendingDebtCents) })
              : t('shift.debtBlock.body')
          }
        />
      </SafeScreen>
    );
  }

  if (isSuspended(status)) {
    return (
      <SafeScreen
        footer={
          <View style={styles.suspendedFooter}>
            <Button
              label={t('shift.suspendedUpdateDocs')}
              variant="primary"
              fullWidth
              onPress={() => navigation.navigate('Documents')}
            />
            <Button
              label={t('shift.contactSupport')}
              variant="ghost"
              fullWidth
              onPress={() => navigation.navigate('Support')}
            />
          </View>
        }
      >
        <NoticeHero
          tone="danger"
          icon={({ size, color }) => <IconAlert size={size} color={color} strokeWidth={2} />}
          title={t('shift.suspendedTitle')}
          description={t('shift.suspendedBody')}
        />
      </SafeScreen>
    );
  }

  // Cabecera flotante: avatar (→ perfil) + saludo a la izquierda; pill de estado a la derecha.
  const topOverlay = (
    <View
      style={[styles.topRow, { paddingTop: insets.top }]}
      pointerEvents="box-none"
      // Mide el header flotante (incluye el paddingTop del notch): inset superior de la cámara.
      onLayout={(e) => setHeaderPx(Math.round(e.nativeEvent.layout.height))}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('shift.viewProfile')}
        onPress={() => navigation.navigate('Cuenta')}
      >
        {/* GreetPill (frame C/Dashboard): avatar + saludo dentro de una pastilla glass. El fondo va en un
            View plano — el AnimatedPressable de PressableScale no pinta backgroundColor de forma fiable. */}
        <View
          style={[
            styles.greetCard,
            {
              // surfaceElevated (mismo token que el pill superior del passenger): chrome elevado sobre el mapa.
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              ...theme.elevation.level2,
            },
          ]}
        >
          <Avatar name={driverName ?? 'VEO'} size="sm" tone="neutral" />
          <View style={styles.greetText}>
            <Text variant="caption" color="inkSubtle">
              {t('shift.greetingHi')}
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {greetingName ?? t('shift.greetingRole')}
            </Text>
          </View>
        </View>
      </PressableScale>
      <View style={styles.topRight}>
        {/* Chip del header según el estado de turno (frames C/Dashboard*): EN LÍNEA → toggle "Demanda" del
            mapa de calor; EN PAUSA → pill ámbar "En pausa"; FUERA DE TURNO → pill neutro "Fuera de turno".
            El toggle solo vive en línea; el estado de turno sí sube al header en pausa/offline. */}
        {showDemandToggle ? (
          <PressableScale
            accessibilityRole="switch"
            accessibilityState={{ checked: demandOn }}
            accessibilityLabel={t('ops.demand.toggle')}
            onPress={() => setDemandOn((prev) => !prev)}
            style={[
              styles.demandToggle,
              {
                // Off: brand-dim (container del primary) + borde teal. On: teal sólido.
                backgroundColor: demandOn ? theme.colors.accent : theme.colors.brandDim,
                borderColor: theme.colors.accent,
                borderRadius: theme.radii.pill,
              },
            ]}
          >
            <IconFlame
              size={16}
              color={demandOn ? theme.colors.onAccent : theme.colors.accent}
              strokeWidth={2}
            />
            <Text variant="footnote" color={demandOn ? 'onAccent' : 'accent'} numberOfLines={1}>
              {t('shift.demandShort')}
            </Text>
          </PressableScale>
        ) : status === 'ON_BREAK' ? (
          // Pill ámbar "En pausa" (frame uygho · PausePill): icono pausa + texto sobre surface, borde warn.
          <View
            style={[
              styles.statusPill,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.warn,
                borderRadius: theme.radii.pill,
                ...theme.elevation.level1,
              },
            ]}
          >
            <IconPause size={12} color={theme.colors.warn} strokeWidth={2} />
            <Text variant="footnote" color="warn" numberOfLines={1}>
              {t('shift.pill.paused')}
            </Text>
          </View>
        ) : shift.data && !online ? (
          // Pill neutro "Fuera de turno" (frame Qy65J · OffPill): punto gris + texto sobre surface, borde neutro.
          <View
            style={[
              styles.statusPill,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.pill,
                ...theme.elevation.level1,
              },
            ]}
          >
            <View style={[styles.pillDot, { backgroundColor: theme.colors.inkSubtle }]} />
            <Text variant="footnote" color="inkMuted" numberOfLines={1}>
              {t('shift.status.offline')}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  // Pin pulsante solo cuando está en línea y hay un fix real de GPS.
  const mapDriver = online ? driverPoint : null;

  // Métricas en vivo. Parametrizada porque el dock offline ("Neto acumulado" / Por liquidar en ink) y el
  // dock en pausa ("Ganado hoy" / Por liquidar en ámbar) comparten estructura pero difieren en etiqueta,
  // color y FUENTE del primer KPI: 'today' = desglose de HOY (cobros del día, se mueve viaje a viaje);
  // 'lifetime' = neto liquidado acumulado del resumen de payouts. "Por liquidar" siempre sale del resumen.
  const renderEarningsMetrics = (
    firstLabel: string,
    firstSource: 'today' | 'lifetime',
    firstColor: React.ComponentProps<typeof Text>['color'],
    secondColor: React.ComponentProps<typeof Text>['color'],
  ): React.ReactNode =>
    earnings.isLoading || (firstSource === 'today' && breakdown.isLoading) ? (
      <Skeleton height={56} />
    ) : earnings.isError ||
      !earnings.data ||
      (firstSource === 'today' && (breakdown.isError || !breakdown.data)) ? (
      <Banner tone="warn" title={t('shift.kpisUnavailable')} />
    ) : (
      <View style={styles.kpisRow}>
        <Appear
          style={[styles.kpi, { backgroundColor: theme.colors.surface, borderRadius: theme.radii.md }]}
          delay={40}
        >
          <Text variant="title3" color={firstColor} tabular>
            {formatPEN(
              (firstSource === 'today'
                ? breakdown.data?.today.netCents
                : earnings.data.totalNetCents) ?? 0,
            )}
          </Text>
          <Text variant="caption" color="inkSubtle">
            {firstLabel}
          </Text>
        </Appear>
        <Appear
          style={[styles.kpi, { backgroundColor: theme.colors.surface, borderRadius: theme.radii.md }]}
          delay={110}
        >
          <Text variant="title3" color={secondColor} tabular>
            {formatPEN(earnings.data.pendingNetCents ?? 0)}
          </Text>
          <Text variant="caption" color="inkSubtle">
            {t('shift.pendingNet')}
          </Text>
        </Appear>
      </View>
    );

  // Vehículo activo (server-authoritative): con qué vehículo opera. Compartido por el dock online/offline.
  const activeVeh = activeVehicle.data;
  const ActiveVehIcon = activeVeh ? vehicleClassGlyph(activeVeh.vehicleType) : null;

  // KPIs del dock (frame C/Dashboard): "Neto de hoy" | "Por liquidar" (naranja) con divisor central.
  // "Neto de hoy" = breakdown.today (cobros del día de Lima); "Por liquidar" = pendingNetCents HONESTO
  // del summary: devengado digital del período ABIERTO + payouts no pagados + crédito − deuda PENDING
  // (ya no queda en S/0 toda la semana hasta que el cron del lunes agregue el payout).
  const dockKpis = earnings.isLoading || breakdown.isLoading ? (
    <Skeleton height={44} />
  ) : earnings.isError || !earnings.data || breakdown.isError || !breakdown.data ? (
    <Banner tone="warn" title={t('shift.kpisUnavailable')} />
  ) : (
    <View style={styles.kpiRow}>
      <View style={styles.kpiCell}>
        <Text variant="caption" color="inkSubtle">
          {t('shift.netToday')}
        </Text>
        <Text variant="title3" color="ink" tabular>
          {formatPEN(breakdown.data.today.netCents ?? 0)}
        </Text>
      </View>
      <View style={[styles.kpiDivider, { backgroundColor: theme.colors.border }]} />
      <View style={styles.kpiCell}>
        <Text variant="caption" color="inkSubtle">
          {t('shift.pendingNet')}
        </Text>
        <Text variant="title3" color="warn" tabular>
          {formatPEN(earnings.data.pendingNetCents ?? 0)}
        </Text>
      </View>
    </View>
  );

  // Cola de pujas FLOTANTE (no vive DENTRO del dock): es una columna que baja DESDE ARRIBA (bajo el
  // header) — cada puja nueva entra arriba y empuja a las anteriores hacia abajo, y la banda scrollea si
  // desborda. Acotada por `bidsBandMaxHeight` para que NUNCA tape el dock (queda siempre visible abajo).
  // Orden NEWEST-FIRST: la puja más nueva entra ARRIBA y empuja a las anteriores hacia abajo (pedido del
  // jefe). `expiresAt` es fijo por puja y la ventana es constante → más reciente ⇒ expira más tarde ⇒ va arriba.
  const openBidsList = [...(openBids.data ?? [])].sort((a, b) => b.expiresAt - a.expiresAt);
  // La columna muestra TODAS las ofertas entrantes: la FIXED ("Nuevo viaje", arriba de todo por ser la más
  // nueva) + las pujas OPEN debajo. Misma lista editorial, top-down.
  const showOffer = incomingOffer != null;
  const hasColumn = online && !activeTripId && (showOffer || openBidsList.length > 0);
  // Banda disponible entre el header (arriba) y el dock+tab bar (abajo): se reserva alto de sobra para el
  // dock (≈300) para GARANTIZAR que la columna se corte antes de llegar a él (erra chico = seguro).
  const bidsBandMaxHeight = Math.max(140, screenH - insets.top - 76 - tabBarHeight - 300);
  const bidsColumn = hasColumn ? (
    <View style={[styles.bidsColumn, { top: insets.top + 76, maxHeight: bidsBandMaxHeight }]}>
      <ScrollView
        contentContainerStyle={styles.bidsScrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* FIXED "Nuevo viaje" primero (la más nueva empuja a las pujas hacia abajo). Cada card ENTRA con
            fade+desplazamiento y el reflow (cuando entra una puja nueva y empuja a las demás) es ANIMADO
            (LinearTransition) en vez de un salto brusco. */}
        {incomingOffer ? (
          <Animated.View entering={FadeInDown.springify()} layout={LinearTransition.springify()}>
            <FixedOfferCard
              offer={incomingOffer}
              onAccepted={(tripId) => navigation.navigate('TripActive', { tripId })}
            />
          </Animated.View>
        ) : null}
        {openBidsList.map((bid) => (
          <Animated.View
            key={bid.tripId}
            entering={FadeInDown.springify()}
            layout={LinearTransition.springify()}
          >
            <BidCard bid={bid} onPress={() => setSelectedBid(bid)} />
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  ) : null;

  // ─── Dock inferior: estados de carga/error > viaje activo > en línea > desconectado.
  // El mapa de fondo se monta UNA sola vez (return único más abajo): nunca se desmonta entre
  // estados, evitando el reciclaje de la vista nativa en Fabric y la cancelación del estilo. ───
  let bottomOverlay: React.ReactNode;

  if (shift.isLoading) {
    bottomOverlay = (
      <GlassSheet floating style={dockLift}>
        <Skeleton height={96} />
      </GlassSheet>
    );
  } else if (shift.isError || !shift.data) {
    bottomOverlay = (
      <GlassSheet floating style={dockLift}>
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
      </GlassSheet>
    );
  } else if (activeTripId) {
    // Prioridad máxima: acceso directo al viaje en curso.
    bottomOverlay = (
      <GlassSheet floating style={dockLift}>
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
      </GlassSheet>
    );
  } else if (online) {
    // En línea (frame C/Dashboard · Dock): punto vivo + "Listo para viajes", selector de vehículo (fila),
    // KPIs (neto de hoy / por liquidar) y Pausar/Desconectarme. Fiel a la card del board — las OFERTAS de
    // puja llegan por push (no hay botón "Pujas abiertas" siempre visible, que el board no muestra).
    bottomOverlay = (
      <Appear key="online">
        <GlassSheet floating style={dockLift}>
          {gpsUnavailable ? (
            <Banner
              tone="danger"
              title={t('shift.gpsUnavailableTitle')}
              description={gpsBannerBody}
              action={{ label: t('shift.gpsOpenSettings'), onPress: () => Linking.openSettings() }}
              style={styles.bannerBelow}
            />
          ) : null}
          {/* StatusRow: punto vivo verde + "Listo para viajes" (o "Reconectando…" si el socket cayó, honesto). */}
          <View style={styles.statusRow}>
            <Pulse active={status === 'AVAILABLE' && connected} style={styles.liveDotWrap}>
              <View
                style={[
                  styles.liveDot,
                  { backgroundColor: connected ? theme.colors.success : theme.colors.inkSubtle },
                ]}
              />
            </Pulse>
            <Text variant="title3">
              {connected ? t('shift.readyForTrips') : t('shift.status.reconnecting')}
            </Text>
          </View>
          {/* Selector de vehículo (fila gris del board): con qué vehículo opera; toca para gestionar/cambiar. */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('vehicles.manage')}
            onPress={() => navigation.navigate('Vehicles')}
            style={[styles.vehicleSel, { backgroundColor: theme.colors.bg, borderRadius: theme.radii.md }]}
          >
            {/* Fila HORIZONTAL en un View plano interno (el flexDirection del PressableScale no se aplica
                fiable → el chevron caía debajo). Mismo patrón que la fila de cobro. */}
            <View style={styles.vehicleSelInner}>
              <View style={styles.vehicleSelLeft}>
                {ActiveVehIcon ? <ActiveVehIcon size={18} color={theme.colors.inkMuted} /> : null}
                <Text variant="bodyStrong" numberOfLines={1}>
                  {activeVeh
                    ? `${vehicleTypeLabel(activeVeh.vehicleType, t)} · ${activeVeh.plate}`
                    : t('shift.vehicleType.none')}
                </Text>
              </View>
              <IconChevronRight size={18} color={theme.colors.inkSubtle} />
            </View>
          </PressableScale>
          {/* EFECTIVO · cobro por confirmar — vive DENTRO del dock (zona de plata), NO como banner flotante
              arriba: no es urgente como una oferta (esa tiene countdown y es plata por ganar) sino una tarea
              de cierre. Así no tapa la columna de ofertas. Toca → sheet de confirmación. Solo si hay pendiente. */}
          {pendingCashData ? (
            // El margen/divisor van en un View plano EXTERNO, NO en el PressableScale: el AnimatedPressable
            // (reanimated) se come props de layout (flexDirection Y margin) → el marginTop del pressable no
            // se aplicaba y moto+cobro quedaban pegados. Un View plano respeta margin/border sin falla.
            <View style={[styles.cashSection, { borderTopColor: theme.colors.border }]}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('shift.cashPending.bannerTitle')}
                onPress={openCashSheet}
                style={[styles.cashRow, { backgroundColor: theme.colors.bg, borderRadius: theme.radii.md }]}
              >
                {/* La fila HORIZONTAL vive en un View plano interno, NO en el PressableScale (mismo motivo:
                    el flexDirection del pressable no se aplica → el chevron caía debajo). */}
                <View style={styles.cashRowInner}>
                  <View style={[styles.cashRowTile, { backgroundColor: theme.colors.warnDim }]}>
                    <IconCoins size={18} color={theme.colors.warnText} />
                  </View>
                  <View style={styles.cashRowText}>
                    <Text variant="footnote" color="inkMuted">
                      {t('shift.cashPending.rowLabel')}
                    </Text>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {formatPEN(pendingCashData.amountCents)}
                    </Text>
                  </View>
                  <IconChevronRight size={18} color={theme.colors.inkSubtle} />
                </View>
              </PressableScale>
            </View>
          ) : null}
          {dockKpis}
          {/* Actions: Pausar (outlined, ocupa el ancho) + Desconectarme (ghost gris, fit-content). */}
          <View style={styles.actionsRow}>
            {status === 'AVAILABLE' ? (
              <Button
                label={t('shift.pause')}
                variant="secondary"
                fullWidth
                loading={pause.isPending}
                onPress={() => pause.mutate()}
                style={styles.actionItem}
                leftIcon={<IconPause size={16} color={theme.colors.ink} strokeWidth={2} />}
              />
            ) : null}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t('shift.goOffline')}
              onPress={() => setEndConfirm(true)}
              style={styles.disconnectBtn}
            >
              <Text variant="subhead" color="inkMuted">
                {t('shift.goOffline')}
              </Text>
            </PressableScale>
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
        </GlassSheet>
      </Appear>
    );
  } else if (status === 'ON_BREAK') {
    // En pausa (frame C/Dashboard-Pausado · uygho): dock DEDICADO, distinto del offline. SIN fila de
    // vehículo. Punto ámbar + "Turno en pausa" (mismo peso/tamaño que "Listo para viajes"), descripción,
    // métricas ("Ganado hoy" verde / "Por liquidar" ámbar), CTA azul "Reanudar turno" y ghost
    // "Desconectarme" que dispara el MISMO flujo de cierre que el dock online (setEndConfirm).
    bottomOverlay = (
      <Appear key="paused">
        <GlassSheet floating style={dockLift}>
          {/* StatusRow: punto ámbar estático + "Turno en pausa" (title3, igual que el heading en línea). */}
          <View style={styles.statusRow}>
            <View style={[styles.liveDot, { backgroundColor: theme.colors.warn }]} />
            <Text variant="title3">{t('shift.status.paused')}</Text>
          </View>
          <Text variant="footnote" color="inkMuted">
            {t('shift.pausedBody')}
          </Text>
          <View style={styles.spaced}>
            {renderEarningsMetrics(t('shift.earnedToday'), 'today', 'accentStrong', 'warn')}
          </View>
          {/* CTA azul: reanudar pasa por los mismos gates de iniciar turno (docs + ubicación → ShiftStart). */}
          <Button
            label={t('shift.resume')}
            size="lg"
            fullWidth
            onPress={handleConnect}
            style={styles.spaced}
          />
          {/* Ghost gris "Desconectarme": cierra turno con la misma confirmación que el dock online. */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('shift.goOffline')}
            onPress={() => setEndConfirm(true)}
            style={styles.disconnectBtn}
          >
            <Text variant="subhead" color="inkMuted">
              {t('shift.goOffline')}
            </Text>
          </PressableScale>
          {end.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(end.error, t)}
              style={styles.spaced}
            />
          ) : null}
        </GlassSheet>
      </Appear>
    );
  } else {
    // Desconectado (frame C/Dashboard-Offline): vehículo activo compacto + KPIs + "Conéctate".
    // `activeVeh`/`ActiveVehIcon` están hoisteados arriba (compartidos con el dock online).
    bottomOverlay = (
      <Appear key="offline">
        <GlassSheet floating style={dockLift}>
          {/* Vehículo activo (frame C/Dashboard-Offline): UNA fila = tile del icono + (etiqueta / vehículo)
              apilados + link "Gestionar" a la derecha. Registrar/cambiar se hace en la pantalla Vehículos. */}
          {activeVehicle.isLoading ? (
            <View style={styles.vehicleRow}>
              <Skeleton width={40} height={40} radius={theme.radii.md} />
              <View style={styles.vehicleInfo}>
                <Skeleton width={90} height={11} radius={theme.radii.sm} />
                <Skeleton width={130} height={15} radius={theme.radii.sm} />
              </View>
            </View>
          ) : activeVeh && ActiveVehIcon ? (
            <View style={styles.vehicleRow}>
              <View style={[styles.vehicleTile, { backgroundColor: theme.colors.surfaceElevated }]}>
                <ActiveVehIcon size={22} color={theme.colors.ink} />
              </View>
              <View style={styles.vehicleInfo}>
                <Text variant="caption" color="inkSubtle">
                  {t('shift.vehicleType.label')}
                </Text>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {`${vehicleTypeLabel(activeVeh.vehicleType, t)} · ${activeVeh.plate}`}
                </Text>
              </View>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t('vehicles.manage')}
                onPress={() => navigation.navigate('Vehicles')}
              >
                <Text variant="footnote" color="accent">
                  {t('vehicles.manageShort')}
                </Text>
              </PressableScale>
            </View>
          ) : (
            <Banner tone="warn" title={t('shift.vehicleType.none')} />
          )}
          <View style={styles.spaced}>
            {renderEarningsMetrics(t('shift.netTotal'), 'lifetime', 'accentStrong', 'ink')}
          </View>
          {/* SUSPENDED se atiende ANTES con un layout dedicado a pantalla completa (early return), así que
            este dock offline solo cubre: conectable (CTA "Conéctate") o estado no reconocido (aviso). */}
          {canStartShift(status) ? (
            <Button
              label={t('shift.connect')}
              size="lg"
              fullWidth
              onPress={handleConnect}
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
        </GlassSheet>
      </Appear>
    );
  }

  // Dock MEDIDO (el alto incluye el lift sobre el tab bar — margen del hijo empuja al wrapper):
  // inset inferior de la cámara. Los overlays del MapShell arrancan a 12 px del borde (espejo).
  const measuredBottomOverlay = (
    <View onLayout={(e) => setDockPx(Math.round(e.nativeEvent.layout.height))}>{bottomOverlay}</View>
  );
  const mapTopInset = quantizePx(MAPSHELL_OVERLAY_OFFSET_PX + headerPx, MAP_INSET_QUANTUM_PX);
  const mapBottomInset = quantizePx(MAPSHELL_OVERLAY_OFFSET_PX + dockPx, MAP_INSET_QUANTUM_PX);

  return (
    <SafeScreen padded={false} topInset={false}>
      <MapShell
        topOverlay={topOverlay}
        bottomOverlay={measuredBottomOverlay}
        loading={shift.isLoading}
      >
        <AppMap
          center={driverPoint ?? LIMA_CENTER}
          driver={mapDriver}
          heatCells={demandOn ? heatCells : undefined}
          // Área visible: la cámara centra entre el header flotante (arriba) y el dock (abajo).
          topInset={mapTopInset}
          bottomInset={mapBottomInset}
          interactive={online}
        />
        {/* Velo superior (frame `Dim`): asegura la legibilidad del saludo/pill sobre el mapa. */}
        <MapTopScrim />
        {/* Atenuación del mapa cuando el conductor no está en línea. */}
        {!online ? (
          <View style={[styles.dim, { backgroundColor: theme.colors.bg }]} pointerEvents="none" />
        ) : null}
        {/* Cola de pujas: columna flotante que baja desde el header. Renderizada como hijo del MapShell →
            queda POR DEBAJO del header y del dock (los overlays van después): nunca los tapa visualmente. */}
        {bidsColumn}
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
                // Al cerrar turno con éxito: consumimos el reloj LOCAL (lee + borra la marca de inicio) y
                // vamos al resumen de cierre en vez de quedarnos en el dock offline. Si falla el mutate, no
                // navegamos (el estado sigue en turno y se muestra el error habitual).
                end.mutate(undefined, {
                  onSuccess: () => {
                    const shiftStartedAt = consumeShiftStartedAt();
                    navigation.navigate('ShiftSummary', { shiftStartedAt });
                  },
                });
              }}
            />
          </View>
        }
      >
        <Text variant="callout" color="inkMuted">
          {t('shift.endConfirmBody')}
        </Text>
      </BottomSheet>
      {/* Sheet TOMAR/OFERTAR de la puja tocada en el dock (mismo componente que el board dedicado de pujas). */}
      <CounterOfferSheet
        bid={selectedBid}
        gone={selectedBidGone}
        onClose={() => setSelectedBid(null)}
      />
      {/* EFECTIVO · sheet de confirmación del cobro pendiente. "Sí, recibí" (accent) captura; "No cobré" (ghost)
          reporta la discrepancia. Ambos cierran el sheet al OK; el banner desaparece por la invalidación. */}
      <BottomSheet
        // Visible por `cashSheetOpen` SOLO (no `&& pendingCashData`): al confirmar, el onSuccess invalida
        // la query → pendingCashData pasa a null; si atáramos `visible` a eso, el sheet cerraría AL INSTANTE
        // y el feedback de "¡Cobro registrado!" nunca se vería. Lo cierra nuestro setTimeout (~2.5s).
        visible={cashSheetOpen}
        onClose={() => setCashSheetOpen(false)}
        title={t('shift.cashPending.sheetTitle')}
        footer={
          // En ÉXITO ocultamos los botones (queda solo el feedback ~2.5s antes de cerrar solo).
          confirmPendingCash.isSuccess ? undefined : (
            <View style={styles.sheetFooter}>
              <Button
                label={t('shift.cashPending.notCollected')}
                variant="ghost"
                loading={confirmPendingCash.isPending}
                onPress={() => handleConfirmCash(false)}
              />
              <Button
                label={t('shift.cashPending.collected')}
                variant="accent"
                loading={confirmPendingCash.isPending}
                onPress={() => handleConfirmCash(true)}
              />
            </View>
          )
        }
      >
        {confirmPendingCash.isSuccess ? (
          // Feedback EXPLÍCITO (no depende solo de que el banner desaparezca): "Sí, recibí" → verde
          // "¡Cobro registrado! ✓"; "No cobré" NO es un éxito de cobro sino deuda del pasajero → tono
          // neutro, mensaje que aclara que se le cobrará al pasajero (no perjudica al conductor).
          <Text
            variant="bodyStrong"
            style={{
              color: confirmPendingCash.variables ? theme.colors.success : theme.colors.ink,
            }}
          >
            {confirmPendingCash.variables
              ? t('shift.cashPending.registered')
              : t('shift.cashPending.reported')}
          </Text>
        ) : (
          <Text variant="callout" color="inkMuted">
            {pendingCashData
              ? t('shift.cashPending.sheetBody', { amount: formatPEN(pendingCashData.amountCents) })
              : ''}
          </Text>
        )}
        {confirmPendingCash.isError ? (
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(confirmPendingCash.error, t)}
            style={styles.spaced}
          />
        ) : null}
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
  // Status pills del header (frames uygho·PausePill / Qy65J·OffPill): fila con icono/punto + texto, borde
  // fino sobre surface, radio pill (inline). Compartida por "En pausa" (borde warn) y "Fuera de turno".
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  pillDot: { width: 8, height: 8, borderRadius: 999 },
  demandToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  // Dock online (frame C/Dashboard): StatusRow + selector de vehículo + KpiRow, con gap 12 (marginTop).
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // Columna flotante de pujas: absoluta bajo el header, ancho inset (left/right 12 como los overlays del
  // MapShell). `top`/`maxHeight` se inyectan inline (dependen de insets + tab bar). El ScrollView hug-ea el
  // contenido: con pocas pujas es corto (el mapa respira debajo); si desborda, scrollea dentro de la banda.
  bidsColumn: { position: 'absolute', left: 12, right: 12 },
  bidsScrollContent: { gap: 10 },
  vehicleSel: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  vehicleSelInner: { flexDirection: 'row', alignItems: 'center' },
  vehicleSelLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  kpiRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  kpiCell: { flex: 1, gap: 2 },
  kpiDivider: { width: 1, height: 34 },
  disconnectBtn: {
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendWrap: { position: 'absolute', left: 16, right: 16, bottom: 16 },
  tipWrap: { position: 'absolute', left: 16, right: 16, top: 96 },
  // Fila de cobro EFECTIVO por confirmar: vive DENTRO del dock (mismo tratamiento que vehicleSel). El tile
  // ámbar suave (warnDim) da el toque cálido de "pendiente" sin el banner amarillo estridente de antes.
  // Corte de sección entre el bloque de ESTADO (Listo + vehículo) y el bloque de PLATA (cobro + KPIs):
  // aire + un divisor hairline. Va en el View EXTERNO (no en el PressableScale, que se come el margin).
  cashSection: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cashRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  cashRowInner: { flexDirection: 'row', alignItems: 'center' },
  cashRowTile: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  cashRowText: { flex: 1, gap: 1, marginLeft: 10 },
  vehicleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  vehicleTile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  vehicleInfo: { flex: 1, gap: 1 },
  // GreetPill (frame C/Dashboard): pastilla blanca sólida + borde + sombra suave; bg/borde/elevación del tema.
  greetCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 240,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  greetText: { flexShrink: 1, paddingRight: 4 },
  dim: { ...StyleSheet.absoluteFill, opacity: 0.55 },
  kpisRow: { flexDirection: 'row', gap: 12 },
  kpi: { flex: 1, gap: 2, padding: 14 },
  onlineHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDotWrap: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  liveDot: { width: 10, height: 10, borderRadius: 999 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  actionItem: { flex: 1 },
  spaced: { marginTop: 12 },
  bannerBelow: { marginBottom: 12 },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  suspendedFooter: { gap: 8 },
});
