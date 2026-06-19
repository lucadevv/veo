/**
 * DocumentsService — alta, revisión manual (RBAC) y consulta de documentos de flota (BR-I04).
 * El recálculo masivo por vencimiento y las alertas/suspensión los ejecuta ExpirySweeper (cron).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  uuidv7,
  NotFoundError,
  ConflictError,
  ValidationError,
  ForbiddenError,
} from '@veo/utils';
import { assertDriverOwnsResource, type AuthenticatedUser } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import {
  clampLimit,
  toPage,
  toExpiryPage,
  decodeExpiryCursor,
  type Page,
} from '../infra/pagination';
import { buildFleetEvent, FleetEventType } from '../events/fleet-events';
import { deriveExpiryStatus, isCriticalDocument } from './document-rules';
import { ReviewDecision } from './dto/document.dto';
import type { CreateDocumentDto } from './dto/document.dto';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  type FleetDocument,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';

@Injectable()
export class DocumentsService {
  private readonly warningDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.warningDays = config.getOrThrow<number>('EXPIRY_WARNING_DAYS');
  }

  /**
   * Sube un documento. Entra como PENDING_REVIEW hasta que el operador lo valide (BR-I04).
   *
   * Anti-IDOR / confused-deputy (defensa en profundidad, FOUNDATION §14): el BFF sigue siendo la
   * autoridad de authz y el riel ya está acotado por AudienceGuard a driver-rail/admin-rail (CAPA 1),
   * pero fleet ES DUEÑO de Vehicle y la identidad interna firmada trae el sujeto resuelto server-side
   * (`AuthenticatedUser.driverId` para conductores, firmado HMAC por el driver-bff). Por eso fleet
   * valida PERTENENCIA contra el principal autenticado, en vez de confiar ciegamente en `ownerId`.
   *
   * Predicado de pertenencia FAIL-CLOSED (denylist, no allowlist-por-tipo): SOLO una identidad admin
   * se exime de probar pertenencia (su authz va por RolesGuard/Audiences admin-rail). CUALQUIER otro
   * principal (driver, passenger, o un tipo futuro) DEBE probar que el recurso es suyo, o se rechaza.
   * El bug previo era allowlist (`type === 'driver'` ataba; otro tipo PASABA libre): un principal
   * no-driver/no-admin podía crear docs de owners ajenos. Ahora invertido: nadie pasa sin probar.
   *
   *  - DRIVER: si no es admin → `ownerId` (id de perfil Driver) DEBE coincidir con el `driverId`
   *    firmado del caller (driver ata a su id; cualquier otro tipo → 403 fail-closed).
   *  - VEHICLE: el vehículo debe EXISTIR y, si no es admin, PERTENECERLE
   *    (`Vehicle.driverId === user.userId`, por el invariante de id documentado en VehiclesService).
   */
  async create(input: CreateDocumentDto, user: AuthenticatedUser): Promise<FleetDocument> {
    // Solo el operador admin se exime de probar pertenencia (su authz va por RolesGuard/admin-rail).
    // Todo lo demás cae en el camino fail-closed. Sin string mágico: SubjectType 'admin' del contrato.
    const isAdminPrincipal = user.type === 'admin';

    if (input.ownerType === FleetOwnerType.DRIVER) {
      // El `ownerId` de un doc DRIVER es el id de perfil Driver, que el BFF resuelve server-side y firma
      // en la identidad interna. Si no es admin, el principal DEBE probar pertenencia. Un driver ata a
      // SU propio driverId (assertDriverOwnsResource); CUALQUIER otro tipo no-admin (p.ej. passenger)
      // no tiene forma de probar pertenencia sobre un perfil Driver → 403 fail-closed (denylist).
      if (!isAdminPrincipal) {
        if (user.type !== 'driver') {
          throw new ForbiddenError('No autorizado a subir documentos de un conductor', {
            ownerId: input.ownerId,
          });
        }
        assertDriverOwnsResource(user, input.ownerId);
      }
    }

    if (input.ownerType === FleetOwnerType.VEHICLE) {
      const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: input.ownerId } });
      if (!vehicle)
        throw new NotFoundError('Vehículo dueño del documento no existe', {
          ownerId: input.ownerId,
        });
      // fleet ES dueño de Vehicle: si no es admin, el principal solo sube docs de SU vehículo.
      // `Vehicle.driverId` guarda el User.id (invariante de fleet) → se compara con `user.userId`.
      // Fail-closed: un principal no-admin que no sea el dueño (incl. tipos no-driver) → 403.
      if (!isAdminPrincipal && vehicle.driverId !== user.userId) {
        throw new ForbiddenError('No autorizado a subir documentos de un vehículo ajeno', {
          ownerId: input.ownerId,
        });
      }
    }

    const duplicate = await this.prisma.read.fleetDocument.findFirst({
      where: {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        type: input.type,
        status: {
          in: [
            FleetDocumentStatus.PENDING_REVIEW,
            FleetDocumentStatus.VALID,
            FleetDocumentStatus.EXPIRING_SOON,
          ],
        },
      },
    });
    if (duplicate) {
      throw new ConflictError('Ya existe un documento activo de ese tipo para el dueño', {
        ownerId: input.ownerId,
        type: input.type,
      });
    }

    return this.prisma.write.fleetDocument.create({
      data: {
        id: uuidv7(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        type: input.type,
        // VEHICLE_PHOTO no trae número (foto sin numerar) → '' honesto (la columna es no-null).
        documentNumber: (input.documentNumber ?? '').trim(),
        issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        fileS3Key: input.fileS3Key ?? null,
        status: FleetDocumentStatus.PENDING_REVIEW,
      },
    });
  }

  listByOwner(ownerId: string): Promise<FleetDocument[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lista paginada de documentos para el operador (admin), filtrable por estado (índice
   * `[status, expiresAt]`). Paginación cursor por id (uuidv7). Sin `status` lista todos.
   */
  async list(opts: {
    ownerId?: string;
    status?: FleetDocumentStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<FleetDocument>> {
    const limit = clampLimit(opts.limit);
    const where: Prisma.FleetDocumentWhereInput = {};
    if (opts.ownerId) where.ownerId = opts.ownerId;
    if (opts.status) where.status = opts.status;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.fleetDocument.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  /**
   * Revisión manual del operador (RBAC). REJECTED queda rechazado; VALID recalcula su estado
   * por vencimiento de inmediato (puede caer en EXPIRING_SOON/EXPIRED). Si un documento crítico de
   * un conductor queda EXPIRED, se publica la suspensión por outbox (BR-I04).
   */
  async review(
    id: string,
    decision: ReviewDecision,
    reviewerId: string,
    reason?: string,
    now = new Date(),
  ): Promise<FleetDocument> {
    const doc = await this.prisma.read.fleetDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundError('Documento no encontrado', { id });
    if (doc.status !== FleetDocumentStatus.PENDING_REVIEW) {
      throw new ValidationError('El documento no está pendiente de revisión', {
        status: doc.status,
      });
    }

    const finalStatus =
      decision === ReviewDecision.REJECTED
        ? FleetDocumentStatus.REJECTED
        : deriveExpiryStatus(doc.expiresAt, now, this.warningDays);

    return this.prisma.write.$transaction(async (tx) => {
      const updated = await tx.fleetDocument.update({
        where: { id },
        data: {
          status: finalStatus,
          verifiedAt: now,
          verifiedBy: reviewerId,
          // M5: persistimos el motivo SOLO si es rechazo; al validar lo limpiamos (ya no hay rechazo).
          rejectionReason:
            decision === ReviewDecision.REJECTED ? reason?.trim() || null : null,
        },
      });

      if (finalStatus === FleetDocumentStatus.EXPIRED) {
        const critical = isCriticalDocument(updated.type);
        await this.enqueue(
          tx,
          updated.id,
          buildFleetEvent(FleetEventType.DOCUMENT_EXPIRED, {
            documentId: updated.id,
            ownerType: updated.ownerType,
            ownerId: updated.ownerId,
            documentType: updated.type,
            expiresAt: (updated.expiresAt ?? now).toISOString(),
            critical,
          }),
        );
        if (critical && updated.ownerType === FleetOwnerType.DRIVER) {
          await this.enqueue(
            tx,
            updated.ownerId,
            buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, {
              driverId: updated.ownerId,
              reason: `Documento crítico vencido (${updated.type})`,
              documentId: updated.id,
              documentType: updated.type,
              suspendedAt: now.toISOString(),
            }),
          );
        }
      }
      return updated;
    });
  }

  /**
   * Documentos por vencer o vencidos, PAGINADOS por cursor y ordenados por proximidad de vencimiento.
   *
   * Devuelve el envelope `Page<FleetDocument>` (igual que `list()` y que vehicles/documents/inspections),
   * con `clampLimit` + `take: limit + 1` para detectar si hay siguiente página. Reemplaza el cap previo,
   * que truncaba SILENCIOSAMENTE a `limit` filas sin señal al cliente (regresión): el operador no podía
   * recorrer toda la cola. Ahora `nextCursor` permite avanzar sin saltear ni duplicar.
   *
   * CURSOR COMPUESTO (no id-solo): el orden es `(expiresAt asc, id asc)` — proximidad de vencimiento, con
   * uuidv7 como desempate estable. A diferencia de `list()` (que ordena y cursorea por `id` solo), acá un
   * cursor de id NO basta: filas con distinto `expiresAt` no quedan resueltas por un keyset de id. Por eso
   * el cursor codifica la tupla `(expiresAt, id)` y el predicado keyset es lexicográfico sobre esa tupla:
   *   expiresAt > c.expiresAt  OR  (expiresAt = c.expiresAt AND id > c.id)
   * Esto avanza la página de forma determinista y total (sin gaps ni duplicados).
   */
  async listExpirations(opts: {
    withinDays?: number;
    now?: Date;
    cursor?: string;
    limit?: number;
  } = {}): Promise<Page<FleetDocument>> {
    const now = opts.now ?? new Date();
    const limit = clampLimit(opts.limit);

    // `expiresAt: { not: null }` es BASE de AMBAS ramas (no solo within-days): el cursor compuesto
    // ordena/cursorea por (expiresAt, id), y una fila con expiresAt=null produciría un cursor `|<id>`
    // que decodeExpiryCursor rechaza → la paginación entra en loop. Hoy es inalcanzable (deriveExpiryStatus
    // fuerza VALID si expiresAt es null), pero el cursor NO debe depender de ese invariante no-enforced.
    const baseWhere: Prisma.FleetDocumentWhereInput =
      opts.withinDays !== undefined
        ? {
            expiresAt: { not: null, lte: new Date(now.getTime() + opts.withinDays * 86_400_000) },
            status: {
              in: [
                FleetDocumentStatus.VALID,
                FleetDocumentStatus.EXPIRING_SOON,
                FleetDocumentStatus.EXPIRED,
              ],
            },
          }
        : {
            expiresAt: { not: null },
            status: { in: [FleetDocumentStatus.EXPIRING_SOON, FleetDocumentStatus.EXPIRED] },
          };

    // Keyset compuesto: solo filas DESPUÉS de la tupla (expiresAt, id) del cursor. Un cursor inválido se
    // ignora (página desde el inicio) en vez de romper — el cliente no debería fabricarlos a mano.
    const decoded = opts.cursor ? decodeExpiryCursor(opts.cursor) : null;
    const where: Prisma.FleetDocumentWhereInput = decoded
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { expiresAt: { gt: decoded.expiresAt } },
                { expiresAt: decoded.expiresAt, id: { gt: decoded.id } },
              ],
            },
          ],
        }
      : baseWhere;

    const rows = await this.prisma.read.fleetDocument.findMany({
      where,
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    return toExpiryPage(rows, limit);
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    aggregateId: string,
    envelope: ReturnType<typeof buildFleetEvent>,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateId,
        eventType: envelope.eventType,
        envelope: envelope as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
