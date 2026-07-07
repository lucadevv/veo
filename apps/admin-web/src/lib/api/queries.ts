'use client';

import { z } from 'zod';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import { FILTER_ALL } from '@/lib/filters';
import {
  analyticsOverview,
  auditChainVerification,
  auditEntryView,
  type CreateDocumentRequest,
  type CreateInspectionRequest,
  type CreateVehicleRequest,
  dispatchRadiusConfigView,
  type ReplaceRadiusConfigRequest,
  driverApproval,
  driverDetail,
  dniFaceMatchResult,
  expiringDocumentView,
  fleetDocumentView,
  inspectionView,
  vehicleModelReviewView,
  vehicleModelSpecView,
  type ApproveVehicleModelRequest,
  type LiveAccessRequest,
  liveViewerToken,
  mediaAccessRequestView,
  catalogView,
  modeScheduleView,
  fuelSurchargeView,
  baseFareView,
  commissionView,
  costPerKmConfigView,
  costPerKmListView,
  energyCatalogView,
  bidFloorView,
  refundablePaymentView,
  payoutDetailView,
  payoutStatsView,
  reconciliationRunView,
  type ReplaceBaseFareRequest,
  type ReplaceCommissionRequest,
  type ReplaceCostPerKmRequest,
  type ReplaceBidFloorRequest,
  operator,
  type CreateOperatorRequest,
  createOperatorResult,
  reinviteOperatorResult,
  paginated,
  pendingDriver,
  driverCounts,
  reviewQueueSummary,
  panicDetail,
  type ReplaceCatalogRequest,
  type ReplaceScheduleRequest,
  type ReplaceFuelSurchargeRequest,
  type ReplaceEnergyCatalogRequest,
  panicSummary,
  payoutView,
  runPayoutsResult,
  payoutDisburseResult,
  signedMedia,
  tripDetail,
  tripSummary,
  vehicleView,
  type TripStatus,
} from './schemas';

/** Llaves de caché centralizadas para invalidaciones consistentes. */
export const qk = {
  overview: ['overview'] as const,
  trips: (f: TripFilters) => ['trips', f] as const,
  trip: (id: string) => ['trip', id] as const,
  drivers: (status: string) => ['drivers', status] as const,
  driver: (id: string) => ['driver', id] as const,
  driversPending: ['drivers-pending'] as const,
  driversSummary: ['drivers-summary'] as const,
  reviewsSummary: ['reviews-summary'] as const,
  operators: ['operators'] as const,
  panics: (status: string) => ['panics', status] as const,
  panic: (id: string) => ['panic', id] as const,
  vehicles: ['vehicles'] as const,
  vehicle: (id: string) => ['vehicle', id] as const,
  inspections: ['inspections'] as const,
  expiring: ['fleet-expiring'] as const,
  documents: (status: string) => ['fleet-documents', status] as const,
  modelReview: (status: string) => ['vehicle-model-review', status] as const,
  vehicleModels: ['vehicle-models'] as const,
  payouts: (status: string) => ['payouts', status] as const,
  payoutStats: ['payout-stats'] as const,
  paymentByTrip: (tripId: string) => ['payment-by-trip', tripId] as const,
  payoutDetail: (id: string) => ['payout-detail', id] as const,
  reconciliation: ['reconciliation'] as const,
  media: (status: string) => ['media-requests', status] as const,
  audit: ['audit'] as const,
  modeSchedule: ['mode-schedule'] as const,
  fuelSurcharge: ['fuel-surcharge'] as const,
  baseFare: ['base-fare'] as const,
  commission: ['commission'] as const,
  costPerKm: ['cost-per-km'] as const,
  energyCatalog: ['energy-catalog'] as const,
  bidFloor: ['bid-floor'] as const,
  catalog: ['catalog'] as const,
  dispatchRadiusConfig: ['dispatch-radius-config'] as const,
};

const REALTIME_REFETCH = 15_000;

export interface TripFilters {
  status?: TripStatus | 'ALL';
  query?: string;
}

function cleanQuery(params: Record<string, string | number | undefined>) {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== FILTER_ALL) out[k] = v;
  }
  return out;
}

/* ── Overview / KPIs ── */
export function useOverview() {
  return useQuery({
    queryKey: qk.overview,
    queryFn: ({ signal }) =>
      apiClient().get('/analytics/overview', { schema: analyticsOverview, signal }),
    refetchInterval: REALTIME_REFETCH,
  });
}

/* ── Viajes (paginación cursor) ── */
const tripPage = paginated(tripSummary);

export function useTrips(filters: TripFilters) {
  return useInfiniteQuery({
    queryKey: qk.trips(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/ops/trips', {
        schema: tripPage,
        signal,
        query: cleanQuery({
          status: filters.status,
          q: filters.query,
          cursor: pageParam,
          limit: 50,
        }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useTrip(id: string) {
  return useQuery({
    queryKey: qk.trip(id),
    queryFn: ({ signal }) => apiClient().get(`/ops/trips/${id}`, { schema: tripDetail, signal }),
    enabled: id.length > 0,
  });
}

/* ── Conductores ── */
const driverPage = paginated(driverApproval);

export function useDrivers(status: string) {
  return useInfiniteQuery({
    queryKey: qk.drivers(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/ops/drivers', {
        schema: driverPage,
        signal,
        query: cleanQuery({ status, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Detalle de revisión de un conductor (GET /ops/drivers/:id): core + biométrico + documentos con URLs
 * presigned (TTL 120s). Mismo patrón que useTrip: cliente autenticado (el JWT lo adjunta el proxy
 * server-side), schema del contrato (driverDetail de @veo/api-client). `refetch()` renueva las
 * presigned URLs vencidas — el visor lo expone como botón "Recargar". Ruta gateada a Compliance+ por el bff.
 */
export function useDriverDetail(id: string) {
  return useQuery({
    queryKey: qk.driver(id),
    queryFn: ({ signal }) =>
      apiClient().get(`/ops/drivers/${id}`, { schema: driverDetail, signal }),
    enabled: id.length > 0,
  });
}

/**
 * Sub-lote 3C · dispara el FACE-MATCH DNI↔selfie (POST /ops/drivers/:id/dni-face-match). El admin-bff baja
 * la foto FRONT del DNI de S3, la cotea con la biometría enrolada del conductor (en identity, con el
 * embedding GUARDADO — server-truth) y GUARDA el resultado. El éxito invalida el detalle del conductor para
 * que la ficha refleje el binding recién guardado (Coincide ✓ / No coincide ✗ + score). El backend devuelve
 * 409 (ConflictError) si no hay biometría enrolada o si falta la foto FRONT del DNI — el ApiError viaja con
 * `status`/`message` para que el llamador muestre el mensaje del server.
 */
export function useDniFaceMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/dni-face-match`, { schema: dniFaceMatchResult }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/**
 * Lote C · dispara el FACE-MATCH licencia↔selfie (POST /ops/drivers/:id/license-face-match). Gemelo del DNI:
 * el admin-bff baja la foto del brevete (LICENSE_A1) de S3 y la cotea con la biometría enrolada (server-truth).
 * El éxito invalida el detalle para reflejar el binding del brevete. Mismos 409 honestos (sin biometría / sin
 * foto del brevete). El resultado comparte forma con el DNI (`dniFaceMatchResult`: matched/score/reason).
 */
export function useLicenseFaceMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/license-face-match`, {
        schema: dniFaceMatchResult,
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/**
 * F3 · destrabe biométrico por la CENTRAL (POST /ops/drivers/:id/biometric/unlock). Limpia el lockout del gate
 * de turno (3 fallos/1h) + el cooldown de abuso del enrol. Idempotente (204 sin body): el operador lo dispara
 * cuando un conductor reporta estar bloqueado. El éxito invalida el detalle del conductor.
 */
export function useUnlockBiometric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/biometric/unlock`),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

export function useDriverDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      // Sin schema: la respuesta del approve (id+estado) no se renderiza; el éxito refetchea la lista.
      // Aprobar/rechazar devuelven formas distintas (200 {id,backgroundCheckStatus} / 204 vacío); no parseamos.
      apiClient().post(`/ops/drivers/${input.id}/${input.decision}`, {
        body: input.reason ? { reason: input.reason } : undefined,
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: qk.driversPending });
      // El detalle de revisión refleja el nuevo estado de antecedentes tras aprobar/rechazar.
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/**
 * Suspensión MANUAL de un conductor (SAFETY). El motivo es OBLIGATORIO: viaja al admin-bff, que lo
 * proxya a identity-service (escribe suspendedAt + emite driver.suspended) y lo audita. Respuesta 204
 * vacía (no se parsea). El éxito refetchea la lista para reflejar el estado SUSPENDED.
 */
export function useDriverSuspend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/suspend`, { body: { reason: input.reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
    },
  });
}

/**
 * REACTIVACIÓN MANUAL de un conductor suspendido (la inversa de useDriverSuspend, SAFETY). SIN body: el
 * admin-bff proxya a identity-service, que quita SOLO el hold DISCIPLINARY y recomputa el `suspendedAt`
 * derivado (modelo de HOLDS), luego emite driver.reactivated. Respuesta 204 vacía (no se parsea). El éxito
 * refetchea la lista (y el detalle del conductor) para reflejar el estado ACTIVE.
 *
 * FAIL-CLOSED: el backend devuelve 403 (ForbiddenError) si la suspensión era por documentos/ITV vencidos (se
 * levanta por el override de compliance, no a mano) o si la licencia está vencida, y 409 (ConflictError) si el
 * conductor no estaba suspendido. El ApiError viaja con `status`/`message` (igual que useDeleteDriver) para que
 * el ConfirmDialog/llamador muestre el mensaje del server en vez del crudo.
 */
export function useReactivateDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/reactivate`),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/**
 * OVERRIDE DE COMPLIANCE: levanta una suspensión por DOCUMENTOS/ITV vencidos (causas DOCUMENT_EXPIRED /
 * INSPECTION_EXPIRED del modelo de holds). Esa suspensión normalmente se reactiva SOLA cuando el conductor
 * regulariza (ITV vigente nueva / documento válido); este endpoint es el override MANUAL del operador para
 * forzar el levantamiento. Exige step-up MFA fresco: el llamador lo verifica con StepUpDialog ANTES de
 * invocar, y el admin-bff revalida @Roles + @RequireStepUpMfa server-side (la UI no autoriza). SIN body,
 * 204 vacío. FAIL-CLOSED: 403 si la suspensión NO era por documentos/ITV (una disciplinaria se levanta con
 * useReactivateDriver), 409 si no estaba suspendido. Quita SOLO los holds de documento/ITV; si además había
 * una suspensión disciplinaria, esa queda (el conductor sigue suspendido hasta levantarla por su vía).
 */
export function useReactivateDriverForCompliance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/drivers/${input.id}/reactivate-compliance`),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/**
 * Borrado en CASCADA de un conductor (DELETE /ops/drivers/:id) — IRREVERSIBLE: elimina al conductor, su
 * usuario, documentos y archivos. SOLO SUPERADMIN + step-up MFA fresca (el admin-bff revalida @Roles +
 * @RequireStepUpMfa server-side; la UI solo refleja con `drivers:delete`). Respuesta 204 vacía (no se
 * parsea). El éxito invalida los listados de drivers; el redirect a /ops/drivers lo hace el llamador.
 * El backend devuelve 409 (ConflictError, BR-S06) si el conductor tiene historial operativo, y 403 si el
 * rol no es SUPERADMIN o la MFA no está fresca — el ApiError viaja con `status`/`message` para que el
 * ConfirmDialog/llamador muestre el mensaje amigable del server en vez del crudo.
 */
export function useDeleteDriver() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) => apiClient().delete(`/ops/drivers/${input.id}`),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: qk.driversPending });
      void qc.removeQueries({ queryKey: qk.driver(input.id) });
    },
  });
}

/** Cola REAL de conductores pendientes de aprobación de antecedentes (identity pending-approval, NO el read-model). */
export function useDriversPending() {
  return useQuery({
    queryKey: qk.driversPending,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/drivers/pending', { schema: z.array(pendingDriver), signal }),
  });
}

/** Conteo de conductores por estado de antecedentes (pending/cleared/rejected) para los stat cards del panel. */
export function useDriversSummary() {
  return useQuery({
    queryKey: qk.driversSummary,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/drivers/summary', { schema: driverCounts, signal }),
  });
}

/** Conteo de las colas de revisión (conductores + docs + modelos) para los stat cards de la cola unificada. */
export function useReviewsSummary() {
  return useQuery({
    queryKey: qk.reviewsSummary,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/reviews/summary', { schema: reviewQueueSummary, signal }),
  });
}

/* ── Operadores del panel (alta por invitación · solo ADMIN/SUPERADMIN) ── */
const operatorList = z.array(operator);

/** Lista TODOS los operadores del panel (INVITED/ACTIVE/SUSPENDED/REJECTED). */
export function useOperators() {
  return useQuery({
    queryKey: qk.operators,
    queryFn: ({ signal }) => apiClient().get('/ops/operators', { schema: operatorList, signal }),
  });
}

/**
 * Crea un operador por invitación (email + roles RBAC) → INVITED + link de invitación. El admin-bff
 * marca el endpoint con @RequireStepUpMfa: el llamador (NewOperatorDialog) verifica TOTP fresco ANTES
 * de invocar esta mutación (mismo patrón que LiveAccessDialog). El servidor revalida @Roles + step-up +
 * anti-escalada (`canGrantRoles`) — la UI solo refleja, nunca autoriza.
 */
export function useCreateOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOperatorRequest) =>
      apiClient().post('/ops/operators', { body: input, schema: createOperatorResult }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.operators });
    },
  });
}

/**
 * Re-emite la invitación de un operador aún INVITED (nuevo link + vencimiento). Exige step-up MFA fresco
 * (el llamador verifica TOTP antes de invocar). El servidor revalida @Roles + step-up.
 */
export function useReinviteOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/operators/${input.id}/reinvite`, { schema: reinviteOperatorResult }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.operators });
    },
  });
}

/**
 * Cancela una invitación (INVITED) o revoca/suspende un operador (ACTIVE). Respuesta 204 vacía (no se
 * parsea). El éxito refetchea la lista. El admin-bff revalida @Roles(ADMIN, SUPERADMIN) server-side.
 */
export function useRejectOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/operators/${input.id}/reject`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.operators });
    },
  });
}

/* ── Pánicos ── */
const panicPage = paginated(panicSummary);

export function usePanics(status: string) {
  return useQuery({
    queryKey: qk.panics(status),
    queryFn: ({ signal }) =>
      apiClient().get('/security/panics', {
        schema: panicPage,
        signal,
        query: cleanQuery({ status }),
      }),
    refetchInterval: REALTIME_REFETCH,
  });
}

export function usePanic(id: string) {
  return useQuery({
    queryKey: qk.panic(id),
    queryFn: ({ signal }) =>
      apiClient().get(`/security/panics/${id}`, { schema: panicDetail, signal }),
    enabled: id.length > 0,
  });
}

export function usePanicAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'ack' | 'resolve'; notes?: string }) =>
      apiClient().post(`/security/panics/${input.id}/${input.action}`, {
        body: input.notes ? { notes: input.notes } : undefined,
        schema: panicDetail,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: qk.panic(data.id) });
      void qc.invalidateQueries({ queryKey: ['panics'] });
    },
  });
}

/* ── Flota ── */
const documentPage = paginated(fleetDocumentView);

const vehiclePage = paginated(vehicleView);
const inspectionPage = paginated(inspectionView);

export function useFleetDocuments(status: string) {
  return useInfiniteQuery({
    queryKey: qk.documents(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/fleet/documents', {
        schema: documentPage,
        signal,
        query: cleanQuery({ status, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useVehicles() {
  return useInfiniteQuery({
    queryKey: qk.vehicles,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/fleet/vehicles', {
        schema: vehiclePage,
        signal,
        query: cleanQuery({ cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Detalle de UN vehículo, ENRIQUECIDO con la ficha del modelSpec (misma forma que la fila de la lista). */
export function useVehicle(id: string) {
  return useQuery({
    queryKey: qk.vehicle(id),
    enabled: id.length > 0,
    queryFn: ({ signal }) =>
      apiClient().get(`/fleet/vehicles/${id}`, { schema: vehicleView, signal }),
  });
}

/** Documentos de UN vehículo (owner=VEHICLE) para el detalle: SOAT, tarjeta de propiedad, foto. */
export function useVehicleDocuments(vehicleId: string) {
  return useQuery({
    queryKey: ['vehicle-documents', vehicleId] as const,
    enabled: vehicleId.length > 0,
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/documents', {
        schema: documentPage,
        signal,
        query: cleanQuery({ ownerId: vehicleId, limit: 50 }),
      }),
  });
}

/** Inspecciones (ITV) de UN vehículo — última + historial, para la card de ITV del detalle. */
export function useVehicleInspections(vehicleId: string) {
  return useQuery({
    queryKey: ['vehicle-inspections', vehicleId] as const,
    enabled: vehicleId.length > 0,
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/inspections', {
        schema: inspectionPage,
        signal,
        query: cleanQuery({ vehicleId, limit: 50 }),
      }),
  });
}

export function useInspections() {
  return useInfiniteQuery({
    queryKey: qk.inspections,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/fleet/inspections', {
        schema: inspectionPage,
        signal,
        query: cleanQuery({ cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Cola de vencimientos PAGINADA (cursor compuesto expiresAt|id que sirve fleet-service). Migrada de
 * useQuery (array, cap silencioso de 25) a useInfiniteQuery: el operador recorre TODA la cola con
 * "Cargar más", igual que documentos/vehículos/inspecciones. El cursor es opaco para la UI.
 */
const expiringPage = paginated(expiringDocumentView);

export function useExpiringDocuments() {
  return useInfiniteQuery({
    queryKey: qk.expiring,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/fleet/documents/expiring', {
        schema: expiringPage,
        signal,
        query: cleanQuery({ cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useDocumentReview() {
  const qc = useQueryClient();
  return useMutation({
    // El bff espera `POST /fleet/documents/:id/review` con `{ decision: 'VALID' | 'REJECTED' }`.
    // La UI habla en approve/reject; acá se traduce al contrato del servidor (que revalida).
    // `driverId` es OPCIONAL: cuando la revisión sale del visor de detalle del conductor, lo pasamos
    // para invalidar su detalle (refresca StatusPill + gate de aprobación); fleet→documentos lo omite.
    mutationFn: (input: {
      id: string;
      decision: 'approve' | 'reject';
      driverId?: string;
      // M5: motivo del rechazo (solo reject) — se persiste y el conductor lo ve. Opcional.
      reason?: string;
    }) =>
      apiClient().post(`/fleet/documents/${input.id}/review`, {
        body: {
          decision: input.decision === 'approve' ? 'VALID' : 'REJECTED',
          ...(input.reason ? { reason: input.reason } : {}),
        },
        schema: fleetDocumentView,
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['fleet-documents'] });
      void qc.invalidateQueries({ queryKey: qk.expiring });
      if (input.driverId) void qc.invalidateQueries({ queryKey: qk.driver(input.driverId) });
    },
  });
}

/* ── Catálogo de modelos: cola de revisión del operador (B5-2.c) ── */
const modelReviewPage = paginated(vehicleModelReviewView);

/** Cola de modelos solicitados a revisar (default PENDING_REVIEW). */
export function useModelReview(status: string) {
  return useInfiniteQuery({
    queryKey: qk.modelReview(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/fleet/vehicle-models/review', {
        schema: modelReviewPage,
        signal,
        query: cleanQuery({ status, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Aprobar/rechazar/reabrir una solicitud de modelo. La UI habla approve/reject/reopen; el bff traduce al
 * endpoint (POST /fleet/vehicle-models/:id/approve|reject|reopen) y el fleet-service revalida + audita.
 * `reopen` (F2) devuelve un modelo APROBADO a PENDING_REVIEW para corregir su ficha mal cargada.
 */
export function useModelReviewAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | ({ id: string; decision: 'approve' } & ApproveVehicleModelRequest)
        | { id: string; decision: 'reject' }
        | { id: string; decision: 'reopen' },
    ) => {
      if (input.decision === 'approve') {
        return apiClient().post(`/fleet/vehicle-models/${input.id}/approve`, {
          body: {
            segment: input.segment,
            energySource: input.energySource,
            efficiency: input.efficiency,
            ...(input.seats !== undefined ? { seats: input.seats } : {}),
          },
          schema: vehicleModelReviewView,
        });
      }
      return apiClient().post(`/fleet/vehicle-models/${input.id}/${input.decision}`, {
        schema: vehicleModelReviewView,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle-model-review'] });
    },
  });
}

/**
 * Catálogo APROBADO de modelos para el selector del alta admin (F4 · C2). Página única: el catálogo curado
 * es chico (tope 100 server-side) — el selector lo ordena alfabético al render. El operador elige un modelo
 * y manda su `modelSpecId`; el fleet-service snapshotea make/model/tipo (fuente única, sin texto libre).
 */
const modelSpecPage = paginated(vehicleModelSpecView);

export function useVehicleModels() {
  return useQuery({
    queryKey: qk.vehicleModels,
    queryFn: ({ signal }) =>
      // DEUDA: el selector trae una sola página (no sigue nextCursor) · techo: si el catálogo aprobado supera 100 modelos, el selector trunca en silencio · gatillo: si el catálogo crece >100 → useInfiniteQuery + buscador server-side (q)
      apiClient().get('/fleet/vehicle-models', {
        schema: modelSpecPage,
        signal,
        query: { limit: 100 },
      }),
  });
}

/** Alta de vehículo (operador). El bff/fleet-service revalidan BR-D04 (año mínimo, placa única). */
export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVehicleRequest) =>
      apiClient().post('/fleet/vehicles', { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.vehicles });
    },
  });
}

/** Alta de documento (conductor/vehículo). Entra PENDING_REVIEW. */
export function useCreateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentRequest) =>
      apiClient().post('/fleet/documents', { body: input, schema: fleetDocumentView }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fleet-documents'] });
      void qc.invalidateQueries({ queryKey: qk.expiring });
    },
  });
}

/** Registro de una inspección técnica (ITV) ya realizada. */
export function useCreateInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInspectionRequest) =>
      apiClient().post('/fleet/inspections', { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inspections });
    },
  });
}

/* ── Finanzas ── */
const payoutPage = paginated(payoutView);

/* ── KPIs de Liquidaciones: total liquidado + conteos por estado (stat cards) — FINANCE/ADMIN ── */
export function usePayoutStats() {
  return useQuery({
    queryKey: qk.payoutStats,
    queryFn: ({ signal }) =>
      apiClient().get('/finance/payouts/stats', { schema: payoutStatsView, signal }),
  });
}

export function usePayouts(status: string) {
  return useInfiniteQuery({
    queryKey: qk.payouts(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/finance/payouts', {
        schema: payoutPage,
        signal,
        query: cleanQuery({ status, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const reconciliationPage = paginated(reconciliationRunView);

/* ── Historial de conciliación diaria (BR-P07): corridas DB vs extracto del gateway — FINANCE/ADMIN ── */
export function useReconciliation() {
  return useInfiniteQuery({
    queryKey: qk.reconciliation,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/finance/reconciliation', {
        schema: reconciliationPage,
        signal,
        query: cleanQuery({ cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Ejecuta el BATCH de liquidaciones del periodo (no es por-payout: el backend liquida toda la semana).
 * Idempotente por Idempotency-Key. >S/5000 exige step-up MFA (lo valida payment-service). FINANCE.
 */
export function useRunPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { idempotencyKey: string; periodStart?: string; periodEnd?: string }) =>
      apiClient().post('/finance/payouts/run', {
        body: { periodStart: input.periodStart, periodEnd: input.periodEnd },
        schema: runPayoutsResult,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
    },
  });
}

/**
 * Libera los payouts HELD de un conductor y levanta su retención (camino de vuelta de driver.flagged).
 * Idempotente (re-liberar libera 0). Solo FINANCE (el bff revalida con @Roles; espejo `finance:payout`).
 * Sin schema de respuesta (mismo trato que useRefund): el contrato tipado vive en el bff.
 */
export function useReleaseDriverPayouts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { driverId: string }) =>
      apiClient().post(`/finance/payouts/drivers/${input.driverId}/release`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
    },
  });
}

/**
 * Reintenta un payout FALLIDO (ADR-015 §5): FAILED→PROCESSING re-invocando el riel de desembolso.
 * Idempotente por dedupKey (el riel NO doble-paga); Idempotency-Key de extremo a extremo. >S/5000 exige
 * step-up MFA (lo valida payment-service). Solo FINANCE (el bff revalida con @Roles; espejo `finance:payout`).
 */
export function useRetryPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { payoutId: string; idempotencyKey: string }) =>
      apiClient().post(`/finance/payouts/${input.payoutId}/retry`, {
        schema: payoutDisburseResult,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
    },
  });
}

export function useRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      tripId: string;
      amountCents: number;
      reason: string;
      idempotencyKey: string;
      // "Es un reembolso NUEVO, no un reintento": salta el backstop de ventana server-side (2do parcial idéntico).
      forceNew?: boolean;
    }) =>
      // El admin-bff expone el reembolso como POST /finance/refunds/:tripId con body {amountCents, reason, forceNew}.
      apiClient().post(`/finance/refunds/${input.tripId}`, {
        body: { amountCents: input.amountCents, reason: input.reason, forceNew: input.forceNew ?? false },
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
    },
  });
}

/* ── Cobro reembolsable de un viaje: inspección PREVIA al reembolso (FINANCE · acceso a PII auditado server-side) ── */
export function usePaymentByTrip(tripId: string | null) {
  return useQuery({
    queryKey: qk.paymentByTrip(tripId ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/payments/by-trip/${tripId}`, { schema: refundablePaymentView, signal }),
    // Solo consulta cuando hay un tripId (el operador tipeó/pegó el viaje a reembolsar); sin él no hay nada que ver.
    enabled: !!tripId,
  });
}

/* ── Detalle de un payout: breakdown de auditoría (deuda CASH + credit-back neteados por FK) — FINANCE/ADMIN ── */
export function usePayoutDetail(payoutId: string | null) {
  return useQuery({
    queryKey: qk.payoutDetail(payoutId ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/payouts/${payoutId}`, { schema: payoutDetailView, signal }),
    enabled: !!payoutId,
  });
}

/* ── Pricing: modo de despacho PUJA↔FIJO (schedule global · ADR 011 · ADMIN/SUPERADMIN/FINANCE) ── */
export function useModeSchedule() {
  return useQuery({
    queryKey: qk.modeSchedule,
    queryFn: ({ signal }) =>
      apiClient().get('/pricing/mode-schedule', { schema: modeScheduleView, signal }),
  });
}

export function useReplaceSchedule() {
  const qc = useQueryClient();
  return useMutation({
    // PUT reemplaza el schedule wholesale (default + reglas). El admin-bff revalida
    // `@Roles(ADMIN, SUPERADMIN, FINANCE)` y trip-service re-firma server-side: la UI solo refleja.
    mutationFn: (input: ReplaceScheduleRequest) =>
      apiClient().put('/pricing/mode-schedule', { body: input, schema: modeScheduleView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.modeSchedule });
    },
  });
}

/* ── Pricing: recargo de combustible por km (global · B3 · ADMIN/SUPERADMIN/FINANCE) ── */
export function useFuelSurcharge() {
  return useQuery({
    queryKey: qk.fuelSurcharge,
    queryFn: ({ signal }) =>
      apiClient().get('/pricing/fuel-surcharge', { schema: fuelSurchargeView, signal }),
  });
}

export function useReplaceFuelSurcharge() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(ADMIN, SUPERADMIN, FINANCE)` y trip-service re-firma: la UI solo refleja.
    mutationFn: (input: ReplaceFuelSurchargeRequest) =>
      apiClient().put('/pricing/fuel-surcharge', { body: input, schema: fuelSurchargeView }),
    // onSettled (no onSuccess): re-sincroniza con el server tras éxito O conflicto (409 CAS) — así el panel
    // muestra la versión/valores vigentes aunque otro admin haya cambiado el config mientras editabas.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.fuelSurcharge });
    },
  });
}

/* ── Pricing: tarifa base global (banderazo + per-km + per-min · F2.4 · ADMIN/SUPERADMIN/FINANCE) ── */
export function useBaseFare() {
  return useQuery({
    queryKey: qk.baseFare,
    queryFn: ({ signal }) =>
      apiClient().get('/pricing/base-fare', { schema: baseFareView, signal }),
  });
}

export function useReplaceBaseFare() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(ADMIN, SUPERADMIN, FINANCE)` + step-up MFA, y trip-service re-firma: la UI solo refleja.
    mutationFn: (input: ReplaceBaseFareRequest) =>
      apiClient().put('/pricing/base-fare', { body: input, schema: baseFareView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.baseFare });
    },
  });
}

/* ── Comisión por modo (F2.7 · ON-DEMAND configurable · CARPOOLING 0 legal-gated · FINANCE/ADMIN/SUPERADMIN) ── */
export function useCommission() {
  return useQuery({
    queryKey: qk.commission,
    queryFn: ({ signal }) =>
      apiClient().get('/finance/commission', { schema: commissionView, signal }),
  });
}

export function useReplaceCommission() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(FINANCE, ADMIN, SUPERADMIN)` + step-up MFA, y payment-service re-autoriza: la UI solo refleja.
    mutationFn: (input: ReplaceCommissionRequest) =>
      apiClient().put('/finance/commission', { body: input, schema: commissionView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.commission });
    },
  });
}

/* ── Costo/km del carpooling (F2.5 · costo de operación DIRECTO del admin, per-país · FINANCE/ADMIN/SUPERADMIN) ── */
export function useCostPerKm() {
  return useQuery({
    queryKey: qk.costPerKm,
    queryFn: ({ signal }) =>
      apiClient().get('/finance/cost-per-km', { schema: costPerKmListView, signal }),
  });
}

export function useReplaceCostPerKm() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(FINANCE, ADMIN, SUPERADMIN)` + step-up MFA, y booking-service re-autoriza: la UI solo refleja.
    mutationFn: (input: ReplaceCostPerKmRequest) =>
      apiClient().put('/finance/cost-per-km', { body: input, schema: costPerKmConfigView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.costPerKm });
    },
  });
}

/* ── Pricing: piso de la PUJA per-(zona, oferta) (ADR 010 §9.3 · ADMIN/SUPERADMIN/FINANCE) ── */
export function useBidFloor() {
  return useQuery({
    queryKey: qk.bidFloor,
    queryFn: ({ signal }) =>
      apiClient().get('/pricing/bid-floor', { schema: bidFloorView, signal }),
  });
}

export function useReplaceBidFloor() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(ADMIN, SUPERADMIN, FINANCE)` + step-up MFA, y trip-service re-firma: la UI solo refleja.
    mutationFn: (input: ReplaceBidFloorRequest) =>
      apiClient().put('/pricing/bid-floor', { body: input, schema: bidFloorView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.bidFloor });
    },
  });
}

/* ── Pricing: catálogo de precios de energía por fuente (B5 · ADMIN/SUPERADMIN/FINANCE) ── */
export function useEnergyCatalog() {
  return useQuery({
    queryKey: qk.energyCatalog,
    queryFn: ({ signal }) =>
      apiClient().get('/pricing/energy-catalog', { schema: energyCatalogView, signal }),
  });
}

export function useReplaceEnergyCatalog() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(ADMIN, SUPERADMIN, FINANCE)` y trip-service re-firma: la UI solo refleja.
    mutationFn: (input: ReplaceEnergyCatalogRequest) =>
      apiClient().put('/pricing/energy-catalog', { body: input, schema: energyCatalogView }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.energyCatalog });
    },
  });
}

/* ── Catálogo de ofertas: enabled por oferta, overlay singleton (ADMIN/SUPERADMIN/FINANCE) ── */
export function useCatalog() {
  return useQuery({
    queryKey: qk.catalog,
    queryFn: ({ signal }) => apiClient().get('/catalog', { schema: catalogView, signal }),
  });
}

export function useReplaceCatalog() {
  const qc = useQueryClient();
  return useMutation({
    // PUT reemplaza el overlay wholesale (enabled por oferta). El admin-bff revalida
    // `@Roles(ADMIN, SUPERADMIN, FINANCE)` y trip-service re-firma server-side: la UI solo refleja.
    mutationFn: (input: ReplaceCatalogRequest) =>
      apiClient().put('/catalog', { body: input, schema: catalogView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.catalog });
    },
  });
}

/* ── Dispatch: config de RADIOS (k-rings) singleton global (ADMIN/SUPERADMIN/DISPATCHER) ── */
export function useDispatchRadiusConfig() {
  return useQuery({
    queryKey: qk.dispatchRadiusConfig,
    queryFn: ({ signal }) =>
      apiClient().get('/dispatch/radius-config', { schema: dispatchRadiusConfigView, signal }),
  });
}

export function useUpdateDispatchRadiusConfig() {
  const qc = useQueryClient();
  return useMutation({
    // PUT reemplaza los k-rings wholesale y bumpea version. El admin-bff revalida
    // `@Roles(ADMIN, SUPERADMIN, DISPATCHER)` y dispatch-service re-firma server-side: la UI solo refleja.
    mutationFn: (input: ReplaceRadiusConfigRequest) =>
      apiClient().put('/dispatch/radius-config', { body: input, schema: dispatchRadiusConfigView }),
    // ADR-021 Fase H (H2) — onSettled (NO onSuccess): re-sincroniza el read-model tras éxito O CONFLICTO
    // (409 CAS por optimistic-lock de version), igual que los 8 paneles de pricing/catalog. Con onSuccess un
    // 409 dejaba la version stale como expectedVersion → todo re-save 409eaba en loop sin recuperación.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.dispatchRadiusConfig });
    },
  });
}

/* ── Media (acceso a video con step-up) ── */
const mediaPage = paginated(mediaAccessRequestView);

export function useMediaRequests(status: string) {
  return useQuery({
    queryKey: qk.media(status),
    queryFn: ({ signal }) =>
      apiClient().get('/media/access-requests', {
        schema: mediaPage,
        signal,
        query: cleanQuery({ status }),
      }),
  });
}

export function useRequestMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { tripId: string; reason: string }) =>
      apiClient().post('/media/access-requests', {
        body: input,
        schema: mediaAccessRequestView,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['media-requests'] });
    },
  });
}

export function useDecideMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      apiClient().post(`/media/access-requests/${input.id}/${input.decision}`, {
        schema: mediaAccessRequestView,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['media-requests'] });
    },
  });
}

/**
 * Token de cámara EN VIVO para el muro del admin (token LiveKit solo-suscripción de una cabina en curso).
 * El endpoint exige step-up MFA fresco + rol (doble-auth como las grabaciones); el StepUpDialog asegura la
 * MFA ANTES de llamar. Cada apertura se audita server-side con el motivo (Ley 29733). No se cachea: es efímero.
 */
export function useLiveCameraToken() {
  return useMutation({
    mutationFn: (input: LiveAccessRequest) =>
      apiClient().post('/media/live/token', { body: input, schema: liveViewerToken }),
  });
}

/** Obtiene la URL firmada del video (requiere MFA fresco; el bff la valida). */
export function useSignedMedia() {
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().get(`/media/access-requests/${input.id}/stream`, { schema: signedMedia }),
  });
}

/* ── Auditoría ── */
const auditPage = paginated(auditEntryView);

export function useAudit(query: string) {
  return useInfiniteQuery({
    queryKey: [...qk.audit, query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/audit', {
        schema: auditPage,
        signal,
        query: cleanQuery({ q: query, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useVerifyAuditChain() {
  return useMutation({
    // El admin-bff expone la verificación como GET /audit/verify (lectura idempotente de la hash-chain).
    mutationFn: () => apiClient().get('/audit/verify', { schema: auditChainVerification }),
  });
}
