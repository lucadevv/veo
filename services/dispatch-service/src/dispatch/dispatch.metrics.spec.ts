/**
 * Métricas de elegibilidad: el predicado que decide QUÉ se mide (denominador de la prevalencia) y el
 * cableado de los counters. vitest aísla el módulo por archivo → los counters module-level arrancan en 0.
 */
import { describe, it, expect } from 'vitest';
import { VehicleSegment, FleetDocumentType, type OfferingRequirements } from '@veo/shared-types';
import { metricsRegistry } from '@veo/observability';
import {
  offeringRestrictsByVehicleAttrs,
  classifyMissingAttr,
  bumpEligibilityFailOpen,
  bumpEligibilityTierEvaluation,
  bumpEligibilityTierUnknown,
} from './dispatch.metrics';

/** Lee el valor de un counter del registry por nombre + labels exactos (0 si no hay esa serie aún). */
async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(name) as
    | { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> }
    | undefined;
  if (!metric) return 0;
  const snapshot = await metric.get();
  const match = snapshot.values.find(
    (v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

describe('offeringRestrictsByVehicleAttrs · qué cuenta como tier-gate por attrs (denominador)', () => {
  it('TRUE cuando la oferta exige asientos / segmento / antigüedad', () => {
    expect(offeringRestrictsByVehicleAttrs({ minSeats: 6 })).toBe(true);
    expect(offeringRestrictsByVehicleAttrs({ minSegment: VehicleSegment.MID })).toBe(true);
    expect(offeringRestrictsByVehicleAttrs({ maxAgeYears: 8 })).toBe(true);
  });

  it('FALSE para una oferta SIN requisitos de attrs (no se mide ni cae a fail-open)', () => {
    expect(offeringRestrictsByVehicleAttrs(undefined)).toBe(false);
    expect(offeringRestrictsByVehicleAttrs({})).toBe(false);
  });

  it('FALSE para una vertical CERTS-ONLY (gatea por credencial, no por attrs del vehículo)', () => {
    // Ambulancia: solo exige la cert de operador, ningún attr de vehículo → no tier-gatea por attrs.
    const certsOnly: OfferingRequirements = {
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    };
    expect(offeringRestrictsByVehicleAttrs(certsOnly)).toBe(false);
  });

  it('TRUE si combina certs CON un requisito de attrs (el eje de attrs sí restringe)', () => {
    const both: OfferingRequirements = {
      minSeats: 6,
      certifications: [FleetDocumentType.AMBULANCE_OPERATOR],
    };
    expect(offeringRestrictsByVehicleAttrs(both)).toBe(true);
  });
});

describe('classifyMissingAttr · qué atributo faltó', () => {
  it('clasifica el atributo único ausente', () => {
    expect(classifyMissingAttr({ seats: false, segment: true, year: true })).toBe('seats');
    expect(classifyMissingAttr({ seats: true, segment: false, year: true })).toBe('segment');
    expect(classifyMissingAttr({ seats: true, segment: true, year: false })).toBe('year');
  });
  it('`multiple` cuando falta más de uno', () => {
    expect(classifyMissingAttr({ seats: false, segment: false, year: true })).toBe('multiple');
    expect(classifyMissingAttr({ seats: false, segment: false, year: false })).toBe('multiple');
  });
});

describe('counters de elegibilidad · cableado al registry', () => {
  it('el denominador incrementa por source', async () => {
    expect(await counterValue('dispatch_eligibility_tier_evaluations_total', { source: 'gate' })).toBe(0);
    bumpEligibilityTierEvaluation('gate');
    bumpEligibilityTierEvaluation('gate');
    bumpEligibilityTierEvaluation('pool');
    expect(await counterValue('dispatch_eligibility_tier_evaluations_total', { source: 'gate' })).toBe(2);
    expect(await counterValue('dispatch_eligibility_tier_evaluations_total', { source: 'pool' })).toBe(1);
  });

  it('el numerador (fail-open) incrementa por source + atributo ausente', async () => {
    bumpEligibilityFailOpen('gate', 'seats');
    expect(
      await counterValue('dispatch_eligibility_fail_open_total', { source: 'gate', missing: 'seats' }),
    ).toBe(1);
  });

  it('el tier irresoluble incrementa por razón (absent | unknown)', async () => {
    bumpEligibilityTierUnknown('absent');
    bumpEligibilityTierUnknown('unknown');
    bumpEligibilityTierUnknown('unknown');
    expect(await counterValue('dispatch_eligibility_tier_unknown_total', { reason: 'absent' })).toBe(1);
    expect(await counterValue('dispatch_eligibility_tier_unknown_total', { reason: 'unknown' })).toBe(2);
  });
});
