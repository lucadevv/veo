'use client';

import { z } from 'zod';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiClient } from './client';
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
  expiringDocumentView,
  fleetDocumentView,
  inspectionView,
  type LiveAccessRequest,
  liveViewerToken,
  mediaAccessRequestView,
  modeScheduleView,
  operatorApproval,
  paginated,
  pendingDriver,
  pendingOperator,
  panicDetail,
  type AdminRoleValue,
  type ReplaceScheduleRequest,
  panicSummary,
  payoutView,
  runPayoutsResult,
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
  driversPending: ['drivers-pending'] as const,
  operators: ['operators'] as const,
  panics: (status: string) => ['panics', status] as const,
  panic: (id: string) => ['panic', id] as const,
  vehicles: ['vehicles'] as const,
  inspections: ['inspections'] as const,
  expiring: ['fleet-expiring'] as const,
  documents: (status: string) => ['fleet-documents', status] as const,
  payouts: (status: string) => ['payouts', status] as const,
  media: (status: string) => ['media-requests', status] as const,
  audit: ['audit'] as const,
  modeSchedule: ['mode-schedule'] as const,
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
    if (v !== undefined && v !== '' && v !== 'ALL') out[k] = v;
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

export function useDriverDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      // Sin schema: la respuesta del approve (id+estado) no se renderiza; el éxito refetchea la lista.
      // Aprobar/rechazar devuelven formas distintas (200 {id,backgroundCheckStatus} / 204 vacío); no parseamos.
      apiClient().post(`/ops/drivers/${input.id}/${input.decision}`, {
        body: input.reason ? { reason: input.reason } : undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
      void qc.invalidateQueries({ queryKey: qk.driversPending });
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

/** Cola REAL de conductores pendientes de aprobación de antecedentes (identity pending-approval, NO el read-model). */
export function useDriversPending() {
  return useQuery({
    queryKey: qk.driversPending,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/drivers/pending', { schema: z.array(pendingDriver), signal }),
  });
}

/* ── Operadores del panel (alta + asignación de roles · solo ADMIN/SUPERADMIN) ── */
const pendingOperatorList = z.array(pendingOperator);

export function useOperators() {
  return useQuery({
    queryKey: qk.operators,
    queryFn: ({ signal }) =>
      apiClient().get('/ops/operators/pending', { schema: pendingOperatorList, signal }),
  });
}

export function useOperatorDecision() {
  const qc = useQueryClient();
  return useMutation({
    // Aprobar exige los roles a asignar (RBAC); rechazar no lleva cuerpo. El admin-bff revalida
    // `@Roles(ADMIN, SUPERADMIN)` server-side: la UI solo refleja el permiso, nunca autoriza.
    mutationFn: (input: { id: string; decision: 'approve'; roles: AdminRoleValue[] } | { id: string; decision: 'reject' }) =>
      input.decision === 'approve'
        ? apiClient().post(`/ops/operators/${input.id}/approve`, {
            body: { roles: input.roles },
            schema: operatorApproval,
          })
        : apiClient().post(`/ops/operators/${input.id}/reject`, {}),
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
      apiClient().get('/security/panics', { schema: panicPage, signal, query: cleanQuery({ status }) }),
    refetchInterval: REALTIME_REFETCH,
  });
}

export function usePanic(id: string) {
  return useQuery({
    queryKey: qk.panic(id),
    queryFn: ({ signal }) => apiClient().get(`/security/panics/${id}`, { schema: panicDetail, signal }),
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

export function useExpiringDocuments() {
  return useQuery({
    queryKey: qk.expiring,
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/documents/expiring', {
        schema: z.array(expiringDocumentView),
        signal,
      }),
  });
}

export function useDocumentReview() {
  const qc = useQueryClient();
  return useMutation({
    // El bff espera `POST /fleet/documents/:id/review` con `{ decision: 'VALID' | 'REJECTED' }`.
    // La UI habla en approve/reject; acá se traduce al contrato del servidor (que revalida).
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      apiClient().post(`/fleet/documents/${input.id}/review`, {
        body: { decision: input.decision === 'approve' ? 'VALID' : 'REJECTED' },
        schema: fleetDocumentView,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fleet-documents'] });
      void qc.invalidateQueries({ queryKey: qk.expiring });
    },
  });
}

/** Alta de vehículo (operador). El bff/fleet-service revalidan BR-D04 (año mínimo, placa única). */
export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVehicleRequest) => apiClient().post('/fleet/vehicles', { body: input }),
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
    mutationFn: (input: CreateInspectionRequest) => apiClient().post('/fleet/inspections', { body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inspections });
    },
  });
}

/* ── Finanzas ── */
const payoutPage = paginated(payoutView);

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

export function useRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { tripId: string; amountCents: number; reason: string; idempotencyKey: string }) =>
      // El admin-bff expone el reembolso como POST /finance/refunds/:tripId con body {amountCents, reason}.
      apiClient().post(`/finance/refunds/${input.tripId}`, {
        body: { amountCents: input.amountCents, reason: input.reason },
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
    },
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.modeSchedule });
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
    onSuccess: () => {
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
