/**
 * Métricas 30d por-oferta (página-detalle del catálogo admin · board HjDvx). Se MOCKEA EL REPO (puerto
 * TRIP_STATS_REPO): el COHORTE de la agregación (category = offeringId, status=COMPLETED, completedAt >= since,
 * count + Σ fareCents en UNA query) es un INVARIANTE del repo; acá se verifica la LÓGICA del service — la
 * VENTANA de 30 días (since = now − 30d), el passthrough del cohorte, y la degradación HONESTA (0 sin viajes,
 * jamás dato inventado). El offeringId ya viene validado por el DTO del controller.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AnalyticsService,
  OFFERING_METRICS_WINDOW_DAYS,
  type OfferingMetrics,
} from './analytics.service';
import type { OfferingWindowMetrics, TripStatsRepository } from './analytics.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Repo fake: captura los args de `offeringMetricsSince` y devuelve el cohorte configurado. */
function buildService(windowMetrics: OfferingWindowMetrics) {
  const offeringMetricsSince = vi.fn(async (_category: string, _since: Date) => windowMetrics);
  const repo = { offeringMetricsSince } as unknown as TripStatsRepository;
  return { svc: new AnalyticsService(repo), offeringMetricsSince };
}

describe('AnalyticsService.getOfferingMetrics · ventana 30d', () => {
  it('consulta el cohorte con la category pedida y since = now − 30 días', async () => {
    const { svc, offeringMetricsSince } = buildService({ tripCount: 12, grossFareCents: 480_00 });
    const now = new Date('2026-07-12T10:00:00.000Z');

    await svc.getOfferingMetrics('veo_mechanic', now);

    expect(offeringMetricsSince).toHaveBeenCalledTimes(1);
    const [category, since] = offeringMetricsSince.mock.calls[0]!;
    expect(category).toBe('veo_mechanic');
    // La ventana es EXACTAMENTE 30 días naturales hacia atrás desde `now`.
    expect((since as Date).getTime()).toBe(now.getTime() - OFFERING_METRICS_WINDOW_DAYS * DAY_MS);
  });

  it('compone la vista: offeringId + windowDays=30 + los hechos del repo (viajes + bruto)', async () => {
    const { svc } = buildService({ tripCount: 148, grossFareCents: 520_000 });

    const out: OfferingMetrics = await svc.getOfferingMetrics('veo_economico');

    expect(out).toEqual({
      offeringId: 'veo_economico',
      windowDays: 30,
      tripCount: 148,
      grossFareCents: 520_000,
    });
  });

  it('degradación honesta: sin viajes en la ventana → 0 viajes y 0 bruto (nunca inventa)', async () => {
    const { svc } = buildService({ tripCount: 0, grossFareCents: 0 });

    const out = await svc.getOfferingMetrics('veo_tow');

    expect(out.tripCount).toBe(0);
    expect(out.grossFareCents).toBe(0);
    expect(out.windowDays).toBe(30);
  });
});
