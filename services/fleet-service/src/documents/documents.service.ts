/**
 * DocumentsService — alta, revisión manual (RBAC) y consulta de documentos de flota (BR-I04).
 * El recálculo masivo por vencimiento y las alertas/suspensión los ejecuta ExpirySweeper (cron).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  uuidv7,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
  ConcurrencyConflictError,
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
import {
  assertS3KeysBelongToOwner,
  deriveExpiryStatus,
  isCriticalDocument,
  normalizeDocumentImages,
  primaryS3Key,
  type NormalizedDocumentImage,
} from './document-rules';
import { ReviewDecision } from './dto/document.dto';
import type { CreateDocumentDto } from './dto/document.dto';
import {
  FleetDocumentStatus,
  FleetOwnerType,
  Prisma,
  type DocumentImage,
  type FleetDocument,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';

/** Documento con sus imágenes (sub-lote 3A): lo que devuelven create/list al consumidor nuevo. */
export type FleetDocumentWithImages = FleetDocument & { images: DocumentImage[] };

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
  async create(
    input: CreateDocumentDto,
    user: AuthenticatedUser,
  ): Promise<FleetDocumentWithImages> {
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

    // Read-your-writes (cierra la ALTA del replica-lag): el chequeo del doc activo existente DEBE leer del
    // primary (`write`), no de la réplica. Un doc recién creado puede no haberse replicado aún → leer de
    // `read` dejaría pasar un duplicado/desincronizar el upsert en una ventana de lag (@veo/database
    // read-write.ts §14: "NUNCA leer de `read` un registro recién escrito en un flujo crítico... usar
    // `write`"). DEUDA: bajo concurrencia pura (dos altas simultáneas) esto sigue siendo TOCTOU — el cierre
    // definitivo es un partial unique index (ownerType, ownerId, type) WHERE status activo, fuera de scope
    // de este lote (lo decide el dueño).
    const existingActive = await this.prisma.write.fleetDocument.findFirst({
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

    // Sub-lote 3A: normaliza/valida las imágenes (camino nuevo `images[]` o legacy `fileS3Key`). Lanza
    // ValidationError si las caras son incoherentes (p.ej. FRONT sin BACK). Puede ser [] (doc sin archivo aún).
    const images = normalizeDocumentImages({ images: input.images, fileS3Key: input.fileS3Key });

    // Anti-IDOR de STORAGE (defensa en profundidad): el `ownerId` ya quedó probado contra el principal
    // (arriba), pero las KEYS S3 vienen del cliente. Si no se acotan al prefijo del dueño, un doc DRIVER
    // podría apuntar a `drivers/{OTRO}/documents/...` y filtrar PII ajena al presignar el operador su GET.
    // Cubre TODAS las fuentes (images[] + fileS3Key legacy, ya unificadas en `images`). 403 fail-closed.
    assertS3KeysBelongToOwner(input.ownerType, input.ownerId, images);

    // UPSERT ACOTADO por status del doc activo (FOUNDATION §14: transiciones autorizadas). El set activo
    // (PENDING_REVIEW/VALID/EXPIRING_SOON) NO es homogéneo: re-subir NO puede des-verificar en silencio un
    // doc que el operador YA APROBÓ. Ramificamos por el status del `existingActive`:
    //
    //  - PENDING_REVIEW (aún en cola, no aprobado): re-subir es una CORRECCIÓN pre-revisión legítima
    //    (caso onboarding: el conductor re-escanea antes de que el operador valide). → `replaceActiveDocument`
    //    (reemplaza imágenes/OCR/metadatos; el reset de verifiedAt/verifiedBy es un no-op, ya estaban nulos).
    //
    //  - VALID / EXPIRING_SOON (APROBADO por el operador): re-subir NO debe resetear a PENDING_REVIEW ni
    //    limpiar verifiedAt/verifiedBy — eso DES-VERIFICARÍA el doc en silencio, sin transición autorizada.
    //    Este endpoint es general (no solo onboarding) → lanzamos 409 ConflictError, como era antes. El
    //    cliente trata el 409 como éxito y el doc aprobado QUEDA intacto.
    //    DEUDA: renovar un doc aprobado es un flujo EXPLÍCITO/AUDITADO futuro (transición autorizada con
    //    su propio endpoint), NO una re-subida silenciosa sobre este POST general.
    //
    // (REJECTED no está en el set activo → cae al `create` de abajo, sin cambio.)
    if (existingActive) {
      if (existingActive.status === FleetDocumentStatus.PENDING_REVIEW) {
        return this.replaceActiveDocument(existingActive, input, images);
      }
      // VALID o EXPIRING_SOON: aprobado → no des-verificar en silencio.
      throw new ConflictError('Ya tenés un documento aprobado de este tipo', {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        type: input.type,
        status: existingActive.status,
      });
    }

    const documentId = uuidv7();

    // Transacción ATÓMICA: el documento y sus N imágenes se persisten juntos o no se persiste nada.
    // `fileS3Key` se sigue poblando con la primera imagen (backward-compat: consumidores legacy que aún lo lean).
    return this.prisma.write.$transaction(async (tx) => {
      const document = await tx.fleetDocument.create({
        data: {
          id: documentId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          type: input.type,
          // VEHICLE_PHOTO no trae número (foto sin numerar) → '' honesto (la columna es no-null).
          documentNumber: (input.documentNumber ?? '').trim(),
          issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          fileS3Key: primaryS3Key(images),
          // Onboarding sin-formularios (Lote 0): la data extraída por OCR on-device se persiste EN LA
          // MISMA transacción atómica que el doc + sus imágenes. Opcional → si no vino OCR, las 3 columnas
          // quedan null (Prisma omite el set con `undefined`), y el registro legacy sigue idéntico.
          // `extractedData` es Json?: el contrato tipado ExtractedDocumentData se serializa tal cual; el
          // cast a InputJsonValue es el puente al tipo Json de Prisma (no hay `any`).
          extractedData: input.extractedData
            ? (input.extractedData as unknown as Prisma.InputJsonValue)
            : undefined,
          ocrEngine: input.ocrEngine ?? undefined,
          ocrAt: input.ocrAt ? new Date(input.ocrAt) : undefined,
          status: FleetDocumentStatus.PENDING_REVIEW,
        },
      });

      if (images.length > 0) {
        await tx.documentImage.createMany({
          data: images.map((img) => ({
            id: uuidv7(),
            documentId,
            s3Key: img.s3Key,
            side: img.side,
            order: img.order,
          })),
        });
      }

      // Devuelve el doc con sus imágenes (orden estable) en la MISMA transacción (lectura consistente).
      const created = await tx.documentImage.findMany({
        where: { documentId },
        orderBy: { order: 'asc' },
      });
      return { ...document, images: created };
    });
  }

  /**
   * UPSERT · rama de REEMPLAZO: re-subida sobre un doc activo existente. Actualiza ESE mismo doc (id
   * estable) en una transacción ATÓMICA: reemplaza por completo el set de imágenes (borra las viejas y
   * crea las nuevas), repuebla `fileS3Key` (backward-compat), reemplaza la data OCR
   * (extractedData/ocrEngine/ocrAt), el documentNumber/issuedAt/expiresAt, y RESETEA el status a
   * PENDING_REVIEW (el contenido cambió → re-revisión). Todo o nada: o se reemplaza el doc completo, o no
   * se toca nada. Devuelve el doc actualizado con sus imágenes (orden estable, lectura post-write en la
   * misma transacción).
   *
   * ACOTADO a PENDING_REVIEW: esta rama SOLO se alcanza cuando el doc activo está en PENDING_REVIEW (la
   * ramificación de `create()` manda VALID/EXPIRING_SOON a 409 para no des-verificar un doc aprobado). Por
   * eso el reset de status/verifiedAt/verifiedBy es un no-op de estado aquí (el doc nunca estuvo aprobado):
   * limpiar verifiedAt/verifiedBy/rejectionReason queda como defensa-en-profundidad idempotente.
   */
  private replaceActiveDocument(
    existing: FleetDocument,
    input: CreateDocumentDto,
    images: readonly NormalizedDocumentImage[],
  ): Promise<FleetDocumentWithImages> {
    const documentId = existing.id;
    return this.prisma.write.$transaction(async (tx) => {
      const document = await tx.fleetDocument.update({
        where: { id: documentId },
        data: {
          // VEHICLE_PHOTO no trae número (foto sin numerar) → '' honesto (la columna es no-null).
          documentNumber: (input.documentNumber ?? '').trim(),
          issuedAt: input.issuedAt ? new Date(input.issuedAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          fileS3Key: primaryS3Key(images),
          // Reemplazo de la data OCR: si la re-subida NO trae OCR, las columnas se LIMPIAN a null (el doc
          // nuevo no tiene OCR) — coherente con "reemplazar", no "mergear". `null` es un set explícito en
          // Prisma (a diferencia de `undefined`, que omitiría el campo).
          extractedData: input.extractedData
            ? (input.extractedData as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          ocrEngine: input.ocrEngine ?? null,
          ocrAt: input.ocrAt ? new Date(input.ocrAt) : null,
          // Re-subir REVISA de nuevo: el contenido cambió → vuelve a la cola del operador.
          status: FleetDocumentStatus.PENDING_REVIEW,
          // El reemplazo invalida cualquier revisión previa (verificación/rechazo del doc anterior).
          verifiedAt: null,
          verifiedBy: null,
          rejectionReason: null,
        },
      });

      // Reemplazo TOTAL del set de imágenes: borra las viejas y crea las nuevas (no se mergean). Atómico
      // con el update del doc dentro de la misma transacción.
      await tx.documentImage.deleteMany({ where: { documentId } });
      if (images.length > 0) {
        await tx.documentImage.createMany({
          data: images.map((img) => ({
            id: uuidv7(),
            documentId,
            s3Key: img.s3Key,
            side: img.side,
            order: img.order,
          })),
        });
      }

      const updatedImages = await tx.documentImage.findMany({
        where: { documentId },
        orderBy: { order: 'asc' },
      });
      return { ...document, images: updatedImages };
    });
  }

  listByOwner(ownerId: string): Promise<FleetDocumentWithImages[]> {
    return this.prisma.read.fleetDocument.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: { images: { orderBy: { order: 'asc' } } },
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
    return this.prisma.write.$transaction(async (tx) => {
      // Lectura DENTRO de la write-tx (NO de la réplica): sin lag ni TOCTOU con un review() concurrente.
      const doc = await tx.fleetDocument.findUnique({ where: { id } });
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

      // CAS atómico: el estado origen PENDING_REVIEW viaja en el WHERE del updateMany. Dos operadores (o un
      // doble-submit) revisando el MISMO doc: solo UNO matchea — el segundo re-evalúa el WHERE contra el valor
      // ya commiteado y ve count 0. Sin esto (update-por-id plano sobre lectura de réplica) ambos escribían
      // last-write-wins y AMBOS emitían por outbox → divergencia estado/evento (p. ej. REJECTED en DB pero
      // DRIVER_REACTIVATED ya emitido → identity reactiva a un conductor con doc crítico rechazado).
      const claim = await tx.fleetDocument.updateMany({
        where: { id, status: FleetDocumentStatus.PENDING_REVIEW },
        data: {
          status: finalStatus,
          verifiedAt: now,
          verifiedBy: reviewerId,
          // M5: persistimos el motivo SOLO si es rechazo; al validar lo limpiamos (ya no hay rechazo).
          rejectionReason:
            decision === ReviewDecision.REJECTED ? reason?.trim() || null : null,
        },
      });
      if (claim.count === 0) {
        throw new ConcurrencyConflictError('El documento ya fue revisado por otra operación');
      }
      const updated = await tx.fleetDocument.findUniqueOrThrow({ where: { id } });

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
      } else if (
        // AUTO-REACTIVACIÓN POR DOCUMENTO (FIX · simétrico a la suspensión por doc, compliance/seguridad):
        // un documento crítico DRIVER-scoped que el operador VALIDA (resultado VALID/EXPIRING_SOON, NO
        // rechazo, NO vencido) es la REGULARIZACIÓN del doc que podía tener al conductor suspendido por
        // DOCUMENT_EXPIRED. Emitimos `fleet.driver_reactivated` keyeado por `driverId` (= ownerId del doc
        // DRIVER-scoped, ES el id de perfil) en la MISMA tx (outbox-in-tx). IDEMPOTENTE/SEGURO emitir aunque
        // el conductor NO estuviera suspendido: el consumer de identity reactiva SOLO suspensiones
        // DOCUMENT_EXPIRED (una DISCIPLINARY queda intacta) y el CAS es no-op si ya estaba activo.
        decision === ReviewDecision.VALID &&
        updated.ownerType === FleetOwnerType.DRIVER &&
        isCriticalDocument(updated.type)
      ) {
        await this.enqueue(
          tx,
          updated.ownerId,
          buildFleetEvent(FleetEventType.DRIVER_REACTIVATED, {
            driverId: updated.ownerId,
            reason: `Documento crítico regularizado (${updated.type})`,
            documentId: updated.id,
            documentType: updated.type,
            reactivatedAt: now.toISOString(),
          }),
        );
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
