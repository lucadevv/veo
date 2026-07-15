import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import type { DriverProfileView } from '@veo/api-client';
import { mapProfileToRegistrationStatus } from '../map-registration-status';

/** Los 3 documentos que el conductor sube en el alta (licencia, SOAT, tarjeta de propiedad). */
const REQUIRED = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
];

type DocSpec = { type: string; status: string };

/**
 * Construye un perfil con la MISMA derivación de compliance que el driver-bff
 * (`buildDriverProfile`), para que el gate se pruebe contra shapes reales (presencia/aprobado/rechazo),
 * no contra flags inventados a mano.
 */
function profile(opts: {
  kycStatus: string;
  backgroundCheckStatus: string;
  docs: DocSpec[];
  /**
   * ¿El conductor enroló su biometría facial? Eje SEPARADO de los documentos. Default `true` para que
   * los casos "envió todo" lleguen a `in_review` sin ruido; los tests del gate biométrico lo setean
   * explícito a `false`.
   */
  biometricEnrolled?: boolean;
}): DriverProfileView {
  const documents = opts.docs.map((d) => ({
    type: d.type,
    status: d.status,
    expiresAt: null,
    ok: d.status === FleetDocumentStatus.VALID || d.status === FleetDocumentStatus.EXPIRING_SOON,
  }));
  const docFor = (type: string) => documents.find((d) => d.type === type);
  const missing = REQUIRED.filter((t) => docFor(t) === undefined);
  const rejected = REQUIRED.filter((t) => docFor(t)?.status === FleetDocumentStatus.REJECTED);
  const submittedAllRequired = missing.length === 0;
  const allApproved = REQUIRED.every((t) => docFor(t)?.ok === true);

  return {
    driverId: 'drv-1',
    userId: 'usr-1',
    phone: '+51987654321',
    kycStatus: opts.kycStatus,
    currentStatus: 'OFFLINE',
    backgroundCheckStatus: opts.backgroundCheckStatus,
    rejectionReason: null,
    averageRating: 4.8,
    rating: null,
    documents,
    compliance: {
      compliant: allApproved,
      requiredTypes: REQUIRED,
      missing,
      rejected,
      submittedAllRequired,
      allApproved,
      biometricEnrolled: opts.biometricEnrolled ?? true,
    },
  };
}

const allDocs = (status: string): DocSpec[] => REQUIRED.map((type) => ({ type, status }));

describe('mapProfileToRegistrationStatus', () => {
  it('BUG P0: 3 docs PENDING_REVIEW + antecedentes PENDING ⇒ in_review (no wizard)', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'PENDING',
      docs: allDocs(FleetDocumentStatus.PENDING_REVIEW),
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('in_review');
  });

  it('falta SUBIR un documento requerido ⇒ not_started (wizard)', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'PENDING',
      docs: [
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.PENDING_REVIEW },
        { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.PENDING_REVIEW },
        // falta PROPERTY_CARD
      ],
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('not_started');
  });

  it('todos aprobados + KYC verificado + antecedentes CLEARED ⇒ approved', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'CLEARED',
      docs: allDocs(FleetDocumentStatus.VALID),
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('approved');
  });

  it('docs aprobados pero antecedentes aún PENDING ⇒ in_review (no aprobado todavía)', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'PENDING',
      docs: allDocs(FleetDocumentStatus.VALID),
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('in_review');
  });

  it('antecedentes REJECTED ⇒ rejected', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'REJECTED',
      docs: allDocs(FleetDocumentStatus.VALID),
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('rejected');
  });

  it('un documento requerido REJECTED ⇒ rejected (corregir-y-reenviar), aunque el resto esté OK', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'CLEARED',
      docs: [
        { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
        { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.REJECTED },
        { type: FleetDocumentType.PROPERTY_CARD, status: FleetDocumentStatus.VALID },
      ],
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('rejected');
  });

  it('GATE BIOMÉTRICO: docs completos pero biometricEnrolled=false ⇒ NO in_review (in_progress, vuelve al wizard KYC)', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'PENDING',
      docs: allDocs(FleetDocumentStatus.PENDING_REVIEW),
      biometricEnrolled: false,
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('in_progress');
  });

  it('GATE BIOMÉTRICO: docs completos + biometricEnrolled=true ⇒ in_review', () => {
    const p = profile({
      kycStatus: 'VERIFIED',
      backgroundCheckStatus: 'PENDING',
      docs: allDocs(FleetDocumentStatus.PENDING_REVIEW),
      biometricEnrolled: true,
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('in_review');
  });

  it('KYC rechazado ⇒ rejected aunque los documentos estén enviados', () => {
    const p = profile({
      kycStatus: 'REJECTED',
      backgroundCheckStatus: 'PENDING',
      docs: allDocs(FleetDocumentStatus.PENDING_REVIEW),
    });
    expect(mapProfileToRegistrationStatus(p)).toBe('rejected');
  });
});
