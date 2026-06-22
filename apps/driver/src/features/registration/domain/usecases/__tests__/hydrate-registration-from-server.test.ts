import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import {
  DocumentUploadStatus,
  applyRegistrationHydration,
  buildRegistrationHydrationPlan,
  serverHasAcceptableDoc,
  type PersonalData,
  type RegistrationDocument,
  type RegistrationDocumentType,
  type RegistrationDocumentView,
  type RegistrationHydrationTarget,
} from '../../../domain';

/**
 * GROUND TRUTH del bug: el conductor tiene sus documentos en PENDING_REVIEW del lado del SERVIDOR, pero al
 * reanudar la app el store local de sesión está vacío. La hidratación debe reconstruir el avance desde el
 * server para que NINGÚN paso document-backed se re-pida — el DNI incluido (que era el incoherente).
 */

/** Fabrica un `DriverDocument` del server con un estado/numero dados (resto irrelevante para el plan). */
function serverDoc(
  type: string,
  status: string,
  documentNumber = '',
): RegistrationDocumentView {
  return {
    type,
    documentNumber,
    status,
    // `simpleStatus` no lo usa el plan (deriva del `status` crudo); un valor cualquiera del enum sirve.
    simpleStatus: 'en_revision',
    expiresAt: null,
    ok: status === FleetDocumentStatus.VALID,
    rejectionReason: null,
    images: [],
  };
}

/** Los 5 documentos del alta en PENDING_REVIEW (el escenario exacto del bug confirmado). */
const FIVE_DOCS_PENDING: RegistrationDocumentView[] = [
  serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.PENDING_REVIEW, '70123456'),
  serverDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.PENDING_REVIEW, 'Q12345678'),
  serverDoc(FleetDocumentType.SOAT, FleetDocumentStatus.PENDING_REVIEW, 'POL-9'),
  serverDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.PENDING_REVIEW, 'TARJ-1'),
  serverDoc(FleetDocumentType.VEHICLE_PHOTO, FleetDocumentStatus.VALID),
];

describe('serverHasAcceptableDoc', () => {
  it('true cuando el server tiene el tipo en estado aceptable', () => {
    expect(serverHasAcceptableDoc(FIVE_DOCS_PENDING, 'DNI')).toBe(true);
    expect(serverHasAcceptableDoc(FIVE_DOCS_PENDING, 'LICENSE')).toBe(true);
    expect(serverHasAcceptableDoc(FIVE_DOCS_PENDING, 'VEHICLE_PHOTO')).toBe(true);
  });

  it('false cuando el doc está RECHAZADO o VENCIDO (re-subir)', () => {
    const docs = [serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.REJECTED, '70123456')];
    expect(serverHasAcceptableDoc(docs, 'DNI')).toBe(false);
  });

  it('false cuando el server aún no resolvió (undefined) — el gate local respalda', () => {
    expect(serverHasAcceptableDoc(undefined, 'DNI')).toBe(false);
  });

  it('mapea la etiqueta del wizard al FleetDocumentType canónico (VEHICLE_REGISTRATION → PROPERTY_CARD)', () => {
    expect(serverHasAcceptableDoc(FIVE_DOCS_PENDING, 'VEHICLE_REGISTRATION')).toBe(true);
  });
});

describe('buildRegistrationHydrationPlan', () => {
  it('los 5 docs en PENDING_REVIEW → marca los 5 tipos como subidos + hidrata el DNI', () => {
    const plan = buildRegistrationHydrationPlan(FIVE_DOCS_PENDING);
    expect(plan.uploadedDocTypes.sort()).toEqual(
      (['DNI', 'LICENSE', 'SOAT', 'VEHICLE_REGISTRATION', 'VEHICLE_PHOTO'] as RegistrationDocumentType[]).sort(),
    );
    // El número del DNI sale del `documentNumber` del documento DNI del server (no hay GET de PII).
    expect(plan.dni).toBe('70123456');
  });

  it('un doc rechazado NO se marca como subido', () => {
    const docs = [
      serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.PENDING_REVIEW, '70123456'),
      serverDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.REJECTED, 'Q1'),
    ];
    const plan = buildRegistrationHydrationPlan(docs);
    expect(plan.uploadedDocTypes).toEqual(['DNI']);
    expect(plan.uploadedDocTypes).not.toContain('LICENSE');
  });

  it('DNI sin documentNumber legible → no hidrata el número (degradación honesta)', () => {
    const docs = [serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.PENDING_REVIEW, '   ')];
    expect(buildRegistrationHydrationPlan(docs).dni).toBeNull();
  });

  it('server vacío / undefined → plan vacío', () => {
    expect(buildRegistrationHydrationPlan([])).toEqual({ uploadedDocTypes: [], dni: null });
    expect(buildRegistrationHydrationPlan(undefined)).toEqual({ uploadedDocTypes: [], dni: null });
  });
});

describe('applyRegistrationHydration (no destructivo, idempotente)', () => {
  function makeTarget(
    personal: Partial<PersonalData> = {},
    documents: RegistrationDocument[] = [],
  ): {
    target: RegistrationHydrationTarget;
    setPersonal: jest.Mock;
    setDocumentStatus: jest.Mock;
  } {
    const setPersonal = jest.fn();
    const setDocumentStatus = jest.fn();
    const target: RegistrationHydrationTarget = {
      personal: { fullName: '', dni: '', birthdate: '', ...personal },
      documents,
      setPersonal,
      setDocumentStatus,
    };
    return { target, setPersonal, setDocumentStatus };
  }

  it('reanudar con los 5 docs en PENDING_REVIEW: el DNI NO se re-pide (se hidrata + se marca subido)', () => {
    const { target, setPersonal, setDocumentStatus } = makeTarget();
    const plan = buildRegistrationHydrationPlan(FIVE_DOCS_PENDING);

    const changed = applyRegistrationHydration(plan, target);

    expect(changed).toBe(true);
    // El número del DNI quedó hidratado en el store → el gate `hasReadDni` (server-aware) será true.
    expect(setPersonal).toHaveBeenCalledWith({ dni: '70123456' });
    // Los 5 tipos quedan marcados UPLOADED (DNI incluido) → ningún paso se re-pide.
    const marked = setDocumentStatus.mock.calls.map((c) => c[0] as RegistrationDocumentType).sort();
    expect(marked).toEqual(
      (['DNI', 'LICENSE', 'SOAT', 'VEHICLE_REGISTRATION', 'VEHICLE_PHOTO'] as RegistrationDocumentType[]).sort(),
    );
    expect(setDocumentStatus).toHaveBeenCalledWith('DNI', DocumentUploadStatus.UPLOADED);
  });

  it('NO pisa el DNI que el conductor ya tiene local (no destructivo)', () => {
    const { target, setPersonal } = makeTarget({ dni: '99999999' });
    const plan = buildRegistrationHydrationPlan(FIVE_DOCS_PENDING);
    applyRegistrationHydration(plan, target);
    expect(setPersonal).not.toHaveBeenCalled();
  });

  it('idempotente: no re-marca un doc que el avance local ya tiene UPLOADED', () => {
    const { target, setDocumentStatus } = makeTarget({}, [
      { type: 'DNI', status: DocumentUploadStatus.UPLOADED },
    ]);
    const plan = buildRegistrationHydrationPlan([
      serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.PENDING_REVIEW, '70123456'),
    ]);
    applyRegistrationHydration(plan, target);
    expect(setDocumentStatus).not.toHaveBeenCalledWith('DNI', DocumentUploadStatus.UPLOADED);
  });

  it('plan vacío → no aplica cambios', () => {
    const { target, setPersonal, setDocumentStatus } = makeTarget();
    const changed = applyRegistrationHydration({ uploadedDocTypes: [], dni: null }, target);
    expect(changed).toBe(false);
    expect(setPersonal).not.toHaveBeenCalled();
    expect(setDocumentStatus).not.toHaveBeenCalled();
  });
});
