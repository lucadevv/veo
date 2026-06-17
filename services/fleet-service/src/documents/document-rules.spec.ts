import { describe, it, expect } from 'vitest';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import {
  deriveExpiryStatus,
  dueExpiryMilestone,
  computeExpiryAlert,
  shouldSuspendDriver,
  isCriticalDocument,
  isCertification,
  validCertificationsOf,
  daysUntilCeil,
} from './document-rules';

const NOW = new Date('2026-05-28T12:00:00.000Z');
const DAY = 86_400_000;
const inDays = (n: number): Date => new Date(NOW.getTime() + n * DAY);

describe('deriveExpiryStatus (BR-I04 — estado por vencimiento)', () => {
  it('sin expiresAt → VALID (p.ej. antecedentes aprobados)', () => {
    expect(deriveExpiryStatus(null, NOW)).toBe(FleetDocumentStatus.VALID);
    expect(deriveExpiryStatus(undefined, NOW)).toBe(FleetDocumentStatus.VALID);
  });

  it('frontera 30 días: exactamente 30 → EXPIRING_SOON', () => {
    expect(deriveExpiryStatus(inDays(30), NOW)).toBe(FleetDocumentStatus.EXPIRING_SOON);
  });

  it('31 días → VALID (fuera de la ventana de 30)', () => {
    expect(deriveExpiryStatus(inDays(31), NOW)).toBe(FleetDocumentStatus.VALID);
  });

  it('dentro de la ventana (1..29 días) → EXPIRING_SOON', () => {
    expect(deriveExpiryStatus(inDays(15), NOW)).toBe(FleetDocumentStatus.EXPIRING_SOON);
    expect(deriveExpiryStatus(inDays(1), NOW)).toBe(FleetDocumentStatus.EXPIRING_SOON);
  });

  it('frontera 0 días: vence hoy (aún no pasa) → EXPIRING_SOON', () => {
    expect(deriveExpiryStatus(NOW, NOW)).toBe(FleetDocumentStatus.EXPIRING_SOON);
  });

  it('ya pasó (instante anterior) → EXPIRED', () => {
    expect(deriveExpiryStatus(inDays(-0.001), NOW)).toBe(FleetDocumentStatus.EXPIRED);
    expect(deriveExpiryStatus(inDays(-1), NOW)).toBe(FleetDocumentStatus.EXPIRED);
  });

  it('respeta un warningDays distinto (p.ej. 60)', () => {
    expect(deriveExpiryStatus(inDays(45), NOW, 60)).toBe(FleetDocumentStatus.EXPIRING_SOON);
    expect(deriveExpiryStatus(inDays(61), NOW, 60)).toBe(FleetDocumentStatus.VALID);
  });
});

describe('dueExpiryMilestone / computeExpiryAlert (BR-I04 — alertas 30/15/7/1)', () => {
  const MILESTONES = [30, 15, 7, 1];

  it('alcanza el hito 30 con 30 días restantes', () => {
    expect(dueExpiryMilestone(30, MILESTONES)).toBe(30);
  });

  it('entre 16 y 30 días el hito vigente sigue siendo 30', () => {
    expect(dueExpiryMilestone(20, MILESTONES)).toBe(30);
    expect(dueExpiryMilestone(16, MILESTONES)).toBe(30);
  });

  it('15/7/1 días → hito 15/7/1', () => {
    expect(dueExpiryMilestone(15, MILESTONES)).toBe(15);
    expect(dueExpiryMilestone(7, MILESTONES)).toBe(7);
    expect(dueExpiryMilestone(1, MILESTONES)).toBe(1);
  });

  it('más de 30 días o ya vencido → sin hito', () => {
    expect(dueExpiryMilestone(31, MILESTONES)).toBeNull();
    expect(dueExpiryMilestone(0, MILESTONES)).toBeNull();
    expect(dueExpiryMilestone(-3, MILESTONES)).toBeNull();
  });

  it('emite cada hito una sola vez (memoriza alreadyAlertedDays)', () => {
    // Primer cruce a 30 días: alerta 30.
    expect(
      computeExpiryAlert({ expiresAt: inDays(30), now: NOW, milestones: MILESTONES, alreadyAlertedDays: null }),
    ).toBe(30);
    // Mismo hito 30 ya alertado: no repite.
    expect(
      computeExpiryAlert({ expiresAt: inDays(28), now: NOW, milestones: MILESTONES, alreadyAlertedDays: 30 }),
    ).toBeNull();
    // Cruza a 15: nueva alerta 15.
    expect(
      computeExpiryAlert({ expiresAt: inDays(15), now: NOW, milestones: MILESTONES, alreadyAlertedDays: 30 }),
    ).toBe(15);
    // Cruza a 1: nueva alerta 1.
    expect(
      computeExpiryAlert({ expiresAt: inDays(1), now: NOW, milestones: MILESTONES, alreadyAlertedDays: 7 }),
    ).toBe(1);
  });

  it('sin expiresAt → sin alerta', () => {
    expect(
      computeExpiryAlert({ expiresAt: null, now: NOW, milestones: MILESTONES, alreadyAlertedDays: null }),
    ).toBeNull();
  });

  it('daysUntilCeil redondea hacia arriba dentro del día', () => {
    expect(daysUntilCeil(inDays(29.4), NOW)).toBe(30);
  });
});

describe('shouldSuspendDriver / isCriticalDocument (BR-I04 — suspensión)', () => {
  it('Licencia A1, SOAT y Tarjeta de propiedad son críticos; ITV y antecedentes no', () => {
    expect(isCriticalDocument(FleetDocumentType.LICENSE_A1)).toBe(true);
    expect(isCriticalDocument(FleetDocumentType.SOAT)).toBe(true);
    expect(isCriticalDocument(FleetDocumentType.PROPERTY_CARD)).toBe(true);
    expect(isCriticalDocument(FleetDocumentType.ITV)).toBe(false);
    expect(isCriticalDocument(FleetDocumentType.BACKGROUND_CHECK)).toBe(false);
  });

  it('suspende si un documento crítico está EXPIRED', () => {
    expect(
      shouldSuspendDriver([
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
        { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.EXPIRED },
      ]),
    ).toBe(true);
  });

  it('NO suspende si sólo un documento NO crítico (ITV) está EXPIRED', () => {
    expect(
      shouldSuspendDriver([
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
        { type: FleetDocumentType.ITV, status: FleetDocumentStatus.EXPIRED },
      ]),
    ).toBe(false);
  });

  it('NO suspende si todos los críticos están vigentes', () => {
    expect(
      shouldSuspendDriver([
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
        { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.EXPIRING_SOON },
        { type: FleetDocumentType.PROPERTY_CARD, status: FleetDocumentStatus.VALID },
      ]),
    ).toBe(false);
  });

  it('una certificación de vertical EXPIRED NO suspende al conductor (no es crítica · B5-3.2)', () => {
    expect(isCertification(FleetDocumentType.AMBULANCE_OPERATOR)).toBe(true);
    expect(isCriticalDocument(FleetDocumentType.AMBULANCE_OPERATOR)).toBe(false);
    expect(
      shouldSuspendDriver([
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
        { type: FleetDocumentType.AMBULANCE_OPERATOR, status: FleetDocumentStatus.EXPIRED },
      ]),
    ).toBe(false);
  });
});

describe('validCertificationsOf (B5-3.2 — certs vigentes del conductor para dispatch)', () => {
  it('destila SOLO las certs de vertical en estado vigente (VALID/EXPIRING_SOON)', () => {
    const certs = validCertificationsOf([
      { type: FleetDocumentType.AMBULANCE_OPERATOR, status: FleetDocumentStatus.VALID },
      { type: FleetDocumentType.TOW_OPERATOR, status: FleetDocumentStatus.EXPIRING_SOON },
      { type: FleetDocumentType.MECHANIC_CERT, status: FleetDocumentStatus.EXPIRED }, // vencida → fuera
    ]);
    expect(certs).toEqual([FleetDocumentType.AMBULANCE_OPERATOR, FleetDocumentType.TOW_OPERATOR]);
  });

  it('EXCLUYE los docs base (licencia/SOAT) aunque estén vigentes — solo viajan certs de vertical', () => {
    const certs = validCertificationsOf([
      { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
      { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.VALID },
      { type: FleetDocumentType.AMBULANCE_OPERATOR, status: FleetDocumentStatus.VALID },
    ]);
    expect(certs).toEqual([FleetDocumentType.AMBULANCE_OPERATOR]);
  });

  it('una cert PENDING_REVIEW o REJECTED NO cuenta como válida (fail-closed aguas abajo)', () => {
    expect(
      validCertificationsOf([
        { type: FleetDocumentType.AMBULANCE_OPERATOR, status: FleetDocumentStatus.PENDING_REVIEW },
        { type: FleetDocumentType.TOW_OPERATOR, status: FleetDocumentStatus.REJECTED },
      ]),
    ).toEqual([]);
  });

  it('conductor sin certs → lista vacía', () => {
    expect(validCertificationsOf([])).toEqual([]);
  });
});
