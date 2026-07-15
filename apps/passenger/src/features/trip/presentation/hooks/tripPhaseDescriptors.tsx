import type {
  OfferView,
  PlaceSuggestion,
  TripActiveView,
  TripResource,
} from '@veo/api-client';
import {tripStatus} from '@veo/api-client';
import {IconButton, SearchField, Skeleton, Text, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, TextInput, View} from 'react-native';
import type {RoutePlace} from '../../../maps/domain/entities';
import type {SavedPlace} from '../../../places/domain/entities';
import {ErrorState} from '../../../../shared/presentation/components/ScreenStates';
import {ActiveTripBody} from '../components/ActiveTripBody';
import {TripStatusStrip} from '../components/TripStatusStrip';
import {formatDurationMinutes} from '../../../../shared/utils/format';
import {CompletionBody} from '../components/CompletionBody';
import {DebtStrip} from '../components/DebtStrip';
import {HomeHero} from '../components/HomeHero';
import {HomeShortcutChips} from '../components/HomeShortcutChips';
import {ModeToggle, TripTimeMode} from '../components/ModeToggle';
import {
  IconArrowLeft,
  IconClose,
  IconMap,
  IconSearch,
} from '../components/icons';
import {IdleBody} from '../components/IdleBody';
import {LastDriverCard} from '../components/LastDriverCard';
import {EnterView} from '../components/motion';
import {NoOffersBody} from '../components/NoOffersBody';
import {NoDriverBody} from '../components/NoDriverBody';
import {OffersBody} from '../components/OffersBody';
import {QuotingBody} from '../components/QuotingBody';
import {placeToRoute, suggestionToRoute} from '../components/routePlace';
import {SearchingBody} from '../components/SearchingBody';
import type {LastDriver} from './useLastDriver';
import type {OfferBoard} from './useOfferBoard';
import type {UsePassengerTripSocket} from '../../../../core/realtime/usePassengerTripSocket';
import type {WaypointProposalController} from './useWaypointProposal';
import type {TripPhase} from './tripFlowPhase';
import type {NearbyVehicleType} from '../../../dispatch/domain/dispatchRepository';

/** Modo LOCAL del sheet en el home: `idle` (atajos) o `searching` (búsqueda plegada DENTRO del sheet). */
export type SheetFlowState = 'idle' | 'searching';

/**
 * CONTEXTO que el contenedor (`RequestFlowScreen`) le pasa a los slots del descriptor (Body/Header).
 * Es el wiring EXPLÍCITO del sheet: datos derivados de los hooks + callbacks de orquestación. Los slots
 * NO conocen hooks de pantalla; solo leen de acá (mismo contrato que tenían como JSX inline).
 */
export interface RequestFlowContext {
  /** Eje LOCAL del sheet (segunda máquina, solo significativa en el home). */
  flow: SheetFlowState;
  /** Id del viaje vivo. Las fases con viaje lo tienen garantizado (solo esos slots lo leen). */
  activeTripId: string | null;
  /** Board de la PUJA (ofertas vivas + estado + mutaciones aceptar/cancelar). */
  board: OfferBoard;
  /** Estado en vivo del socket `/passenger` (ETA, ubicación del conductor, chat). */
  live: UsePassengerTripSocket;
  /** Detalle del viaje activo/cierre (`null` mientras carga → Skeleton). */
  tripDetail: TripActiveView | null;
  /** El detalle del viaje FALLÓ (query en error) y aún no hay dato: sin esto el body cae a Skeleton infinito. */
  tripDetailError: boolean;
  /** Reintenta la carga del detalle del viaje (refetch de la query). */
  onRetryTripDetail: () => void;
  /** Controlador de la PARADA negociada mid-trip (Lote C3). */
  addStop: WaypointProposalController;
  /**
   * Tipo REAL del viaje (CAR|MOTO, del activeTripStore con fallback CAR): la franja de estado anima la
   * silueta del vehículo PEDIDO — la moto no se anima como auto (misma fuente que el marker del mapa).
   */
  tripVehicleType: NearbyVehicleType;
  // ── Cotización (fase quoting) ──
  requestAgainToken: number;
  onTripCreated: (trip: TripResource) => void;
  /** El viaje PROGRAMADO se creó: cierra el borrador y aterriza en Viajes>Próximos. */
  onScheduled: () => void;
  /**
   * Toggle "Programado" del Home: arranca el flujo de programación INLINE (marca `scheduleIntent`
   * en el borrador + abre la búsqueda de destino). No navega a ninguna lista.
   */
  onStartSchedule: () => void;
  onKycRequired: () => void;
  onDebtPending: () => void;
  onActiveTripExists: (tripId: string) => void;
  onRouteChange: (coordinates: [number, number][]) => void;
  onCancelQuoting: () => void;
  destinationTitle: string | null;
  // ── Puja (searching/offers) ──
  onChooseOffer: (offer: OfferView) => void;
  // ── Viaje activo / cierre ──
  onOpenCamera: () => void;
  /** Abre el chat con el conductor (acción "Mensaje" del sheet — design/veo.pen fLKdk Actions). */
  onOpenChat: () => void;
  /** Abre la pantalla "Comparte tu viaje" (design/veo.pen zKyic) — acción "Compartir" del sheet. */
  onOpenFamilyShare: () => void;
  /** Mensajes del conductor sin leer (badge de la acción "Mensaje"). */
  unreadChatCount: number;
  /** Vuelve al home LIMPIO (cierre canónico del ciclo). */
  clearTrip: () => void;
  /**
   * REINTENTAR un FIJO sin conductor (fase noDriver): limpia el viaje EXPIRED pero CONSERVA el borrador
   * (origen/destino) → la fase vuelve a 'quoting' con el destino intacto (re-confirmar a un tap). A
   * diferencia de `clearTrip`, NO resetea el borrador.
   */
  onRetryRequest: () => void;
  // ── Home idle (franja de deuda + atajos) ──
  hasDebt: boolean;
  debtTotalCents: number;
  hasPendingAction: boolean;
  onOpenDebtFromHome: () => void;
  onOpenPendingFromHome: () => void;
  savedPlaces: SavedPlace[];
  /** Primer nombre del pasajero para el saludo del Home (design/veo.pen SearchSheet). */
  greetingName: string | null;
  onSelectDestination: (place: RoutePlace) => void;
  onSeeAllSaved: () => void;
  onSeeAllRecents: () => void;
  onEnterSearch: () => void;
  /** Elegir el DESTINO arrastrando el mapa (pen P/Home: ícono mapa a la derecha del buscador). */
  onPickOnMap: () => void;
  /** Editar el ORIGEN desde el Home idle: búsqueda con `editing = origin` (igual que la cotización). */
  onEditOrigin: () => void;
  /** Permuta origen ↔ destino del borrador (`rideDraftStore.swap`). */
  onSwapRoute: () => void;
  /** Calle REAL del origen (title del geocoding inverso) para pintar la dirección, no la región. */
  currentLocationTitle: string | undefined;
  /** Destino ya elegido (su etiqueta), para la fila de destino de la tarjeta de ruta del Home. */
  destinationValue: string | undefined;
  /** Conductor del último viaje (tarjeta de confianza del Home). `null` → la tarjeta no se muestra. */
  lastDriver: LastDriver | null;
  // ── Home búsqueda (flow searching) ──
  query: string;
  onQueryChange: (query: string) => void;
  onExitSearch: () => void;
  hasCurrentLocation: boolean;
  currentLocationSubtitle: string | undefined;
  onUseCurrentLocation: () => void;
  suggestions: PlaceSuggestion[];
  searchLoading: boolean;
  searchError: boolean;
  searchActive: boolean;
}

interface SlotProps {
  ctx: RequestFlowContext;
}

/** Slot renderizable del descriptor (Body o Header): un componente que recibe el contexto del contenedor. */
export type PhaseSlot = (props: SlotProps) => React.JSX.Element;

/**
 * Salida INTERINA de una fase (PUENTE, Lote 4 pendiente): `reassign` navega a la pantalla de reasignación
 * y limpia; `clear` (CANCELLED/FAILED) limpia y vuelve al home. `null` = la fase vive en el sheet.
 */
export type PhaseHandoff = 'reassign' | 'clear';

/* ────────────────────────────── Bodies por fase ────────────────────────────── */

/** Fase `quoting`: cotización / "ofrecé tu tarifa" (PUJA) en el mismo sheet. */
export function QuotingPhaseBody({ctx}: SlotProps): React.JSX.Element {
  return (
    <QuotingBody
      onTripCreated={ctx.onTripCreated}
      onScheduled={ctx.onScheduled}
      onKycRequired={ctx.onKycRequired}
      onDebtPending={ctx.onDebtPending}
      onActiveTripExists={ctx.onActiveTripExists}
      onRouteChange={ctx.onRouteChange}
      requestAgainToken={ctx.requestAgainToken}
    />
  );
}

/** Fases `searching`/`offers`: el board de la PUJA (buscando conductores / elegir oferta). */
export function BiddingPhaseBody({ctx}: SlotProps): React.JSX.Element {
  const {board} = ctx;
  return (
    <OffersBody
      tripId={ctx.activeTripId as string}
      offers={board.offers}
      connected={board.connected}
      expired={board.status === tripStatus.enum.EXPIRED}
      // F2 · countdown AUTORITATIVO: vence cuando lo dice el board (epoch ms), no un reloj local.
      expiresAt={board.board?.expiresAt ?? null}
      isLoading={board.isLoading}
      isError={board.isError}
      onRetry={board.refetch}
      onChoose={ctx.onChooseOffer}
      choosing={board.acceptMutation.isPending}
      onCancel={() => board.cancelMutation.mutate()}
      cancelling={board.cancelMutation.isPending}
      actionError={board.actionError}
    />
  );
}

/** Fases `enRoute`/`arrived`/`inProgress`: el viaje VIVO (conductor real, ETA, cámara, cancelar). */
export function ActiveTripPhaseBody({ctx}: SlotProps): React.JSX.Element {
  const {t} = useTranslation();
  if (!ctx.tripDetail) {
    // Sin dato Y con error → banner + reintento (antes: Skeleton infinito). Sin error todavía → carga.
    if (ctx.tripDetailError) {
      return (
        <ErrorState
          message={t('trip.detailLoadError')}
          onRetry={ctx.onRetryTripDetail}
        />
      );
    }
    return <Skeleton variant="rect" height={140} />;
  }
  return (
    <ActiveTripBody
      tripId={ctx.activeTripId as string}
      trip={ctx.tripDetail}
      status={ctx.board.status ?? ctx.tripDetail.status}
      onOpenCamera={ctx.onOpenCamera}
      onOpenChat={ctx.onOpenChat}
      onOpenFamilyShare={ctx.onOpenFamilyShare}
      unreadCount={ctx.unreadChatCount}
      onCancelled={ctx.clearTrip}
      addStop={ctx.addStop}
    />
  );
}

/**
 * Header COLAPSABLE del viaje vivo: la franja de estado (conductor + ETA) es lo ÚNICO que sigue visible
 * cuando el pasajero arrastra el grabber hacia abajo (snap 'header' → mapa al máximo). Es el gesto del
 * conductor, espejado: la info esencial persiste, el detalle (tarjeta/tarifa/acciones) se pliega. Sin
 * `tripDetail` todavía (ventana breve de carga) el header queda vacío; el cuerpo muestra el skeleton.
 */
export function ActiveTripSheetHeader({ctx}: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  // El header va FUERA del scroll padded del sheet → lleva su propio padding (mismo criterio que el header
  // del conductor). El `paddingBottom` da aire a la franja cuando el sheet está COLAPSADO en 'header' (es
  // lo único visible sobre el borde inferior); el `paddingHorizontal` la alinea con las cards del cuerpo.
  const headerPad = {
    paddingHorizontal: theme.spacing.xl,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
  };
  if (!ctx.tripDetail) {
    return <View style={headerPad} />;
  }
  const {etaSeconds} = ctx.live;
  const etaMinutes =
    etaSeconds != null ? formatDurationMinutes(etaSeconds) : null;
  return (
    <View style={headerPad}>
      <TripStatusStrip
        status={ctx.board.status ?? ctx.tripDetail.status}
        driverName={ctx.tripDetail.driver?.name ?? null}
        etaLabel={
          etaMinutes != null
            ? t('trip.etaMinutes', {minutes: etaMinutes})
            : null
        }
        vehicleType={ctx.tripVehicleType}
      />
    </View>
  );
}

/** Fase `completed`: el CIERRE (pago + rating) in-sheet. */
export function CompletionPhaseBody({ctx}: SlotProps): React.JSX.Element {
  const {t} = useTranslation();
  if (!ctx.tripDetail) {
    // El CIERRE (pago/rating) también caía a Skeleton infinito ante error del detalle: banner + reintento.
    if (ctx.tripDetailError) {
      return (
        <ErrorState
          message={t('trip.detailLoadError')}
          onRetry={ctx.onRetryTripDetail}
        />
      );
    }
    return <Skeleton variant="rect" height={140} />;
  }
  return (
    <CompletionBody
      tripId={ctx.activeTripId as string}
      trip={ctx.tripDetail}
      onDone={ctx.clearTrip}
    />
  );
}

/**
 * Fase `noOffers` · PUJA SIN OFERTAS (EXPIRED): in-sheet, sin navegar. Re-pujar reabre el board (la fase
 * vuelve a 'searching' sola); Salir abandona la puja expirada y vuelve al home limpio.
 */
export function NoOffersPhaseBody({ctx}: SlotProps): React.JSX.Element {
  return (
    <NoOffersBody
      tripId={ctx.activeTripId as string}
      onRebid={() => undefined}
      onExit={ctx.clearTrip}
    />
  );
}

/**
 * Fase `noDriver` · FIJO SIN CONDUCTOR (EXPIRED en modo FIXED): in-sheet, sin navegar. Reintentar re-pide
 * el mismo viaje (conserva el borrador → vuelve a 'quoting'); Salir vuelve al home limpio.
 */
export function NoDriverPhaseBody({ctx}: SlotProps): React.JSX.Element {
  return <NoDriverBody onRetry={ctx.onRetryRequest} onExit={ctx.clearTrip} />;
}

/** Home · flow `idle`: franja pasiva de deuda/pago por completar + favoritos y recientes. */
export function HomeIdleFlowBody({ctx}: SlotProps): React.JSX.Element {
  return (
    <>
      {/* Señal PASIVA del home (sin castigo) → abre el DebtSheet. La DEUDA tiene prioridad (warn +
          monto + "Resolver"); si no hay deuda pero sí un PAGO POR COMPLETAR, franja info +
          "Continuar" que abre el checkout directo (resuelve el dead-end del pago a medias). */}
      {ctx.hasDebt ? (
        <EnterView index={5}>
          <DebtStrip
            kind="debt"
            amountCents={ctx.debtTotalCents}
            onPress={ctx.onOpenDebtFromHome}
          />
        </EnterView>
      ) : ctx.hasPendingAction ? (
        <EnterView index={5}>
          <DebtStrip
            kind="pendingAction"
            amountCents={0}
            onPress={ctx.onOpenPendingFromHome}
          />
        </EnterView>
      ) : null}
      {/* Las secciones del cuerpo (favoritos + últimos viajes) cierran la cascada como un solo bloque. */}
      <EnterView index={6}>
        <IdleBody
          savedPlaces={ctx.savedPlaces}
          onSelect={ctx.onSelectDestination}
          onSeeAllSaved={ctx.onSeeAllSaved}
          onSeeAllRecents={ctx.onSeeAllRecents}
        />
      </EnterView>
    </>
  );
}

/**
 * Home · flow `searching` (design/veo.pen P/HomeSearch): chips Casa/Trabajo/Favoritos + encabezado
 * "Sugerencias"/"Ver mapa" + lista de resultados del autocompletado. La fila de ORIGEN y el input de
 * destino viven en el header FIJO (`HomeSearchFlowHeader`), sobre el teclado.
 */
export function HomeSearchFlowBody({ctx}: SlotProps): React.JSX.Element {
  return (
    <SearchingBody
      savedPlaces={ctx.savedPlaces}
      onSelectSaved={p => ctx.onSelectDestination(placeToRoute(p))}
      onOpenSavedPlaces={ctx.onSeeAllSaved}
      onViewMap={ctx.onPickOnMap}
      suggestions={ctx.suggestions}
      loading={ctx.searchLoading}
      error={ctx.searchError}
      active={ctx.searchActive}
      onSelectSuggestion={s => ctx.onSelectDestination(suggestionToRoute(s))}
    />
  );
}

/**
 * Fases que muestran el HOME (idle, y las transitorias reassigning/ended mientras el PUENTE navega):
 * COMPONE explícitamente la segunda máquina (el eje local del sheet) vía `SHEET_FLOW_DESCRIPTORS` —
 * son DOS máquinas (fase global × modo del sheet), no una re-mezcla de booleans.
 */
export function HomePhaseBody({ctx}: SlotProps): React.JSX.Element {
  const FlowBody = SHEET_FLOW_DESCRIPTORS[ctx.flow].Body;
  return <FlowBody ctx={ctx} />;
}

/* ────────────────────────────── Headers por fase ────────────────────────────── */

/** Header de la cotización: volver (limpia el destino → fase idle) + título del destino. */
export function QuotingSheetHeader({ctx}: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  return (
    <View
      style={[
        styles.header,
        {paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm},
      ]}>
      <View style={styles.searchHeader}>
        {/* Back = SOLO el chevron ‹ de iOS, sin círculo/container (regla del dueño, mismo back en
            TODA la app — espeja a ScreenHeader/HeaderBackChevron). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('actions.back')}
          hitSlop={12}
          onPress={ctx.onCancelQuoting}>
          <IconArrowLeft color={theme.colors.ink} size={28} />
        </Pressable>
        <Text variant="bodyStrong" numberOfLines={1} style={styles.searchInput}>
          {ctx.destinationTitle ?? t('home.destination')}
        </Text>
      </View>
    </View>
  );
}

/**
 * Home · flow `idle` (rediseño fiel a la referencia): título HÉROE editorial + tarjeta del ÚLTIMO
 * conductor (solo si hay uno real) + tarjeta de RUTA mejorada (origen REAL editable + swap circular +
 * destino) + chips Casa/Trabajo + teaser INFORMATIVO del catálogo de servicios (sin precio: sin
 * destino no hay cotización). Mucho aire arriba (hero) y contenido denso debajo: la pantalla deja
 * de verse vacía. Cada bloque sale de tokens del tema; nada inventado (la tarjeta del conductor no
 * renderiza si `lastDriver` es `null`).
 */
export function HomeIdleFlowHeader({ctx}: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  // ENTRADA ESCALONADA del Home idle: cada bloque entra con fade + leve subida, en cascada por `index`
  // (~40ms entre bloques, ease-out, <300ms, reduce-motion safe via EnterView). Da "vida" al Home sin
  // pelear con el scroll (solo opacity/transform). Los índices continúan en el body (debt/secciones).
  return (
    // Ritmo vertical del pen (P/Home · HomeContent gap $s-lg): aire entre bloques — el gap 8
    // anterior quedaba apretado (feedback del dueño) y el pen se actualizó a 16.
    <View style={{gap: theme.spacing.lg}}>
      <EnterView index={0}>
        <HomeHero name={ctx.greetingName} />
      </EnterView>
      <EnterView index={1}>
        <ModeToggle
          value={TripTimeMode.Now}
          onChange={mode => {
            if (mode === TripTimeMode.Scheduled) {
              // Programar es el MISMO flujo inmediato + la marca de intención: abre la búsqueda de
              // destino y la cotización llega con el selector de día/hora abierto (no navega a listas).
              ctx.onStartSchedule();
            }
          }}
        />
      </EnterView>
      {ctx.lastDriver ? (
        <EnterView index={1}>
          <LastDriverCard driver={ctx.lastDriver} />
        </EnterView>
      ) : null}
      <EnterView index={2}>
        <SearchField
          leftIcon={<IconSearch color={theme.colors.accent} size={20} />}
          placeholder={t('home.whereTo')}
          value={ctx.destinationValue}
          onPress={ctx.onEnterSearch}
          // Atajo del pen (P/Home · SearchField): mapa a la derecha → elegir el destino ARRASTRANDO
          // el mapa (MapPick), la vía natural cuando el texto no alcanza. Pressable anidado: captura
          // su tap sin robarle el resto del campo a la búsqueda.
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('maps.pickOnMap')}
              hitSlop={8}
              onPress={ctx.onPickOnMap}>
              <IconMap color={theme.colors.inkSubtle} size={20} />
            </Pressable>
          }
        />
      </EnterView>
      <EnterView index={3}>
        <HomeShortcutChips
          savedPlaces={ctx.savedPlaces}
          onSelect={ctx.onSelectDestination}
          onAdd={ctx.onSeeAllSaved}
        />
      </EnterView>
    </View>
  );
}

/**
 * Input de destino EDITABLE del buscador in-sheet (design/veo.pen P/HomeSearch · InputRow · T/SearchInput):
 * píldora con lupa a la izquierda, placeholder "¿A dónde vas?" y borde de foco TEAL (accent). El ui-kit no
 * tiene un search-input editable (SearchField es solo-presión; TextField fuerza label), por eso se arma
 * con tokens del tema.
 */
function DestinationSearchInput({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (query: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        styles.searchInputBox,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: focused ? theme.colors.focus : theme.colors.border,
          borderWidth: focused ? 1.5 : 1,
          borderRadius: theme.radii.lg,
        },
      ]}>
      <IconSearch color={theme.colors.inkSubtle} size={18} />
      <TextInput
        style={[
          styles.searchTextInput,
          {
            color: theme.colors.ink,
            fontFamily: theme.typography.fontFamily.text,
            fontSize: theme.typography.fontSize.base,
          },
        ]}
        placeholder={t('maps.searchPlaceholder')}
        placeholderTextColor={theme.colors.inkSubtle}
        accessibilityLabel={t('maps.searchPlaceholder')}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus
        autoCorrect={false}
        returnKeyType="search"
      />
    </View>
  );
}

/**
 * Home · flow `searching` (design/veo.pen P/HomeSearch · SearchHeader): fila de ORIGEN ("Mi ubicación
 * actual" con dot verde de confianza) arriba del INPUT de destino (editable + botón cerrar). Todo vive en
 * el header FIJO del sheet, así queda SIEMPRE sobre el teclado.
 */
export function HomeSearchFlowHeader({ctx}: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  return (
    <View style={styles.searchStack}>
      {/* ORIGEN = ubicación actual (pen OriginRow): dot verde (success/jade, único verde del tema —
          el .pen usa #00C853 pero el passenger canoniza el positivo en jade) + etiqueta. Tocarlo abre
          la edición del origen (misma vía que la cotización). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('maps.originCurrent')}
        onPress={ctx.onEditOrigin}
        style={[
          styles.originRow,
          {
            backgroundColor: theme.colors.bg,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
          },
        ]}>
        <View
          style={[styles.originDot, {backgroundColor: theme.colors.success}]}
        />
        <Text
          variant="subhead"
          color="ink"
          numberOfLines={1}
          style={styles.searchInput}>
          {ctx.currentLocationTitle ?? t('maps.originCurrent')}
        </Text>
      </Pressable>
      {/* DESTINO = input de búsqueda editable + cerrar (pen InputRow). */}
      <View style={styles.searchHeader}>
        <View style={styles.searchInput}>
          <DestinationSearchInput
            value={ctx.query}
            onChangeText={ctx.onQueryChange}
          />
        </View>
        <IconButton
          accessibilityLabel={t('actions.close')}
          onPress={ctx.onExitSearch}
          variant="surface"
          icon={<IconClose color={theme.colors.inkMuted} size={20} />}
        />
      </View>
    </View>
  );
}

/** Header del HOME: compone la segunda máquina (idle ↔ searching) dentro del wrapper fijo del sheet. */
export function HomeSheetHeader({ctx}: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const FlowHeader = SHEET_FLOW_DESCRIPTORS[ctx.flow].Header;
  return (
    <View
      style={[
        styles.header,
        {paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm},
      ]}>
      <FlowHeader ctx={ctx} />
    </View>
  );
}

/* ──────────────────────── Descriptor de la 2ª máquina (sheet) ──────────────────────── */

/** Descriptor del eje LOCAL del sheet en el home: qué body/header muestra y si el pin de recojo aplica. */
export interface SheetFlowDescriptor {
  Body: PhaseSlot;
  Header: PhaseSlot;
  /**
   * MODELO CABIFY: el pin FIJO de recojo solo aplica con el sheet en reposo (no buscando) — buscando, el
   * mapa queda detrás del sheet expandido y el pin no tiene sentido.
   */
  allowsPickupPin: boolean;
}

export const SHEET_FLOW_DESCRIPTORS: Record<
  SheetFlowState,
  SheetFlowDescriptor
> = {
  idle: {
    Body: HomeIdleFlowBody,
    Header: HomeIdleFlowHeader,
    allowsPickupPin: true,
  },
  searching: {
    Body: HomeSearchFlowBody,
    Header: HomeSearchFlowHeader,
    allowsPickupPin: false,
  },
};

/* ──────────────────────── Descriptor por fase (patrón State) ──────────────────────── */

/**
 * Descriptor de FASE: TODO lo que el contenedor decide "según la fase" vive acá, POR FASE y exhaustivo
 * (`Record<TripPhase, …>` — agregar una fase sin describirla no compila). Antes estas preguntas estaban
 * desparramadas en ~10 comparaciones del screen (cadena ternaria del body + booleans sueltos).
 */
export interface PhaseDescriptor {
  /** Cuerpo SCROLLABLE del sheet para la fase. */
  Body: PhaseSlot;
  /**
   * Header FIJO del sheet. WHITELIST: solo el HOME (buscador + chips) y la COTIZACIÓN (volver + destino)
   * tienen chrome; cualquier otra fase trae su cuerpo autocontenido y NO debe mostrar el chrome del home
   * encima (era el leak del buscador filtrándose sobre el CompletionBody y el NoOffersBody).
   */
  Header: PhaseSlot | null;
  /**
   * Snap por fase: la COTIZACIÓN y el CIERRE (pago/rating) van a full (forms largos con confirmar).
   * El resto va a PEEK content-hug: el sheet ABRAZA su contenido → el mapa SIEMPRE queda visible arriba
   * (regla del dueño: la altura del sheet es DINÁMICA según el contenido, no pantalla completa).
   */
  expanded: boolean;
  /**
   * AMBIENTE: autitos cercanos anónimos alrededor del pasajero. En idle (home), searching (buscando
   * conductores) Y completed (vuelve el ambiente al cerrar el ciclo); en cotización y viaje activo el
   * mapa tiene su propio foco (el único auto es el asignado).
   */
  showNearby: boolean;
  /** Viaje VIVO con conductor (enRoute/arrived/inProgress): chrome SOS/chat, pánico armado, fit del mapa. */
  activeTrip: boolean;
  /** La fase necesita el detalle del viaje (conductor/vehículo/tarifa): viaje activo + cierre. */
  needsTripDetail: boolean;
  /** El pin de recojo (modelo Cabify) puede activarse: SOLO el home idle (se compone con el flow local). */
  pickupEligible: boolean;
  /** DEUDA · señal PASIVA: consultar deudas SOLO en el home idle (no golpear el endpoint en cada fase). */
  pollsDebts: boolean;
  /** Pre-prompt CONTEXTUAL de push: al estar BUSCANDO conductor (ahí el push importa), no al entrar. */
  showsPushPrePrompt: boolean;
  /**
   * En el mapa de viaje (modo `trip`), ¿se muestra el marker de ORIGEN? En curso es ruido (ya pasamos por
   * la recogida); en pre-pickup SÍ ayuda. Irrelevante fuera del modo `trip` (se declara igual: exhaustivo).
   */
  tripMapShowsOrigin: boolean;
  /** PUENTE INTERINO (Lote 4 pendiente): SOLO la reasignación navega; ended limpia y vuelve al home. */
  handoff: PhaseHandoff | null;
}

export const TRIP_PHASE_DESCRIPTORS: Record<TripPhase, PhaseDescriptor> = {
  idle: {
    Body: HomePhaseBody,
    Header: HomeSheetHeader,
    expanded: false,
    showNearby: true,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: true,
    pollsDebts: true,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  quoting: {
    Body: QuotingPhaseBody,
    Header: QuotingSheetHeader,
    expanded: true,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  searching: {
    Body: BiddingPhaseBody,
    Header: null,
    expanded: false,
    showNearby: true,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: true,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  offers: {
    Body: BiddingPhaseBody,
    Header: null,
    // ADR-020 Lote 3: al llegar ≥1 oferta (fase searching→offers) el sheet CRECE solo a full para que el
    // pasajero VEA la lista y pueda elegir (antes quedaba en peek 50% → 1-2 cards sobre el fold, sin
    // affordance de arrastrar → "no veo las ofertas / cómo elijo"). searching sigue en peek (solo el
    // countdown); el salto expanded false→true al aparecer la 1ra oferta dispara el snapToIndex(FULL).
    expanded: true,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  noOffers: {
    Body: NoOffersPhaseBody,
    Header: null,
    // La PUJA sin ofertas (re-pujar) trae el stepper + mínimo + hints + nota de peajes: NO entra en el
    // peek (content-hug capado a 0.5) y se cortaba. `expanded` → snap a FULL (content-hug 0.94) → el
    // sheet crece al alto de su contenido (max/min) y se ve completo.
    expanded: true,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  // FIJO sin conductor (EXPIRED en modo FIXED): mensaje honesto + Reintentar/Salir. `expanded` para que el
  // sheet crezca a su contenido (mismo criterio que noOffers). Terminal: sin viaje vivo, sin socket.
  noDriver: {
    Body: NoDriverPhaseBody,
    Header: null,
    expanded: true,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  // Transitoria: el PUENTE navega a Reassign y limpia; mientras tanto el sheet muestra el home.
  reassigning: {
    Body: HomePhaseBody,
    Header: null,
    expanded: false,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: 'reassign',
  },
  enRoute: {
    Body: ActiveTripPhaseBody,
    Header: ActiveTripSheetHeader,
    expanded: false,
    showNearby: false,
    activeTrip: true,
    needsTripDetail: true,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  arrived: {
    Body: ActiveTripPhaseBody,
    Header: ActiveTripSheetHeader,
    expanded: false,
    showNearby: false,
    activeTrip: true,
    needsTripDetail: true,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  inProgress: {
    Body: ActiveTripPhaseBody,
    Header: ActiveTripSheetHeader,
    expanded: false,
    showNearby: false,
    activeTrip: true,
    needsTripDetail: true,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    // En viaje en curso el marker de origen es ruido (ya pasamos por la recogida).
    tripMapShowsOrigin: false,
    handoff: null,
  },
  completed: {
    Body: CompletionPhaseBody,
    Header: null,
    expanded: true,
    showNearby: true,
    activeTrip: false,
    needsTripDetail: true,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: null,
  },
  // Terminal (CANCELLED/FAILED): el PUENTE limpia y vuelve al home; mientras tanto el sheet muestra el home.
  ended: {
    Body: HomePhaseBody,
    Header: null,
    expanded: false,
    showNearby: false,
    activeTrip: false,
    needsTripDetail: false,
    pickupEligible: false,
    pollsDebts: false,
    showsPushPrePrompt: false,
    tripMapShowsOrigin: true,
    handoff: 'clear',
  },
};

/**
 * `pickupMode` = Home idle (no buscando, no en cotización/viaje). COMPOSICIÓN EXPLÍCITA de las dos
 * máquinas (fase global × modo local del sheet): cada eje aporta su mitad desde SU descriptor.
 */
export function resolvePickupMode(
  phase: TripPhase,
  flow: SheetFlowState,
): boolean {
  return (
    TRIP_PHASE_DESCRIPTORS[phase].pickupEligible &&
    SHEET_FLOW_DESCRIPTORS[flow].allowsPickupPin
  );
}

const styles = StyleSheet.create({
  // Header FIJO del sheet (no scrollea): buscador + chips Casa/Trabajo (home) o volver + destino (quoting).
  header: {paddingBottom: 8},
  // Stack del header de búsqueda: fila de ORIGEN sobre la fila del INPUT (pen SearchHeader · gap 8).
  searchStack: {gap: 8},
  // Fila input + cerrar (búsqueda) o volver + destino (cotización), fija. Centrada verticalmente.
  searchHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
  searchInput: {flex: 1},
  // Fila de ORIGEN (pen OriginRow): dot verde + etiqueta, píldora con borde.
  originRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  originDot: {width: 10, height: 10, borderRadius: 999},
  // Input de destino EDITABLE (pen InputRow · T/SearchInput): lupa + campo, borde de foco.
  searchInputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  searchTextInput: {flex: 1, paddingVertical: 12},
});
