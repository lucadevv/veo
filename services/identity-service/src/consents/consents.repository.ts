/**
 * ConsentsRepository — ÚNICO punto de acceso Prisma del registro APPEND-ONLY de consentimientos (Ley 29733,
 * schema 'identity'). Espeja el mold de payment/rating: read/write split y métodos con NOMBRES DE DOMINIO —
 * nunca filtra `PrismaClient` crudo al service.
 *
 * SEAM con ConsentsService: la LÓGICA DE DOMINIO (validación de la dedupKey UUIDv7, idempotencia por P2002,
 * append-only, "vigente = el más reciente") vive ENTERA en el service. Este repo solo hace acceso a datos:
 * `create` (nunca update/delete: la evidencia histórica es inmutable) + la relectura del row idempotente.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Consent } from '../generated/prisma';

@Injectable()
export class ConsentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** APPEND-ONLY: inserta un nuevo consentimiento. El service arma la data. Puede lanzar el P2002 del dedup. */
  createConsent(data: Prisma.ConsentUncheckedCreateInput): Promise<Consent> {
    return this.prisma.write.consent.create({ data });
  }

  /** Relee el row ya registrado por su dedupKey (no-op idempotente tras el P2002). Primary (sin lag). */
  findConsentByDedupKey(dedupKey: string): Promise<Consent | null> {
    return this.prisma.write.consent.findUnique({ where: { dedupKey } });
  }

  /** Estado VIGENTE = el consentimiento más reciente del usuario por `acceptedAt`. Réplica. */
  findLatestConsent(userId: string): Promise<Consent | null> {
    return this.prisma.read.consent.findFirst({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });
  }
}
