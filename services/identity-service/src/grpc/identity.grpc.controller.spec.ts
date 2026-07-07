/**
 * Spec del controlador gRPC de identity — foco en la REGRESIÓN del cifrado del DNI:
 *   1) El BATCH/lista (GetDriversByIds) NO descifra el DNI (campo vacío) y NO lanza aunque una fila tenga
 *      `documentIdEnc` corrupto — un blob roto no puede tumbar la página entera de conductores del admin.
 *   2) El GetDriver single SÍ devuelve el DNI descifrado correcto (detalle Compliance+).
 *   3) El descifrado del single va con GUARDA: ante un ciphertext inválido devuelve '' y no lanza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  grpcIdentityMetadata,
  InternalAudience,
  type AuthenticatedUser,
  type InternalAudience as InternalAudienceType,
} from '@veo/auth';
import { DniFaceMatchStatus } from '@veo/shared-types';
import { IdentityGrpcController } from './identity.grpc.controller';
import { seal } from '../common/secret-box';
import type { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

const INTERNAL_IDENTITY_SECRET = 's'.repeat(32);
const DRIVER_DNI_ENC_KEY = 'k'.repeat(32);

const ADMIN: AuthenticatedUser = {
  userId: 'op-1',
  type: 'admin',
  roles: ['COMPLIANCE_SUPERVISOR'],
  sessionId: 'sess-1',
};

/** Metadata gRPC entrante FIRMADA con el riel `aud` indicado (default admin-rail). */
function signedMetaAs(aud: InternalAudienceType = InternalAudience.ADMIN_RAIL): Metadata {
  const meta = new Metadata();
  const headers = grpcIdentityMetadata(ADMIN, INTERNAL_IDENTITY_SECRET, aud);
  for (const [k, v] of Object.entries(headers)) meta.set(k, v);
  return meta;
}

/** Alias del happy-path admin-rail usado por los tests de cifrado del DNI. */
function signedMeta(): Metadata {
  return signedMetaAs(InternalAudience.ADMIN_RAIL);
}

const baseDriverRow = {
  id: 'd1',
  userId: 'u1',
  currentStatus: 'AVAILABLE',
  backgroundCheckStatus: 'CLEARED',
  averageRating: { toString: () => '4.8' },
  suspendedAt: null,
  legalName: 'Juana Pérez',
  rejectionReason: null,
  licenseNumber: 'A1-123',
  documentIdEnc: null as string | null,
  birthDate: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  faceEnrolledAt: null,
  lastVerifiedAt: null,
  dniFaceMatched: null,
  dniFaceMatchScore: null,
  dniFaceMatchedAt: null,
  user: { name: 'Juana', kycStatus: 'VERIFIED', phone: '+51999' },
};

/** Driver con un `documentIdEnc` que NO es un ciphertext válido (formato roto → `open` lanza). */
const CORRUPT_ENC = 'esto-no-es-un-secreto-sellado-valido';

function makeController(opts: {
  findUnique?: () => unknown;
  findMany?: () => unknown[];
}): IdentityGrpcController {
  const prisma = {
    read: {
      driver: {
        findUnique: vi.fn(opts.findUnique ?? (() => null)),
        findMany: vi.fn(opts.findMany ?? (() => [])),
      },
    },
  } as unknown as PrismaService;
  const config = new ConfigService<Env, true>({
    INTERNAL_IDENTITY_SECRET,
    DRIVER_DNI_ENC_KEY,
  } as unknown as Env);
  return new IdentityGrpcController(prisma, config);
}

/** Extrae el `code` del error gRPC envuelto en RpcException (la forma `{ code, message }`). */
function grpcCodeOf(err: unknown): number | undefined {
  if (err instanceof RpcException) {
    const e = err.getError();
    if (typeof e === 'object' && e !== null && 'code' in e) {
      return (e as { code: number }).code;
    }
  }
  return undefined;
}

describe('IdentityGrpcController · cifrado del DNI (regresión disponibilidad)', () => {
  beforeEach(() => {
    // Silencia el warn de degradación para no ensuciar la salida del runner.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('CASO 1 · batch NO descifra el DNI y NO lanza aunque una fila tenga ciphertext corrupto', async () => {
    // Una fila con DNI válido + una fila con DNI CORRUPTO en la misma página (el caso adversarial que
    // tumbaba la lista entera). El batch debe completar y entregar AMBAS con documentId vacío.
    const ctrl = makeController({
      findMany: () => [
        { ...baseDriverRow, id: 'd1', documentIdEnc: seal('12345678', DRIVER_DNI_ENC_KEY) },
        { ...baseDriverRow, id: 'd2', documentIdEnc: CORRUPT_ENC },
      ],
    });

    const reply = await ctrl.getDriversByIds({ ids: ['d1', 'd2'] }, signedMeta());

    expect(reply.drivers).toHaveLength(2);
    // NO se descifra en el batch: documentId vacío incluso con un ciphertext PERFECTAMENTE válido.
    expect(reply.drivers.every((d) => d.documentId === '')).toBe(true);
    // Y la fila corrupta NO tumbó la página: ambas vienen con sus datos no-PII intactos.
    expect(reply.drivers.map((d) => d.name)).toEqual(['Juana Pérez', 'Juana Pérez']);
  });

  it('CASO 2 · GetDriver single SÍ devuelve el DNI descifrado correcto', async () => {
    const plaintextDni = '76543210';
    const ctrl = makeController({
      findUnique: () => ({
        ...baseDriverRow,
        documentIdEnc: seal(plaintextDni, DRIVER_DNI_ENC_KEY),
      }),
    });

    const reply = await ctrl.getDriver({ id: 'd1' }, signedMeta());

    expect(reply.found).toBe(true);
    expect(reply.documentId).toBe(plaintextDni);
  });

  it('CASO 3 · guarda: el single ante un ciphertext inválido devuelve "" y NO lanza', async () => {
    const ctrl = makeController({
      findUnique: () => ({ ...baseDriverRow, documentIdEnc: CORRUPT_ENC }),
    });

    const reply = await ctrl.getDriver({ id: 'd1' }, signedMeta());

    // Degradación honesta: el blob corrupto NO tira un 500 — el campo queda vacío y el resto del detalle vive.
    expect(reply.found).toBe(true);
    expect(reply.documentId).toBe('');
    expect(reply.name).toBe('Juana Pérez');
  });
});

describe('IdentityGrpcController · scoping por RIEL (cross-rail / confused-deputy H7)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('GetDriversByIds · admin-rail (riel PERMITIDO) pasa', async () => {
    const ctrl = makeController({ findMany: () => [] });
    const reply = await ctrl.getDriversByIds(
      { ids: [] },
      signedMetaAs(InternalAudience.ADMIN_RAIL),
    );
    expect(reply.drivers).toEqual([]);
  });

  it('GetDriversByIds · service-rail (riel PERMITIDO · booking enriquece la búsqueda F2) pasa', async () => {
    const ctrl = makeController({ findMany: () => [{ ...baseDriverRow }] });
    const reply = await ctrl.getDriversByIds(
      { ids: ['d1'] },
      signedMetaAs(InternalAudience.SERVICE_RAIL),
    );
    expect(reply.drivers).toHaveLength(1);
    expect(reply.drivers[0]!.found).toBe(true);
    // Minimización 5b intacta: el batch NUNCA descifra el DNI, ni siquiera para un riel permitido.
    expect(reply.drivers[0]!.documentId).toBe('');
  });

  it('GetDriversByIds · driver-rail (riel NO permitido) → PERMISSION_DENIED', async () => {
    const ctrl = makeController({ findMany: () => [] });
    try {
      await ctrl.getDriversByIds({ ids: [] }, signedMetaAs(InternalAudience.DRIVER_RAIL));
      expect.unreachable('debió rechazar el driver-rail');
    } catch (err) {
      expect(grpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
    }
  });

  it('GetDriversByIds · public-rail (riel NO permitido · mínimo privilegio) → PERMISSION_DENIED', async () => {
    const ctrl = makeController({ findMany: () => [] });
    try {
      await ctrl.getDriversByIds({ ids: [] }, signedMetaAs(InternalAudience.PUBLIC_RAIL));
      expect.unreachable('debió rechazar el public-rail');
    } catch (err) {
      expect(grpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
    }
  });

  it('GetDriverByUser · driver-rail (riel PERMITIDO · driver-bff: su propio perfil) pasa', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow }) });
    const reply = await ctrl.getDriverByUser(
      { id: 'u1' },
      signedMetaAs(InternalAudience.DRIVER_RAIL),
    );
    expect(reply.found).toBe(true);
  });

  it('GetDriverByUser · service-rail (PERMITIDO · dispatch resuelve User.id→Driver.id en la exclusión ITV) pasa', async () => {
    // Regresión del audience mismatch de Lote 2b: dispatch firma service-rail; sin este riel la vía ITV
    // del eje fleet caía PERMISSION_DENIED → exclusión inerte + crash-loop de la partición fleet.
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow }) });
    const reply = await ctrl.getDriverByUser(
      { id: 'u1' },
      signedMetaAs(InternalAudience.SERVICE_RAIL),
    );
    expect(reply.found).toBe(true);
  });

  it('GetDriverByUser · admin-rail (riel NO permitido) → PERMISSION_DENIED', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow }) });
    try {
      await ctrl.getDriverByUser({ id: 'u1' }, signedMetaAs(InternalAudience.ADMIN_RAIL));
      expect.unreachable('debió rechazar el admin-rail en GetDriverByUser');
    } catch (err) {
      expect(grpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
    }
  });

  it('GetUser · public-rail (riel PERMITIDO) pasa', async () => {
    const prisma = {
      read: { user: { findUnique: vi.fn(() => null) } },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({
      INTERNAL_IDENTITY_SECRET,
      DRIVER_DNI_ENC_KEY,
    } as unknown as Env);
    const ctrl = new IdentityGrpcController(prisma, config);
    const reply = await ctrl.getUser({ id: 'x' }, signedMetaAs(InternalAudience.PUBLIC_RAIL));
    expect(reply.found).toBe(false);
  });

  it('GetUser · service-rail (riel NO permitido) → PERMISSION_DENIED', async () => {
    const ctrl = makeController({});
    try {
      await ctrl.getUser({ id: 'x' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
      expect.unreachable('debió rechazar el service-rail en GetUser');
    } catch (err) {
      expect(grpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
    }
  });

  it('GetDriver · service-rail (riel PERMITIDO) pasa', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow }) });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
    expect(reply.found).toBe(true);
  });
});

describe('IdentityGrpcController · minimización de PII por RIEL en GetDriver (H8)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  /** Fila con TODA la PII sensible poblada — para probar el gating por riel campo por campo. */
  const piiDriverRow = {
    ...baseDriverRow,
    licenseNumber: 'A1-123',
    documentIdEnc: seal('76543210', DRIVER_DNI_ENC_KEY),
    birthDate: new Date('1990-05-20T00:00:00.000Z'),
    faceEnrolledAt: new Date('2026-02-01T10:00:00.000Z'),
    lastVerifiedAt: new Date('2026-03-01T11:00:00.000Z'),
    dniFaceMatched: true,
    dniFaceMatchScore: 92,
    dniFaceMatchedAt: new Date('2026-02-15T09:00:00.000Z'),
  };

  it('admin-rail · recibe TODA la PII sensible (DNI descifrado + licencia + fecha-nac + biometría)', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...piiDriverRow }) });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMetaAs(InternalAudience.ADMIN_RAIL));

    expect(reply.found).toBe(true);
    // DNI descifrado real (Compliance+ valida a ojo).
    expect(reply.documentId).toBe('76543210');
    expect(reply.licenseNumber).toBe('A1-123');
    expect(reply.birthDate).toBe('1990-05-20');
    expect(reply.faceEnrolledAt).not.toBe('');
    expect(reply.lastVerifiedAt).not.toBe('');
    expect(reply.dniFaceMatchStatus).toBe(DniFaceMatchStatus.MATCHED);
    expect(reply.dniFaceMatchScore).toBe(92);
    expect(reply.dniFaceMatchedAt).not.toBe('');
    // Y los datos que el pasajero también ve siguen presentes (no rompimos el wiring vivo).
    expect(reply.name).toBe('Juana Pérez');
  });

  it('public-rail · NO recibe la PII sensible (DNI/licencia/fecha-nac/binding vacíos) pero SÍ name/status/rating + timestamps de enrollment', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...piiDriverRow }) });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMetaAs(InternalAudience.PUBLIC_RAIL));

    expect(reply.found).toBe(true);
    // PII sensible gateada (fuga cross-rail H8 cerrada): el DNI ni se descifra.
    expect(reply.documentId).toBe('');
    expect(reply.licenseNumber).toBe('');
    expect(reply.birthDate).toBe('');
    // El binding DNI↔selfie sí es señal del proceso KYC sensible → gateado admin-only.
    expect(reply.dniFaceMatchStatus).toBe(DniFaceMatchStatus.NOT_RUN);
    expect(reply.dniFaceMatchScore).toBe(0);
    expect(reply.dniFaceMatchedAt).toBe('');
    // Los timestamps de ESTADO de enrollment/verificación NO son PII sensible → INCONDICIONAL (todos los
    // rieles). Al pasajero no le hacen daño ("verificado el X") y el driver-bff los necesita en su rail.
    expect(reply.faceEnrolledAt).not.toBe('');
    expect(reply.lastVerifiedAt).not.toBe('');
    // Lo que el PASAJERO sí consume (trips/share/enrichment) sigue presente — NO se rompió el wiring vivo.
    expect(reply.name).toBe('Juana Pérez');
    expect(reply.userId).toBe('u1');
    expect(reply.currentStatus).toBe('AVAILABLE');
    expect(reply.backgroundCheckStatus).toBe('CLEARED');
    expect(reply.averageRating).toBe(4.8);
  });

  it('service-rail · NO recibe la PII sensible pero SÍ los campos de elegibilidad (dispatch) + timestamps de enrollment', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...piiDriverRow }) });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMetaAs(InternalAudience.SERVICE_RAIL));

    expect(reply.found).toBe(true);
    expect(reply.documentId).toBe('');
    expect(reply.licenseNumber).toBe('');
    expect(reply.birthDate).toBe('');
    expect(reply.dniFaceMatchStatus).toBe(DniFaceMatchStatus.NOT_RUN);
    expect(reply.dniFaceMatchScore).toBe(0);
    expect(reply.dniFaceMatchedAt).toBe('');
    // Timestamps de enrollment/verificación: INCONDICIONAL (no PII sensible).
    expect(reply.faceEnrolledAt).not.toBe('');
    expect(reply.lastVerifiedAt).not.toBe('');
    // Lo que dispatch consume para re-validar elegibilidad sigue presente.
    expect(reply.id).toBe('d1');
    expect(reply.userId).toBe('u1');
    expect(reply.currentStatus).toBe('AVAILABLE');
    expect(reply.suspendedAt).toBe('');
  });

  it('firma ausente → UNAUTHENTICATED (distinto de PERMISSION_DENIED)', async () => {
    const ctrl = makeController({});
    try {
      await ctrl.getUser({ id: 'x' }, new Metadata());
      expect.unreachable('debió rechazar la metadata sin firma');
    } catch (err) {
      expect(grpcCodeOf(err)).toBe(GrpcStatus.UNAUTHENTICATED);
    }
  });
});

/**
 * ANTI-REGRESIÓN del onboarding del conductor (lote 5b sobre-gateó el ESTADO de enrollment).
 * `GetDriverByUser` es el driver-rail: el conductor leyendo SU PROPIO record. El driver-bff deriva
 * `biometricEnrolled = faceEnrolledAt.length > 0` (drivers.mapper.ts), que compone el gate `in_review`
 * del onboarding. Si `faceEnrolledAt` viene gateado admin-only → llega '' SIEMPRE en el driver-rail →
 * `biometricEnrolled=false` aunque el conductor SÍ enroló → trabado en el onboarding.
 *
 * Este test FALLA con el código de 5b (faceEnrolledAt bajo includeSensitivePii → '' para driver-rail) y
 * PASA con el fix (faceEnrolledAt incondicional).
 */
describe('IdentityGrpcController · GetDriverByUser (driver-rail) emite el estado de enrollment para el onboarding', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const enrolledDriverRow = {
    ...baseDriverRow,
    // El conductor SÍ enroló su rostro y verificó en vivo.
    faceEnrolledAt: new Date('2026-02-01T10:00:00.000Z'),
    lastVerifiedAt: new Date('2026-03-01T11:00:00.000Z'),
    // ...y tiene PII sensible poblada, que el driver-rail NO debe ver.
    documentIdEnc: seal('76543210', DRIVER_DNI_ENC_KEY),
    licenseNumber: 'A1-123',
    birthDate: new Date('1990-05-20T00:00:00.000Z'),
  };

  it('faceEnrolledAt/lastVerifiedAt presentes en driver-rail → el gate biometricEnrolled del onboarding funciona', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...enrolledDriverRow }) });
    const reply = await ctrl.getDriverByUser(
      { id: 'u1' },
      signedMetaAs(InternalAudience.DRIVER_RAIL),
    );

    expect(reply.found).toBe(true);
    // El núcleo de la regresión: el ESTADO de enrollment llega al conductor (no vacío) en SU propio rail.
    expect(reply.faceEnrolledAt).toBe('2026-02-01T10:00:00.000Z');
    expect(reply.lastVerifiedAt).toBe('2026-03-01T11:00:00.000Z');
    // Espeja el gate del driver-bff (drivers.mapper.ts): biometricEnrolled = faceEnrolledAt.length > 0.
    expect(reply.faceEnrolledAt.length > 0).toBe(true);
  });

  it('driver-rail NO recibe la PII sensible (DNI/licencia/fecha-nac/binding) — H8 intacto para el propio conductor', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...enrolledDriverRow }) });
    const reply = await ctrl.getDriverByUser(
      { id: 'u1' },
      signedMetaAs(InternalAudience.DRIVER_RAIL),
    );

    // El conductor NO necesita su DNI/licencia/fecha-nac descifrados en este reply (los edita por REST,
    // no los lee de acá): siguen gateados admin-only. El DNI ni se descifra para el driver-rail.
    expect(reply.documentId).toBe('');
    expect(reply.licenseNumber).toBe('');
    expect(reply.birthDate).toBe('');
    expect(reply.dniFaceMatchStatus).toBe(DniFaceMatchStatus.NOT_RUN);
    expect(reply.dniFaceMatchScore).toBe(0);
    expect(reply.dniFaceMatchedAt).toBe('');
  });
});

/**
 * FIX 3 (habilitar UI de reactivación) — `GetDriver` EXPONE las CAUSAS ACTIVAS de la suspensión (modelo de
 * HOLDS) en `suspensionCauses[]`. El admin-bff las usa para distinguir DISCIPLINARY (→ /reactivate) de
 * DOCUMENT_EXPIRED/INSPECTION_EXPIRED (→ /reactivate-compliance). `suspendedAt` (flag derivado) se mantiene;
 * esto añade el PORQUÉ. Un conductor con varias causas las muestra TODAS (dedup por `cause` distinta).
 */
describe('IdentityGrpcController · GetDriver expone las CAUSAS de suspensión (FIX 3 · habilita la UI de reactivación)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('GetDriver incluye los holds en el query (include suspensionHolds: select cause)', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow, suspensionHolds: [] }) });
    const prismaFindUnique = (
      ctrl as unknown as { prisma: { read: { driver: { findUnique: ReturnType<typeof vi.fn> } } } }
    ).prisma.read.driver.findUnique;

    await ctrl.getDriver({ id: 'd1' }, signedMeta());

    expect(prismaFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          suspensionHolds: { select: { cause: true } },
        }),
      }),
    );
  });

  it('conductor con UNA causa (INSPECTION_EXPIRED) → suspensionCauses = ["INSPECTION_EXPIRED"]', async () => {
    const ctrl = makeController({
      findUnique: () => ({
        ...baseDriverRow,
        suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
        suspensionHolds: [{ cause: 'INSPECTION_EXPIRED' }],
      }),
    });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMeta());

    expect(reply.suspensionCauses).toEqual(['INSPECTION_EXPIRED']);
    // El flag derivado se mantiene en paralelo.
    expect(reply.suspendedAt).not.toBe('');
  });

  it('conductor con VARIAS causas (doc + disciplinaria) → las muestra TODAS, dedup por cause distinta', async () => {
    const ctrl = makeController({
      findUnique: () => ({
        ...baseDriverRow,
        suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
        // 2 holds DOCUMENT_EXPIRED de docs distintos (SOAT + LICENSE_A1) + 1 DISCIPLINARY → 2 causas DISTINTAS.
        suspensionHolds: [
          { cause: 'DOCUMENT_EXPIRED' },
          { cause: 'DOCUMENT_EXPIRED' },
          { cause: 'DISCIPLINARY' },
        ],
      }),
    });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMeta());

    expect(reply.suspensionCauses).toHaveLength(2);
    expect(reply.suspensionCauses).toEqual(
      expect.arrayContaining(['DOCUMENT_EXPIRED', 'DISCIPLINARY']),
    );
  });

  it('conductor NO suspendido (0 holds) → suspensionCauses = []', async () => {
    const ctrl = makeController({ findUnique: () => ({ ...baseDriverRow, suspensionHolds: [] }) });
    const reply = await ctrl.getDriver({ id: 'd1' }, signedMeta());

    expect(reply.suspensionCauses).toEqual([]);
    expect(reply.suspendedAt).toBe('');
  });
});

/**
 * FIX 2 (habilitar la UI cause-aware en la LISTA del panel) — el BATCH `GetDriversByIds` (que puebla la lista
 * del admin vía admin-bff `listDrivers`) ahora EXPONE las CAUSAS de suspensión por conductor, igual que el
 * detalle. Lo CRÍTICO: SIN N+1 — UNA sola `findMany WHERE id IN (...)` con `include: suspensionHolds` trae los
 * holds de TODOS los ids en la misma ida a la DB (no un query por driver). El `toDriverReply` ya mapea las
 * causas distintas (dedup por `cause`) cuando el row trae `suspensionHolds`.
 */
describe('IdentityGrpcController · GetDriversByIds (BATCH) expone las CAUSAS de suspensión SIN N+1 (FIX 2)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('el batch incluye los holds en UNA sola query (include suspensionHolds: select cause · sin N+1)', async () => {
    const ctrl = makeController({
      findMany: () => [
        { ...baseDriverRow, id: 'd1', suspensionHolds: [] },
        { ...baseDriverRow, id: 'd2', suspensionHolds: [] },
      ],
    });
    const prismaFindMany = (
      ctrl as unknown as {
        prisma: { read: { driver: { findMany: ReturnType<typeof vi.fn> } } };
      }
    ).prisma.read.driver.findMany;

    await ctrl.getDriversByIds({ ids: ['d1', 'd2'] }, signedMeta());

    // UNA sola llamada a la DB para TODA la página (no un query por driver) → no hay N+1.
    expect(prismaFindMany).toHaveBeenCalledTimes(1);
    // Y esa única query trae los holds de todos los ids vía include (mismo dato que el detalle).
    expect(prismaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['d1', 'd2'] } },
        include: expect.objectContaining({
          suspensionHolds: { select: { cause: true } },
        }),
      }),
    );
  });

  it('cada conductor del batch trae SUS causas distintas (dedup por cause) — la lista las puebla por fila', async () => {
    const ctrl = makeController({
      findMany: () => [
        // d1 suspendido por 2 causas (2 DOCUMENT_EXPIRED de docs distintos + 1 DISCIPLINARY → 2 distintas).
        {
          ...baseDriverRow,
          id: 'd1',
          suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
          suspensionHolds: [
            { cause: 'DOCUMENT_EXPIRED' },
            { cause: 'DOCUMENT_EXPIRED' },
            { cause: 'DISCIPLINARY' },
          ],
        },
        // d2 suspendido SOLO por ITV.
        {
          ...baseDriverRow,
          id: 'd2',
          suspendedAt: new Date('2026-06-01T00:00:00.000Z'),
          suspensionHolds: [{ cause: 'INSPECTION_EXPIRED' }],
        },
        // d3 NO suspendido (0 holds) → [].
        { ...baseDriverRow, id: 'd3', suspensionHolds: [] },
      ],
    });

    const reply = await ctrl.getDriversByIds({ ids: ['d1', 'd2', 'd3'] }, signedMeta());
    const byId = new Map(reply.drivers.map((d) => [d.id, d]));

    expect(byId.get('d1')!.suspensionCauses).toHaveLength(2);
    expect(byId.get('d1')!.suspensionCauses).toEqual(
      expect.arrayContaining(['DOCUMENT_EXPIRED', 'DISCIPLINARY']),
    );
    expect(byId.get('d2')!.suspensionCauses).toEqual(['INSPECTION_EXPIRED']);
    expect(byId.get('d3')!.suspensionCauses).toEqual([]);
    // Minimización 5b intacta: el batch NUNCA descifra el DNI, ni con holds presentes.
    expect(reply.drivers.every((d) => d.documentId === '')).toBe(true);
  });
});
