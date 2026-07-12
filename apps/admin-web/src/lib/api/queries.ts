'use client';

import { z } from 'zod';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import { FILTER_ALL } from '@/lib/filters';
import {
  analyticsOverview,
  revenueMetricsView,
  auditChainVerification,
  auditEntryView,
  type CreateInspectionRequest,
  dispatchRadiusConfigView,
  radarPreview,
  carpoolSearchConfigView,
  activeCarpoolsView,
  adminCarpoolDetailView,
  cancelCarpoolResult,
  type ReplaceCarpoolSearchConfigRequest,
  type ReplaceRadiusConfigRequest,
  driverApproval,
  driverDetail,
  dniFaceMatchResult,
  expiringDocumentView,
  fleetDocumentView,
  inspectionView,
  vehicleModelReviewView,
  type ApproveVehicleModelRequest,
  type LiveAccessRequest,
  liveViewerToken,
  liveCabin,
  mediaAccessRequestView,
  catalogView,
  catalogOffering,
  type CreateOfferingRequest,
  baseFareView,
  commissionView,
  costPerKmConfigView,
  costPerKmListView,
  bidFloorView,
  refundablePaymentView,
  refundView,
  refundStatsView,
  refundDetailView,
  refundActionResult,
  payoutDetailView,
  payoutTripsResult,
  payoutStatsView,
  reconciliationRunView,
  type ReplaceBaseFareRequest,
  type ReplaceOnDemandRateRequest,
  type ReplaceCarpoolingFeeRequest,
  type ReplaceCostPerKmRequest,
  type ReplaceBidFloorRequest,
  operator,
  operatorDetail,
  type CreateOperatorRequest,
  type ChangeOperatorRolesRequest,
  createOperatorResult,
  reinviteOperatorResult,
  paginated,
  pendingDriver,
  driverCounts,
  vehicleCounts,
  reviewQueueSummary,
  panicDetail,
  panicEvidenceResult,
  type AttachPanicEvidenceRequest,
  type ResolvePanicRequest,
  type ReplaceCatalogRequest,
  offeringMetricsView,
  panicSummary,
  payoutView,
  runPayoutsResult,
  payoutDisburseResult,
  signedMedia,
  tripDetail,
  tripSummary,
  vehicleView,
  policyView,
  type PolicyView,
  type UpdatePolicyRequest,
  permissionOverrideView,
  type PermissionOverrideView,
  type SetPermissionOverrideRequest,
  type TripStatus,
  type RevenueRangeValue,
} from './schemas';

/** Llaves de caché centralizadas para invalidaciones consistentes. */
export const qk = {
  overview: ['overview'] as const,
  revenueMetrics: (range: string) => ['analytics-revenue', range] as const,
  trips: (f: TripFilters) => ['trips', f] as const,
  trip: (id: string) => ['trip', id] as const,
  drivers: (status: string) => ['drivers', status] as const,
  driver: (id: string) => ['driver', id] as const,
  driversPending: ['drivers-pending'] as const,
  driversSummary: ['drivers-summary'] as const,
  vehiclesSummary: ['vehicles-summary'] as const,
  reviewsSummary: ['reviews-summary'] as const,
  operators: ['operators'] as const,
  operator: (id: string) => ['operator', id] as const,
  panics: (status: string) => ['panics', status] as const,
  panic: (id: string) => ['panic', id] as const,
  liveCabins: ['live-cabins'] as const,
  vehicles: ['vehicles'] as const,
  vehicle: (id: string) => ['vehicle', id] as const,
  inspections: ['inspections'] as const,
  expiring: ['fleet-expiring'] as const,
  documents: (status: string) => ['fleet-documents', status] as const,
  modelReview: (status: string) => ['vehicle-model-review', status] as const,
  payouts: (status: string) => ['payouts', status] as const,
  payoutStats: ['payout-stats'] as const,
  paymentByTrip: (tripId: string) => ['payment-by-trip', tripId] as const,
  refunds: (status: string) => ['refunds', status] as const,
  refundStats: ['refund-stats'] as const,
  refundDetail: (id: string) => ['refund-detail', id] as const,
  payoutDetail: (id: string) => ['payout-detail', id] as const,
  payoutTrips: (id: string) => ['payout-trips', id] as const,
  reconciliation: ['reconciliation'] as const,
  media: (status: string) => ['media-requests', status] as const,
  audit: ['audit'] as const,
  baseFare: ['base-fare'] as const,
  commission: ['commission'] as const,
  costPerKm: ['cost-per-km'] as const,
  bidFloor: ['bid-floor'] as const,
  catalog: ['catalog'] as const,
  offeringMetrics: (id: string) => ['offering-metrics', id] as const,
  dispatchRadiusConfig: ['dispatch-radius-config'] as const,
  dispatchRadar: (mode: string) => ['dispatch-radar', mode] as const,
  carpoolConfig: ['carpool-search-config'] as const,
  carpoolRadar: ['carpool-radar'] as const,
  activeCarpools: ['carpool-active-monitor'] as const,
  carpoolDetail: (id: string) => ['carpool-detail', id] as const,
  policies: ['gobierno-policies'] as const,
  permissionOverrides: ['gobierno-permission-overrides'] as const,
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

/**
 * Métricas de INGRESOS del período (money-in, comisión bruta, margen, reembolsado + serie por bucket). El rango
 * (today/7d/30d) es parte de la queryKey → cambiar de rango re-consulta y cachea por separado. Dato real de
 * payment-service (agregado en TZ Lima); sin refetch en vivo (es analítica, no operación instantánea).
 */
export function useRevenueMetrics(range: RevenueRangeValue) {
  return useQuery({
    queryKey: qk.revenueMetrics(range),
    queryFn: ({ signal }) =>
      apiClient().get(`/analytics/revenue?range=${range}`, { schema: revenueMetricsView, signal }),
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

/** Muro de cámaras EN VIVO: cabinas de los viajes en curso (tiles enriquecidos). Refetch en tiempo real
 *  para reflejar viajes que arrancan/terminan. El feed NO se abre acá (eso es doble-auth por-viaje). */
export function useLiveCabins() {
  return useQuery({
    queryKey: qk.liveCabins,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/live-cabins', { schema: z.array(liveCabin), signal }),
    refetchInterval: REALTIME_REFETCH,
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
    mutationFn: (input: { id: string }) => apiClient().post(`/ops/drivers/${input.id}/reactivate`),
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

/**
 * Conteo AUTORITATIVO de vehículos por estado documental (valid/expiringSoon/expired · GET /ops/vehicles/summary).
 * A diferencia de las cards derivadas de `useVehicles` (que solo cuentan las páginas YA cargadas en el cliente),
 * este resumen lo agrega el servidor sobre TODA la flota. Mismo patrón que useDriversSummary/useReviewsSummary.
 */
export function useVehiclesSummary() {
  return useQuery({
    queryKey: qk.vehiclesSummary,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/vehicles/summary', { schema: vehicleCounts, signal }),
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

/** Detalle de un operador (identidad + 2FA + último acceso + permisos efectivos + sesiones activas). */
export function useOperatorDetail(id: string) {
  return useQuery({
    queryKey: qk.operator(id),
    queryFn: ({ signal }) =>
      apiClient().get(`/ops/operators/${id}`, { schema: operatorDetail, signal }),
  });
}

/** Invalidación compartida por las mutaciones del detalle: refresca la ficha + la lista. */
function invalidateOperator(qc: ReturnType<typeof useQueryClient>, id: string) {
  void qc.invalidateQueries({ queryKey: qk.operator(id) });
  void qc.invalidateQueries({ queryKey: qk.operators });
}

/**
 * Cambia los roles de un operador. Acción SENSIBLE: el bff exige step-up MFA + revalida anti-escalada
 * (`canGrantRoles`) — el llamador (diálogo) verifica TOTP fresco ANTES de invocar. La UI solo refleja.
 */
export function useChangeOperatorRoles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & ChangeOperatorRolesRequest) =>
      apiClient().post(`/ops/operators/${input.id}/roles`, { body: { roles: input.roles } }),
    onSuccess: (_d, input) => invalidateOperator(qc, input.id),
  });
}

/** Suspende un operador ACTIVE (status → SUSPENDED). Step-up MFA (el llamador verifica antes). 204 vacío. */
export function useSuspendOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/operators/${input.id}/suspend`, {}),
    onSuccess: (_d, input) => invalidateOperator(qc, input.id),
  });
}

/** Remueve un operador del panel (soft-delete). Step-up MFA (el llamador verifica antes). 204 vacío. */
export function useRemoveOperator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/ops/operators/${input.id}/remove`, {}),
    onSuccess: (_d, input) => invalidateOperator(qc, input.id),
  });
}

/** Revoca UNA sesión activa del operador. Step-up MFA (el llamador verifica antes). 204 vacío. */
export function useRevokeOperatorSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; sessionId: string }) =>
      apiClient().post(`/ops/operators/${input.id}/sessions/${input.sessionId}/revoke`, {}),
    onSuccess: (_d, input) => invalidateOperator(qc, input.id),
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

/**
 * Reconoce (ACK) un incidente de pánico (POST /security/panics/:id/ack). Acción NO crítica (no exige
 * step-up MFA server-side). El éxito invalida el detalle y los listados. El resolve va aparte
 * (`useResolvePanic`): exige elegir el desenlace + step-up MFA.
 */
export function usePanicAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'ack' | 'dispatch' | 'escalate' }) =>
      apiClient().post(`/security/panics/${input.id}/${input.action}`, {
        schema: panicDetail,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: qk.panic(data.id) });
      void qc.invalidateQueries({ queryKey: ['panics'] });
    },
  });
}

/**
 * Resuelve / marca falsa alarma un incidente (POST /security/panics/:id/resolve). Contrato:
 * `{ resolution: 'RESOLVED' | 'FALSE_ALARM', notes?: string }` — `resolution` es REQUERIDO (el server lo
 * exige con @IsIn y `forbidNonWhitelisted`); `notes` es el motivo opcional que queda en el audit. Acción
 * CRÍTICA: el server exige step-up MFA fresca (@RequireStepUpMfa) → el diálogo hace `stepUp()` antes.
 */
export function useResolvePanic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & ResolvePanicRequest) =>
      apiClient().post(`/security/panics/${input.id}/resolve`, {
        body: { resolution: input.resolution, ...(input.notes ? { notes: input.notes } : {}) },
        schema: panicDetail,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: qk.panic(data.id) });
      void qc.invalidateQueries({ queryKey: ['panics'] });
    },
  });
}

/**
 * Adjunta (y opcionalmente PROTEGE) evidencia a un incidente de pánico (POST /security/panics/:id/evidence).
 * `keys` = claves S3 ya subidas; `finalize` aplica retención/object-lock (cadena de custodia · Ley 29733). El
 * server devuelve las claves adjuntas + las protegidas. El éxito invalida el detalle del pánico (la card de
 * Evidencia refleja lo recién adjuntado) y los listados. El admin-bff revalida @Roles server-side; la UI refleja.
 */
export function useAttachPanicEvidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & AttachPanicEvidenceRequest) =>
      apiClient().post(`/security/panics/${input.id}/evidence`, {
        body: { keys: input.keys, ...(input.finalize ? { finalize: input.finalize } : {}) },
        schema: panicEvidenceResult,
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: qk.panic(input.id) });
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
 * Resolución de una solicitud de modelo por el operador (B5-2.c):
 * - `approve` completa la ficha técnica (segment/energySource/efficiency/seats) → PENDING→APPROVED.
 * - `reject` descarta la solicitud (sin body) → PENDING→REJECTED.
 * Ambas devuelven la vista de revisión actualizada. Invalida la cola para refrescar todas las pestañas.
 */
export function useModelReviewAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | ({ id: string; decision: 'approve' } & ApproveVehicleModelRequest)
        | { id: string; decision: 'reject' },
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
      return apiClient().post(`/fleet/vehicle-models/${input.id}/reject`, {
        schema: vehicleModelReviewView,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle-model-review'] });
    },
  });
}

/**
 * Reabre un modelo YA APROBADO para corregir su ficha técnica (POST /fleet/vehicle-models/:id/reopen ·
 * APPROVED→PENDING_REVIEW). Devuelve la vista de revisión actualizada. Invalida la cola para que el modelo
 * reaparezca en la pestaña de pendientes. El admin-bff revalida @Roles(COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN).
 */
export function useReopenModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/fleet/vehicle-models/${input.id}/reopen`, {
        schema: vehicleModelReviewView,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vehicle-model-review'] });
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

/* ── Cobro reembolsable de un viaje: inspección PREVIA al reembolso (FINANCE · acceso a PII auditado server-side) ── */
export function usePaymentByTrip(tripId: string | null) {
  return useQuery({
    queryKey: qk.paymentByTrip(tripId ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/payments/by-trip/${tripId}`, {
        schema: refundablePaymentView,
        signal,
      }),
    // Solo consulta cuando hay un tripId (el operador tipeó/pegó el viaje a reembolsar); sin él no hay nada que ver.
    enabled: !!tripId,
  });
}

/* ── Cola de aprobación de REEMBOLSOS (money-OUT · frame HZ8uz) ─────────────────────────────────────────────
 * Espeja el patrón de payouts: lista paginada por cursor + KPIs + detalle + acciones (approve/reject) con
 * step-up MFA. El estado del Refund (PENDING/APPROVED/COMPLETED/REJECTED) lo gobierna payment-service; acá solo
 * se lista/actúa. `useRequestRefund` crea la solicitud PENDING (NO desembolsa hasta aprobar). */
const refundPage = paginated(refundView);

/** Cola de reembolsos (GET /finance/refunds): filtro por estado (enum) + paginación cursor. finance:view. */
export function useRefunds(status: string) {
  return useInfiniteQuery({
    queryKey: qk.refunds(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiClient().get('/finance/refunds', {
        schema: refundPage,
        signal,
        query: cleanQuery({ status, cursor: pageParam, limit: 50 }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** KPIs de la cabecera (GET /finance/refunds/stats): Solicitados/Aprobados/Procesado hoy/Tasa. finance:view. */
export function useRefundStats() {
  return useQuery({
    queryKey: qk.refundStats,
    queryFn: ({ signal }) =>
      apiClient().get('/finance/refunds/stats', { schema: refundStatsView, signal }),
  });
}

/** Detalle de un reembolso (GET /finance/refunds/:id): la fila + el saldo del cobro. enabled solo con id. */
export function useRefundDetail(id: string | null) {
  return useQuery({
    queryKey: qk.refundDetail(id ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/refunds/${id}`, { schema: refundDetailView, signal }),
    enabled: !!id,
  });
}

/** Invalidación compartida por las acciones de la cola: refresca la cola + los KPIs (+ el detalle si aplica). */
function invalidateRefunds(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ['refunds'] });
  void qc.invalidateQueries({ queryKey: qk.refundStats });
  if (id) void qc.invalidateQueries({ queryKey: qk.refundDetail(id) });
}

/**
 * APRUEBA + desembolsa un reembolso PENDING (POST /finance/refunds/:id/approve · money-OUT). Exige step-up MFA
 * fresco (el StepUpDialog lo asegura ANTES) + finance:refund; el admin-bff revalida @Permission + @RequireStepUpMfa.
 * Idempotente. El éxito refresca la cola, los KPIs y el detalle.
 */
export function useApproveRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/finance/refunds/${input.id}/approve`, { schema: refundActionResult }),
    onSuccess: (_d, input) => invalidateRefunds(qc, input.id),
  });
}

/**
 * RECHAZA un reembolso PENDING con motivo (POST /finance/refunds/:id/reject · sin mover plata). El motivo es
 * OBLIGATORIO (≥3, lo captura el RejectModal) + step-up MFA. finance:refund. El éxito refresca cola/KPIs/detalle.
 */
export function useRejectRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      apiClient().post(`/finance/refunds/${input.id}/reject`, {
        body: { reason: input.reason },
        schema: refundActionResult,
      }),
    onSuccess: (_d, input) => invalidateRefunds(qc, input.id),
  });
}

/**
 * SOLICITA un reembolso de un viaje (POST /finance/refunds/:tripId): crea la solicitud PENDING (entra a la cola
 * de aprobación; NO desembolsa hasta aprobar). Idempotency-Key de extremo a extremo + step-up MFA. finance:refund.
 * El éxito refresca la cola + los KPIs.
 */
export function useRequestRefund() {
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
      apiClient().post(`/finance/refunds/${input.tripId}`, {
        body: {
          amountCents: input.amountCents,
          reason: input.reason,
          forceNew: input.forceNew ?? false,
        },
        schema: refundActionResult,
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => invalidateRefunds(qc),
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

/* ── Viajes incluidos en un payout: reconstrucción por período (cap 50) + totalCount — FINANCE/ADMIN (finance:view) ── */
export function usePayoutTrips(payoutId: string | null) {
  return useQuery({
    queryKey: qk.payoutTrips(payoutId ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/payouts/${payoutId}/trips`, { schema: payoutTripsResult, signal }),
    enabled: !!payoutId,
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

// CAS desacoplada #3: on-demand y carpooling se editan por SEPARADO, cada uno con su propia version → editar uno
// ya no 409ea al otro. Cada mutation pega a SU endpoint y remanda la versión que le corresponde (via el panel).
export function useReplaceOnDemandRate() {
  const qc = useQueryClient();
  return useMutation({
    // El admin-bff revalida `@Roles(FINANCE, ADMIN, SUPERADMIN)` + step-up MFA, y payment-service re-autoriza: la UI solo refleja.
    mutationFn: (input: ReplaceOnDemandRateRequest) =>
      apiClient().put('/finance/commission/on-demand', { body: input, schema: commissionView }),
    // onSettled (no onSuccess): re-sincroniza tras éxito O conflicto (409 CAS) → el panel muestra la versión vigente.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.commission });
    },
  });
}

export function useReplaceCarpoolingFee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplaceCarpoolingFeeRequest) =>
      apiClient().put('/finance/commission/carpooling-fee', {
        body: input,
        schema: commissionView,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.commission });
    },
  });
}

/* ── Monitoreo de carpools activos (booking-service · KPIs + listado · finance:view · panel finance/carpooling) ──
 * Refresco "en vivo" (15s) para que los KPIs de ocupación y el listado respiren con la operación real. */
export function useActiveCarpools() {
  return useQuery({
    queryKey: qk.activeCarpools,
    queryFn: ({ signal }) =>
      apiClient().get('/finance/carpooling/active', { schema: activeCarpoolsView, signal }),
    refetchInterval: REALTIME_REFETCH,
  });
}

/**
 * DETALLE de un carpool (GET /finance/carpooling/:id · finance:view): recorrido + asientos/pasajeros + reparto de
 * costo + conductor + vehículo. `enabled` solo con id. Refresco en vivo (los cupos/pasajeros respiran). El acceso
 * (PII de pasajeros) lo AUDITA el admin-bff.
 */
export function useCarpoolDetail(id: string | null) {
  return useQuery({
    queryKey: qk.carpoolDetail(id ?? ''),
    queryFn: ({ signal }) =>
      apiClient().get(`/finance/carpooling/${id}`, { schema: adminCarpoolDetailView, signal }),
    enabled: !!id,
    refetchInterval: REALTIME_REFETCH,
  });
}

/**
 * CANCELA un carpool (POST /finance/carpooling/:id/cancel · acción DESTRUCTIVA). Exige step-up MFA fresco (el
 * StepUpDialog lo asegura ANTES) + finance:manage; el admin-bff revalida @Permission + @RequireStepUpMfa y booking
 * aplica la transición → CANCELADO (libera cupos + avisa a los pasajeros). Idempotente-seguro. El éxito refresca el
 * detalle + el monitoreo de activos.
 */
export function useCancelCarpool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string }) =>
      apiClient().post(`/finance/carpooling/${input.id}/cancel`, { schema: cancelCarpoolResult }),
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: qk.carpoolDetail(input.id) });
      void qc.invalidateQueries({ queryKey: qk.activeCarpools });
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

/**
 * ALTA de una oferta CUSTOM (POST /catalog/offerings · ADR 013). Acción EXCLUSIVA de SUPERADMIN + step-up MFA:
 * el admin-bff (`@Roles(SUPERADMIN)`) y trip-service re-autorizan server-side; la UI solo refleja el gate. La
 * respuesta es la oferta ya resuelta (`catalogOffering`). `onSettled` re-sincroniza el catálogo → la card nueva
 * aparece en la grilla.
 */
export function useCreateOffering() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOfferingRequest) =>
      apiClient().post('/catalog/offerings', { body: input, schema: catalogOffering }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.catalog });
    },
  });
}

/**
 * Métricas 30d de UNA oferta (GET /catalog/:id/metrics) — página-detalle del catálogo (board HjDvx). Datos
 * REALES de trip-service por `Trip.category`: viajes completados + facturación bruta (Σ fareCents). NO hay
 * revenue neto ni rating por oferta (sin fuente). Analítica, sin refetch en vivo; `enabled` solo con id.
 */
export function useOfferingMetrics(id: string) {
  return useQuery({
    queryKey: qk.offeringMetrics(id),
    queryFn: ({ signal }) =>
      apiClient().get(`/catalog/${id}/metrics`, { schema: offeringMetricsView, signal }),
    enabled: id.length > 0,
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

/** Radar de cobertura del modo dispatch (Fijo/Puja): densidad REAL de conductores por anillo (hot-index). */
export function useDispatchRadar(mode: 'FIXED' | 'PUJA', center: { lat: number; lon: number }) {
  return useQuery({
    queryKey: [...qk.dispatchRadar(mode), center.lat, center.lon] as const,
    queryFn: ({ signal }) =>
      apiClient().get('/dispatch/radar-preview', {
        schema: radarPreview,
        query: { mode, lat: String(center.lat), lon: String(center.lon) },
        signal,
      }),
    // Barrido "vivo": refresca la densidad cada 15s para que el radar respire con la flota real.
    refetchInterval: 15_000,
  });
}

/* ── Carpool (booking-service): radio de búsqueda admin-editable + su radar ── */
export function useCarpoolSearchConfig() {
  return useQuery({
    queryKey: qk.carpoolConfig,
    queryFn: ({ signal }) =>
      apiClient().get('/dispatch/carpool-radius-config', { schema: carpoolSearchConfigView, signal }),
  });
}

export function useUpdateCarpoolSearchConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplaceCarpoolSearchConfigRequest) =>
      apiClient().put('/dispatch/carpool-radius-config', {
        body: input,
        schema: carpoolSearchConfigView,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.carpoolConfig });
    },
  });
}

export function useCarpoolRadar(center: { lat: number; lon: number }) {
  return useQuery({
    queryKey: [...qk.carpoolRadar, center.lat, center.lon] as const,
    queryFn: ({ signal }) =>
      apiClient().get('/dispatch/carpool-radar-preview', {
        schema: radarPreview,
        query: { lat: String(center.lat), lon: String(center.lon) },
        signal,
      }),
    refetchInterval: 15_000,
  });
}

/* ── Gobierno → Políticas (PBAC · ADR-024 · SOLO SUPERADMIN) ── */

/**
 * Las 16 políticas de gobierno vigentes (la grilla). GET /gobierno/policies devuelve el ESTADO real
 * (enabled/params/version/…); la metadata de forma (familia/label/schema) la aporta @veo/policy en la UI.
 * El admin-bff gatea @Roles(SUPERADMIN); la UI también con `gobierno:manage`. Sin refetch en vivo (config).
 */
export function usePolicies() {
  return useQuery({
    queryKey: qk.policies,
    queryFn: ({ signal }) =>
      apiClient().get('/gobierno/policies', { schema: z.array(policyView), signal }),
  });
}

/**
 * Aplica el parche {enabled?, params?} a una política (PUT /gobierno/policies/:key). El admin-bff exige
 * @Roles(SUPERADMIN) + @RequireStepUpMfa: el llamador asegura la MFA fresca con StepUpDialog ANTES de invocar.
 * identity-service VALIDA `params` (schema Zod de @veo/policy), aplica el candado `mandatory`, bumpea `version`
 * y emite policy.updated. onSettled (no onSuccess): re-sincroniza tras éxito O error (403 mandatory / 400 params)
 * para que la grilla refleje siempre el estado vigente.
 */
export function useUpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string } & UpdatePolicyRequest): Promise<PolicyView> =>
      apiClient().put(`/gobierno/policies/${encodeURIComponent(input.key)}`, {
        body: { enabled: input.enabled, params: input.params },
        schema: policyView,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.policies });
    },
  });
}

/* ── Gobierno → Permisos y visibilidad (OVERLAY subtract-only · ADR-025 §3 · SOLO SUPERADMIN) ── */

/**
 * El overlay de visibilidad vigente: los pares (rol, permiso) RESTADOS (`hidden:true`). GET
 * /gobierno/permission-overrides devuelve SOLO el estado del overlay — la matriz BASE (`PERMISSION_ROLES`) y el
 * candado legal-mandatory los aporta `@veo/policy` en la UI, que compone el efectivo `base ∧ ¬override`. El
 * admin-bff gatea @Roles(SUPERADMIN); la UI también con `gobierno:manage`. Sin refetch en vivo (config).
 */
export function usePermissionOverrides() {
  return useQuery({
    queryKey: qk.permissionOverrides,
    queryFn: ({ signal }) =>
      apiClient().get('/gobierno/permission-overrides', {
        schema: z.array(permissionOverrideView),
        signal,
      }),
  });
}

/**
 * Aplica un override subtract-only {role, permission, hidden} al overlay (PUT /gobierno/permission-overrides).
 * El admin-bff exige @Roles(SUPERADMIN) + @RequireStepUpMfa: el llamador asegura la MFA fresca con StepUpDialog
 * ANTES de invocar (la matriz agrupa N cambios y los guarda uno por PUT tras un único step-up). identity VALIDA
 * el invariante subtract-only contra la base + el candado legal-mandatory (400/403 con status/message intactos),
 * bumpea `version` y emite permission_override.updated. onSettled (no onSuccess): re-sincroniza tras éxito O
 * error para que la grilla refleje siempre el overlay vigente.
 */
export function useSetPermissionOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPermissionOverrideRequest): Promise<PermissionOverrideView> =>
      apiClient().put('/gobierno/permission-overrides', {
        body: input,
        schema: permissionOverrideView,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.permissionOverrides });
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
