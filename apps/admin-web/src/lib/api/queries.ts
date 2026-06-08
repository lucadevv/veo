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
  driverApproval,
  expiringDocumentView,
  fleetDocumentView,
  inspectionView,
  mediaAccessRequestView,
  paginated,
  panicDetail,
  panicSummary,
  payoutView,
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
  panics: (status: string) => ['panics', status] as const,
  panic: (id: string) => ['panic', id] as const,
  vehicles: ['vehicles'] as const,
  inspections: ['inspections'] as const,
  expiring: ['fleet-expiring'] as const,
  documents: (status: string) => ['fleet-documents', status] as const,
  payouts: (status: string) => ['payouts', status] as const,
  media: (status: string) => ['media-requests', status] as const,
  audit: ['audit'] as const,
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
      apiClient().get('/trips', {
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
    queryFn: ({ signal }) => apiClient().get(`/trips/${id}`, { schema: tripDetail, signal }),
    enabled: id.length > 0,
  });
}

/* ── Conductores ── */
const driverPage = paginated(driverApproval);

export function useDrivers(status: string) {
  return useQuery({
    queryKey: qk.drivers(status),
    queryFn: ({ signal }) =>
      apiClient().get('/drivers', { schema: driverPage, signal, query: cleanQuery({ status }) }),
  });
}

export function useDriverDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      apiClient().post(`/drivers/${input.id}/${input.decision}`, {
        body: input.reason ? { reason: input.reason } : undefined,
        schema: driverApproval,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drivers'] });
    },
  });
}

/* ── Pánicos ── */
const panicPage = paginated(panicSummary);

export function usePanics(status: string) {
  return useQuery({
    queryKey: qk.panics(status),
    queryFn: ({ signal }) =>
      apiClient().get('/panics', { schema: panicPage, signal, query: cleanQuery({ status }) }),
    refetchInterval: REALTIME_REFETCH,
  });
}

export function usePanic(id: string) {
  return useQuery({
    queryKey: qk.panic(id),
    queryFn: ({ signal }) => apiClient().get(`/panics/${id}`, { schema: panicDetail, signal }),
    enabled: id.length > 0,
  });
}

export function usePanicAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: 'ack' | 'resolve'; notes?: string }) =>
      apiClient().post(`/panics/${input.id}/${input.action}`, {
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

export function useFleetDocuments(status: string) {
  return useQuery({
    queryKey: qk.documents(status),
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/documents', {
        schema: documentPage,
        signal,
        query: cleanQuery({ status }),
      }),
  });
}

export function useVehicles() {
  return useQuery({
    queryKey: qk.vehicles,
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/vehicles', { schema: paginated(vehicleView), signal }),
  });
}

export function useInspections() {
  return useQuery({
    queryKey: qk.inspections,
    queryFn: ({ signal }) =>
      apiClient().get('/fleet/inspections', { schema: paginated(inspectionView), signal }),
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
    mutationFn: (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      apiClient().post(`/fleet/documents/${input.id}/${input.decision}`, {
        body: input.reason ? { reason: input.reason } : undefined,
        schema: fleetDocumentView,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fleet-documents'] });
      void qc.invalidateQueries({ queryKey: qk.expiring });
    },
  });
}

/* ── Finanzas ── */
const payoutPage = paginated(payoutView);

export function usePayouts(status: string) {
  return useQuery({
    queryKey: qk.payouts(status),
    queryFn: ({ signal }) =>
      apiClient().get('/payouts', { schema: payoutPage, signal, query: cleanQuery({ status }) }),
  });
}

export function useRunPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; idempotencyKey: string }) =>
      apiClient().post(`/payouts/${input.id}/run`, {
        schema: payoutView,
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
    mutationFn: (input: { tripId: string; amountCents: number; reason: string; idempotencyKey: string }) =>
      apiClient().post('/payments/refunds', {
        body: { tripId: input.tripId, amountCents: input.amountCents, reason: input.reason },
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
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
    mutationFn: () => apiClient().post('/audit/verify', { schema: auditChainVerification }),
  });
}
