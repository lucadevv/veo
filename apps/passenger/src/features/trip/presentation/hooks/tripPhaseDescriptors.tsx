import type {
  GeoPoint,
  OfferView,
  PlaceSuggestion,
  TripActiveView,
  TripResource,
} from '@veo/api-client';
import { tripStatus } from '@veo/api-client';
import { IconButton, SearchField, Skeleton, Text, TextField, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import type { RoutePlace } from '../../../maps/domain/entities';
import type { SavedPlace } from '../../../places/domain/entities';
import { ActiveTripBody } from '../components/ActiveTripBody';
import { CompletionBody } from '../components/CompletionBody';
import { DebtStrip } from '../components/DebtStrip';
import { HomeShortcutChips } from '../components/HomeShortcutChips';
import { IconArrowLeft, IconClose, IconSearch } from '../components/icons';
import { IdleBody } from '../components/IdleBody';
import { NoOffersBody } from '../components/NoOffersBody';
import { OffersBody } from '../components/OffersBody';
import { QuotingBody } from '../components/QuotingBody';
import { placeToRoute, suggestionToRoute } from '../components/routePlace';
import { SearchingBody } from '../components/SearchingBody';
import type { OfferBoard } from './useOfferBoard';
import type { UsePassengerTripSocket } from './usePassengerTripSocket';
import type { WaypointProposalController } from './useWaypointProposal';
import type { TripPhase } from './tripFlowPhase';

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
  /** Controlador de la PARADA negociada mid-trip (Lote C3). */
  addStop: WaypointProposalController;
  // ── Cotización (fase quoting) ──
  kycStatus: string | null;
  requestAgainToken: number;
  onTripCreated: (trip: TripResource) => void;
  onScheduled: () => void;
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
  /** Vuelve al home LIMPIO (cierre canónico del ciclo). */
  clearTrip: () => void;
  // ── Home idle (franja de deuda + atajos) ──
  hasDebt: boolean;
  debtTotalCents: number;
  hasPendingAction: boolean;
  onOpenDebtFromHome: () => void;
  onOpenPendingFromHome: () => void;
  savedPlaces: SavedPlace[];
  recents: GeoPoint[];
  onSelectDestination: (place: RoutePlace) => void;
  onSeeAllSaved: () => void;
  onSeeAllRecents: () => void;
  onEnterSearch: () => void;
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
export function QuotingPhaseBody({ ctx }: SlotProps): React.JSX.Element {
  return (
    <QuotingBody
      onTripCreated={ctx.onTripCreated}
      onScheduled={ctx.onScheduled}
      onKycRequired={ctx.onKycRequired}
      onDebtPending={ctx.onDebtPending}
      onActiveTripExists={ctx.onActiveTripExists}
      onRouteChange={ctx.onRouteChange}
      requestAgainToken={ctx.requestAgainToken}
      kycStatus={ctx.kycStatus}
    />
  );
}

/** Fases `searching`/`offers`: el board de la PUJA (buscando conductores / elegir oferta). */
export function BiddingPhaseBody({ ctx }: SlotProps): React.JSX.Element {
  const { board } = ctx;
  return (
    <OffersBody
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
export function ActiveTripPhaseBody({ ctx }: SlotProps): React.JSX.Element {
  if (!ctx.tripDetail) {
    return <Skeleton variant="rect" height={140} />;
  }
  return (
    <ActiveTripBody
      tripId={ctx.activeTripId as string}
      trip={ctx.tripDetail}
      status={ctx.board.status ?? ctx.tripDetail.status}
      etaSeconds={ctx.live.etaSeconds}
      onOpenCamera={ctx.onOpenCamera}
      onCancelled={ctx.clearTrip}
      addStop={ctx.addStop}
    />
  );
}

/** Fase `completed`: el CIERRE (pago + rating) in-sheet. */
export function CompletionPhaseBody({ ctx }: SlotProps): React.JSX.Element {
  if (!ctx.tripDetail) {
    return <Skeleton variant="rect" height={140} />;
  }
  return <CompletionBody tripId={ctx.activeTripId as string} trip={ctx.tripDetail} onDone={ctx.clearTrip} />;
}

/**
 * Fase `noOffers` · PUJA SIN OFERTAS (EXPIRED): in-sheet, sin navegar. Re-pujar reabre el board (la fase
 * vuelve a 'searching' sola); Salir abandona la puja expirada y vuelve al home limpio.
 */
export function NoOffersPhaseBody({ ctx }: SlotProps): React.JSX.Element {
  return <NoOffersBody tripId={ctx.activeTripId as string} onRebid={() => undefined} onExit={ctx.clearTrip} />;
}

/** Home · flow `idle`: franja pasiva de deuda/pago por completar + favoritos y recientes. */
export function HomeIdleFlowBody({ ctx }: SlotProps): React.JSX.Element {
  return (
    <>
      {/* Señal PASIVA del home (sin castigo) → abre el DebtSheet. La DEUDA tiene prioridad (warn +
          monto + "Resolver"); si no hay deuda pero sí un PAGO POR COMPLETAR, franja info +
          "Continuar" que abre el checkout directo (resuelve el dead-end del pago a medias). */}
      {ctx.hasDebt ? (
        <DebtStrip kind="debt" amountCents={ctx.debtTotalCents} onPress={ctx.onOpenDebtFromHome} />
      ) : ctx.hasPendingAction ? (
        <DebtStrip kind="pendingAction" amountCents={0} onPress={ctx.onOpenPendingFromHome} />
      ) : null}
      <IdleBody
        savedPlaces={ctx.savedPlaces}
        recents={ctx.recents}
        onSelect={ctx.onSelectDestination}
        onSeeAllSaved={ctx.onSeeAllSaved}
        onSeeAllRecents={ctx.onSeeAllRecents}
      />
    </>
  );
}

/** Home · flow `searching`: "usar mi ubicación" + guardados + sugerencias del autocompletado. */
export function HomeSearchFlowBody({ ctx }: SlotProps): React.JSX.Element {
  return (
    <SearchingBody
      showCurrentLocation={ctx.hasCurrentLocation && !ctx.searchActive}
      currentLocationSubtitle={ctx.currentLocationSubtitle}
      onUseCurrentLocation={ctx.onUseCurrentLocation}
      suggestions={ctx.suggestions}
      loading={ctx.searchLoading}
      error={ctx.searchError}
      active={ctx.searchActive}
      onSelectSuggestion={(s) => ctx.onSelectDestination(suggestionToRoute(s))}
      onSelectSaved={(p) => ctx.onSelectDestination(placeToRoute(p))}
    />
  );
}

/**
 * Fases que muestran el HOME (idle, y las transitorias reassigning/ended mientras el PUENTE navega):
 * COMPONE explícitamente la segunda máquina (el eje local del sheet) vía `SHEET_FLOW_DESCRIPTORS` —
 * son DOS máquinas (fase global × modo del sheet), no una re-mezcla de booleans.
 */
export function HomePhaseBody({ ctx }: SlotProps): React.JSX.Element {
  const FlowBody = SHEET_FLOW_DESCRIPTORS[ctx.flow].Body;
  return <FlowBody ctx={ctx} />;
}

/* ────────────────────────────── Headers por fase ────────────────────────────── */

/** Header de la cotización: volver (limpia el destino → fase idle) + título del destino. */
export function QuotingSheetHeader({ ctx }: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm }]}>
      <View style={styles.searchHeader}>
        <IconButton
          accessibilityLabel={t('actions.back')}
          variant="surface"
          onPress={ctx.onCancelQuoting}
          icon={<IconArrowLeft color={theme.colors.ink} size={22} />}
        />
        <Text variant="bodyStrong" numberOfLines={1} style={styles.searchInput}>
          {ctx.destinationTitle ?? t('home.destination')}
        </Text>
      </View>
    </View>
  );
}

/** Home · flow `idle`: buscador "¿A dónde vamos?" (tap → expande a búsqueda) + chips Casa/Trabajo. */
export function HomeIdleFlowHeader({ ctx }: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <>
      <SearchField
        placeholder={t('home.whereTo')}
        onPress={ctx.onEnterSearch}
        leftIcon={<IconSearch color={theme.colors.accent} size={20} />}
      />
      <HomeShortcutChips
        savedPlaces={ctx.savedPlaces}
        onSelect={ctx.onSelectDestination}
        onAdd={ctx.onSeeAllSaved}
      />
    </>
  );
}

/** Home · flow `searching`: input con autofocus + cerrar (la búsqueda vive DENTRO del mismo sheet). */
export function HomeSearchFlowHeader({ ctx }: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.searchHeader}>
      <View style={styles.searchInput}>
        <TextField
          label={t('home.destination')}
          placeholder={t('maps.inputPlaceholder')}
          value={ctx.query}
          onChangeText={ctx.onQueryChange}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      <IconButton
        accessibilityLabel={t('actions.close')}
        onPress={ctx.onExitSearch}
        variant="surface"
        icon={<IconClose color={theme.colors.inkMuted} size={20} />}
      />
    </View>
  );
}

/** Header del HOME: compone la segunda máquina (idle ↔ searching) dentro del wrapper fijo del sheet. */
export function HomeSheetHeader({ ctx }: SlotProps): React.JSX.Element {
  const theme = useTheme();
  const FlowHeader = SHEET_FLOW_DESCRIPTORS[ctx.flow].Header;
  return (
    <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm }]}>
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

export const SHEET_FLOW_DESCRIPTORS: Record<SheetFlowState, SheetFlowDescriptor> = {
  idle: { Body: HomeIdleFlowBody, Header: HomeIdleFlowHeader, allowsPickupPin: true },
  searching: { Body: HomeSearchFlowBody, Header: HomeSearchFlowHeader, allowsPickupPin: false },
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
    expanded: false,
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
    expanded: false,
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
    Header: null,
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
    Header: null,
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
    Header: null,
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
export function resolvePickupMode(phase: TripPhase, flow: SheetFlowState): boolean {
  return TRIP_PHASE_DESCRIPTORS[phase].pickupEligible && SHEET_FLOW_DESCRIPTORS[flow].allowsPickupPin;
}

const styles = StyleSheet.create({
  // Header FIJO del sheet (no scrollea): buscador + chips Casa/Trabajo (home) o volver + destino (quoting).
  header: { paddingBottom: 8 },
  // Header del modo búsqueda (input + cerrar), también fijo. Mismo layout para el header de cotización.
  searchHeader: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  searchInput: { flex: 1 },
});
