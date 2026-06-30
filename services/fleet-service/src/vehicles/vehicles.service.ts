/**
 * VehiclesService — alta y consulta de vehículos (BR-D04: año mínimo, placa válida).
 * El estado documental agregado (docStatus) lo mantiene el cron de vencimientos (ExpirySweeper).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  uuidv7,
  plateSchema,
  parseOrThrow,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { OPERABLE_VEHICLE_CLASSES, mapMtcCategoryToVehicleType } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { VehicleModelsService } from '../vehicle-models/vehicle-models.service';
import { buildFleetEvent, FleetEventType } from '../events/fleet-events';
import {
  deriveVehicleReviewStatus,
  deriveVehicleOperability,
  VehicleOperabilityReason,
  hasRequiredVehicleDocsOperable,
  isVehicleYearEligible,
  pickActiveVehicle,
} from './vehicle-rules';
import { validCertificationsOf } from '../documents/document-rules';
import type {
  CreateVehicleDto,
  DriverVehicleResponse,
  RegisterDriverVehicleDto,
} from './dto/vehicle.dto';
import {
  FleetOwnerType,
  Prisma,
  VehicleDocStatus,
  VehicleModelSource,
  VehicleModelStatus,
  VehicleType,
  type Vehicle,
} from '../generated/prisma';
import type { Env } from '../config/env.schema';
import { clampLimit, toPage, type Page } from '../infra/pagination';

/**
 * Ids del conductor para el HARD purge. Son DOS porque fleet indexa cada tabla con un id distinto:
 *  - `driverId` (perfil Driver de identity) → FleetDocument ownerType DRIVER.
 *  - `userId` (User.id de identity) → Vehicle.driverId.
 */
export interface PurgeDriverIds {
  /** Opcional: ausente en la cascada de erasure (`user.deleted`) de un usuario SIN perfil Driver. Si
   *  falta, los docs ownerType DRIVER no se tocan; los vehículos igual se purgan por userId. */
  driverId?: string;
  userId: string;
}

/**
 * LOTE 3 · señal de "encolar modelo OCR DESPUÉS del alta". El fuzzy-match (read) NO escribe: cuando no hay
 * match, devuelve estos datos para que el caller encole el modelo PENDING_REVIEW (write) SOLO si el vehículo
 * se creó con éxito. Así un alta fallida o spam (placa duplicada, etc.) NO ensucia la cola del operador.
 */
interface PendingOcrModel {
  make: string;
  model: string;
  vehicleType: VehicleType;
  year: number | undefined;
  requestedBy: string;
  source: VehicleModelSource;
}

/**
 * Resultado de resolver el snapshot del modelo. `pendingOcrModel` solo viene poblado en el alta del conductor
 * (fuzzy) cuando el texto libre NO matcheó el catálogo: el caller lo encola POST-éxito (best-effort). En todos
 * los demás caminos (match, modelSpecId, freetext legacy admin) es `null` y no se encola nada.
 */
interface ModelSnapshot {
  make: string;
  model: string;
  vehicleType: VehicleType;
  modelSpecId: string | null;
  pendingOcrModel: PendingOcrModel | null;
}

/**
 * Vehículo de la lista admin ENRIQUECIDO con la ficha técnica del modelSpec elegido
 * (segment/energySource/efficiency/seats). De esos, el DISPATCH solo usa `segment` y `seats` (+ el `year` del
 * propio Vehicle) para la eligibilidad de oferta; `energySource`/`efficiency` NO deciden match NI pricing — el
 * precio de energía sale de la CLASE de la oferta (referenceEnergySource/Efficiency · ADR-017 dec.2), no del
 * vehículo real (ese delta es el margen PRIVADO del conductor). Se proyectan igual para que el panel MUESTRE la
 * ficha completa y el operador VEA el eslabón vehículo↔config (F1). La ficha vive en `VehicleModelSpec`
 * (referencia BLANDA, sin FK), no en `Vehicle`; `mtcCategory`/`vehicleType`/`year` sí viven en `Vehicle`.
 * Vehículo legacy sin `modelSpecId` (o spec borrado) → nulls (degradación honesta).
 */
export type VehicleListItem = Vehicle & {
  segment: string | null;
  energySource: string | null;
  efficiency: number | null;
  seats: number | null;
  /**
   * VEREDICTO DE OPERABILIDAD + MOTIVO, computados server-side por `deriveVehicleOperability` (FUENTE ÚNICA que
   * espeja EXACTO el gate de booking/dispatch: docs SOAT/ITV operables Y ficha linkeada Y docStatus !== EXPIRED).
   * El panel admin los MUESTRA tal cual (la UI refleja, no re-deriva) para coincidir con el backend, en vez del
   * flag `active` stored (DEPRECADO: se setea al alta y nada lo mantiene). `operabilityReason` es null si opera.
   */
  operable: boolean;
  operabilityReason: VehicleOperabilityReason | null;
};

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);
  private readonly minYear: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleModels: VehicleModelsService,
    config: ConfigService<Env, true>,
  ) {
    this.minYear = config.getOrThrow<number>('VEHICLE_MIN_YEAR');
  }

  /**
   * Gate server-side: la clase de vehículo debe ser OPERABLE hoy (catálogo `OPERABLE_VEHICLE_CLASSES`,
   * fuente única). Mientras la mototaxi esté diferida, MOTO se rechaza acá AUNQUE el cliente lo mande —
   * la UI no autoriza, el backend sí. Cuando se habilite la oferta MOTO, el set crece y deja de bloquear.
   */
  private assertOperableVehicleType(vehicleType: VehicleType): void {
    if (!(OPERABLE_VEHICLE_CLASSES as readonly string[]).includes(vehicleType)) {
      throw new ValidationError('Por ahora solo se registran autos; la mototaxi llega más adelante', {
        vehicleType,
        operable: OPERABLE_VEHICLE_CLASSES,
      });
    }
  }

  async create(input: CreateVehicleDto): Promise<Vehicle> {
    const plate = parseOrThrow(plateSchema, input.plate.trim().toUpperCase(), 'plate');

    if (!isVehicleYearEligible(input.year, this.minYear)) {
      throw new ValidationError(
        `El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`,
        {
          year: input.year,
          minYear: this.minYear,
        },
      );
    }

    // F4 (C2): si el operador eligió un modelo del CATÁLOGO, make/model/vehicleType se snapshotean del spec
    // APPROVED (server-authoritative) — la MISMA resolución que el alta del conductor (fuente única, sin
    // texto libre divergente); si no, cae al texto libre legacy (scripts/seeds). Resuelto ANTES del create.
    const snapshot = await this.resolveModelSnapshot(input);
    // "Solo autos" (Ola 1): valida la clase YA resuelta (cubre un spec MOTO del catálogo o un MOTO libre).
    this.assertOperableVehicleType(snapshot.vehicleType);

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) throw new ConflictError('Ya existe un vehículo con esa placa', { plate });

    return this.prisma.write.vehicle.create({
      data: {
        id: uuidv7(),
        plate,
        make: snapshot.make,
        model: snapshot.model,
        year: input.year,
        color: input.color.trim(),
        vehicleType: snapshot.vehicleType,
        modelSpecId: snapshot.modelSpecId,
        fleetId: input.fleetId ?? null,
        insuranceExpiresAt: input.insuranceExpiresAt ? new Date(input.insuranceExpiresAt) : null,
        active: input.active ?? true,
      },
    });
  }

  /**
   * HARD purge de TODA la flota documental de un conductor (re-registro de un conductor NO-OPERADO,
   * orquestado por el admin-bff con guard de trips aguas arriba). Borra REALMENTE, en UNA transacción:
   *  - sus documentos de OPERADOR (FleetDocument ownerType DRIVER, ownerId = driverId), y
   *  - sus vehículos (Vehicle.driverId = userId), CON sus documentos de vehículo asociados.
   *
   * INVARIANTE DE ID (dos ids, NO uno — verificado contra la DB real): fleet indexa cada tabla con un id
   * DISTINTO del mismo conductor, por cómo se escribieron históricamente:
   *  - `FleetDocument` (ownerType DRIVER) usa el id de PERFIL **Driver** de identity (`driverId`), igual que
   *    `GetDriverDocuments({ id: driverId })`. Los documentos del operador se crean con el driverId.
   *  - `Vehicle.driverId` guarda el **User.id** de identity (`userId`), que es lo que el driver-bff propaga
   *    al registrar el vehículo (`registerForDriver` recibe `identity.userId`).
   * Por eso el admin-bff pasa AMBOS ids: el driverId (para los docs) y el userId (para los vehículos). Usar
   * un solo id borraría 0 filas en una de las dos tablas (era el BUG: se pasaba userId a todo → docs 0 filas).
   *
   * NO emite eventos: es un borrado administrativo de algo que nunca operó (sin trips), no un hecho de
   * dominio del ciclo de vida del conductor. Idempotente: re-correr sobre un conductor ya purgado devuelve
   * contadores en 0 (deleteMany no falla si no hay filas).
   */
  async purgeForDriver(
    ids: PurgeDriverIds,
  ): Promise<{ documents: number; vehicles: number; vehicleDocuments: number }> {
    const { driverId, userId } = ids;
    return this.prisma.write.$transaction(async (tx) => {
      // Vehículos del conductor: indexados por userId (lo que el driver-bff persistió en Vehicle.driverId).
      const vehicles = await tx.vehicle.findMany({
        where: { driverId: userId },
        select: { id: true },
      });
      const vehicleIds = vehicles.map((v) => v.id);

      // Documentos de los VEHÍCULOS del conductor (ownerType VEHICLE, ownerId ∈ vehicleIds): sin esto
      // quedarían huérfanos (FleetDocument no tiene FK física a Vehicle, hay que borrarlos explícito).
      const vehicleDocuments =
        vehicleIds.length > 0
          ? await tx.fleetDocument.deleteMany({
              where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: vehicleIds } },
            })
          : { count: 0 };

      // Documentos de OPERADOR del conductor (ownerType DRIVER, ownerId = driverId de perfil). GUARD:
      // sin driverId NO se filtra — un `ownerId: undefined` en Prisma se ignora y borraría TODOS los
      // docs DRIVER (footgun). En ese caso (usuario sin perfil Driver) no hay docs de operador que purgar.
      const documents = driverId
        ? await tx.fleetDocument.deleteMany({
            where: { ownerType: FleetOwnerType.DRIVER, ownerId: driverId },
          })
        : { count: 0 };

      const deletedVehicles = await tx.vehicle.deleteMany({ where: { driverId: userId } });

      return {
        documents: documents.count,
        vehicles: deletedVehicles.count,
        vehicleDocuments: vehicleDocuments.count,
      };
    });
  }

  /**
   * Enriquece una tanda de vehículos con la ficha técnica de su modelSpec (segment/energySource/efficiency/
   * seats), BATCHED en UNA query (anti-N+1). Fuente ÚNICA que comparten `list()` y `getById()`: así el panel
   * VE exactamente la misma ficha en la lista y en el detalle (sin esto el detalle devolvía MENOS que la lista).
   */
  private async enrichWithSpec(vehicles: Vehicle[]): Promise<VehicleListItem[]> {
    const specIds = [
      ...new Set(vehicles.map((v) => v.modelSpecId).filter((id): id is string => id !== null)),
    ];
    // Las DOS lecturas (specs por modelSpecId · docs operables por vehicleId) son INDEPENDIENTES → en PARALELO
    // (Promise.all), no en serie: la latencia de cada list()/getById() es el MÁXIMO de ambas, no su suma.
    const [specs, operableById] = await Promise.all([
      specIds.length
        ? this.prisma.read.vehicleModelSpec.findMany({ where: { id: { in: specIds } } })
        : Promise.resolve([]),
      this.vehicleDocsOperableMap(vehicles.map((v) => v.id)),
    ]);
    const specById = new Map(specs.map((s) => [s.id, s] as const));
    return vehicles.map((v) => {
      const spec = v.modelSpecId ? specById.get(v.modelSpecId) : undefined;
      // Veredicto + motivo DERIVADOS por la FUENTE ÚNICA (espeja el gate de booking, incl. docStatus !== EXPIRED).
      const { operable, reason } = deriveVehicleOperability({
        docsOperable: operableById.get(v.id) ?? false,
        modelSpecId: v.modelSpecId,
        docStatus: v.docStatus,
      });
      return {
        ...v,
        segment: spec?.segment ?? null,
        energySource: spec?.energySource ?? null,
        efficiency: spec?.efficiency ?? null,
        seats: spec?.seats ?? null,
        operable,
        operabilityReason: reason,
      };
    });
  }

  /**
   * ¿Tiene ESTE vehículo sus documentos REQUERIDOS (SOAT+ITV) presentes+aprobados+vigentes? Señal REAL de
   * operabilidad documental: los docs del vehículo son FleetDocument ownerType=VEHICLE, ownerId=vehicle.id (NO
   * ownerType=DRIVER — esos son las certificaciones de OPERADOR del conductor, otra cosa). Un vehículo recién
   * registrado (sin docs) da `false` → PENDING_REVIEW, que es CORRECTO (no puede operar sin seguro+ITV).
   */
  private async vehicleDocsOperable(vehicleId: string): Promise<boolean> {
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: vehicleId },
    });
    return hasRequiredVehicleDocsOperable(docs);
  }

  /**
   * Operabilidad documental (SOAT+ITV) de una TANDA de vehículos, BATCHED en UNA query (anti-N+1): los docs
   * requeridos viven en FleetDocument ownerType=VEHICLE, ownerId ∈ vehicleIds. Devuelve un mapa
   * vehicleId→docsOperable (false para un vehículo sin docs requeridos operables). Espeja el batch de
   * `enrichWithSpec`/`purgeForDriver` — NO se consulta por vehículo en un loop.
   */
  private async vehicleDocsOperableMap(
    vehicleIds: readonly string[],
  ): Promise<Map<string, boolean>> {
    const operable = new Map<string, boolean>();
    if (vehicleIds.length === 0) return operable;
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: { in: [...vehicleIds] } },
    });
    const byOwner = new Map<string, typeof docs>();
    for (const d of docs) {
      const list = byOwner.get(d.ownerId);
      if (list) list.push(d);
      else byOwner.set(d.ownerId, [d]);
    }
    for (const vehicleId of vehicleIds) {
      operable.set(vehicleId, hasRequiredVehicleDocsOperable(byOwner.get(vehicleId) ?? []));
    }
    return operable;
  }

  async getById(id: string): Promise<VehicleListItem> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundError('Vehículo no encontrado', { id });
    // enrichWithSpec mapea 1:1; con un único input hay un único output. El fallback a ficha-nula nunca se
    // alcanza en la práctica, pero es la misma degradación honesta de un vehículo legacy sin modelSpec.
    const [enriched] = await this.enrichWithSpec([vehicle]);
    return (
      enriched ?? {
        ...vehicle,
        segment: null,
        energySource: null,
        efficiency: null,
        seats: null,
        operable: false,
        operabilityReason: VehicleOperabilityReason.DOCS,
      }
    );
  }

  /**
   * Lista paginada de la flota para el operador (admin). Filtro opcional por estado documental.
   * Paginación cursor por id (uuidv7 ⇒ orden temporal estable, sin offset costoso).
   *
   * El filtro stored `active` quedó DEPRECADO (Lote 4): la columna `Vehicle.active` se setea al alta y NADA
   * la mantiene (el sweeper no la flipea), así que filtrar por ella mentía. La operabilidad REAL es DERIVADA
   * (`operable` en cada ítem, mismo veredicto que el gRPC). Para filtrar por operabilidad se usa `docStatus`
   * (estado documental, sí mantenido) — no la columna muerta.
   */
  async list(opts: {
    docStatus?: VehicleDocStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<VehicleListItem>> {
    const limit = clampLimit(opts.limit);
    const where: Prisma.VehicleWhereInput = {};
    if (opts.docStatus) where.docStatus = opts.docStatus;
    if (opts.cursor) where.id = { lt: opts.cursor };
    const rows = await this.prisma.read.vehicle.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    // Enriquecimiento BATCHED (anti-N+1) vía la fuente compartida con getById(): la ficha técnica
    // (segment/energySource/efficiency/seats) vive en el modelSpec, no en Vehicle; sin esto el panel de
    // Flota no puede VERIFICAR el match vehículo↔config (F1), y el detalle mostraría menos que la lista.
    const enriched = await this.enrichWithSpec(rows);
    return toPage(enriched, limit);
  }

  /**
   * Alta self-service: el conductor registra su propio vehículo durante el onboarding.
   * Reglas: placa válida (plateSchema), año elegible (BR-D04).
   *
   * IDEMPOTENCIA OWNERSHIP-AWARE: el wizard del onboarding reintenta el paso (red flaky, doble tap,
   * volver atrás y reenviar). La placa es `@unique` GLOBAL — un 409 a secas bloqueaba al conductor
   * reenviando SU PROPIA placa. Ahora:
   *  - placa de ESTE conductor → no-op idempotente: se ACTUALIZA el vehículo con lo reenviado
   *    (correcciones del wizard: modelo/snapshot, año, color, tipo) y se devuelve. NO se re-emite
   *    `vehicle_registered` (el alta ya ocurrió una vez; un duplicado mentiría el ciclo de vida).
   *  - placa de OTRO conductor → conflicto de dominio real (ConflictError).
   *  - placa libre → alta nueva (active=false, pendiente de verificación) + `vehicle_registered`
   *    por outbox en la MISMA transacción.
   *
   * Race-safety (TOCTOU): el findUnique-luego-escribe NO es atómico entre dos altas concurrentes con
   * la MISMA placa. El `@unique` global es la barrera dura: si la carrera se cuela, el `create` lanza
   * P2002 y lo capturamos para RE-RESOLVER el dueño (no un 500): re-leemos por placa y caemos al
   * camino idempotente (mismo dueño) o al de conflicto (otro dueño). Espeja ConsentsService.record.
   *
   * `driverId` es el id de PERFIL `Driver` de identity (el que viaja propagado desde el driver-bff y el
   * mismo que usa el admin-bff en el purge/approve); fleet lo persiste tal cual en `Vehicle.driverId`.
   */
  async registerForDriver(
    driverId: string,
    input: RegisterDriverVehicleDto,
  ): Promise<DriverVehicleResponse> {
    const plate = parseOrThrow(plateSchema, input.plate.trim().toUpperCase(), 'plate');

    if (!isVehicleYearEligible(input.year, this.minYear)) {
      throw new ValidationError(
        `El vehículo debe ser del año ${this.minYear} o posterior (BR-D04)`,
        {
          year: input.year,
          minYear: this.minYear,
        },
      );
    }

    // LOTE 1 · LA CATEGORÍA DE LA TARJETA SE PREFIERE SOBRE EL HINT: si el alta trae la categoría MTC cruda,
    // el servidor DERIVA el tipo de ahí (M1→CAR, L*→MOTO) y el `vehicleType` del body pasa a ser un
    // HINT/fallback (solo se usa cuando la categoría NO es derivable: no soportada hoy, o alta SIN categoría).
    // OJO — esto NO es "server-authoritative": tanto `mtcCategory` como `vehicleType` son ASERCIÓN DEL CLIENTE
    // (OCR on-device del conductor), no un re-OCR de confianza del servidor. La corroboración real contra la
    // imagen de la tarjeta es la VERIFICACIÓN DEL OPERADOR en el panel admin (gate de operabilidad, pendiente)
    // + un futuro re-OCR server-side. Acá solo se prefiere una aserción del cliente (categoría) sobre la otra.
    const derivedType = input.mtcCategory
      ? mapMtcCategoryToVehicleType(input.mtcCategory)
      : null;
    const resolvedInput = { ...input, vehicleType: derivedType ?? input.vehicleType };

    // B5-2: si el conductor eligió un modelo del catálogo, make/model/vehicleType salen del spec
    // (server-authoritative); si no, caen al texto libre (acá ya con el tipo derivado de la categoría).
    // LOTE 3: en el alta del conductor (OCR onboarding) el texto libre pasa por el FUZZY-MATCH (link a un
    // aprobado parecido, o encolar source=OCR). El contexto `fuzzy` activa ese camino — el alta admin (create)
    // NO lo pasa. Resuelto ANTES de la transacción del vehículo (entidad de catálogo independiente).
    const snapshot = await this.resolveModelSnapshot(resolvedInput, {
      requestedBy: driverId,
      source: VehicleModelSource.OCR,
    });
    // LOTE 1: el registro está ABIERTO a todo tipo derivable (CAR|MOTO). NO se bloquea por operabilidad acá
    // (el gate de operabilidad/aprobación es de otro lote); el `@IsEnum(VehicleType)` del DTO ya garantiza
    // que el tipo es válido. La operabilidad para dispatch se resuelve aguas abajo, no en el alta.

    const existing = await this.prisma.read.vehicle.findUnique({ where: { plate } });
    if (existing) {
      return this.resolveExistingForDriver(driverId, existing, resolvedInput, snapshot);
    }

    let vehicle: Vehicle;
    try {
      vehicle = await this.prisma.write.$transaction(async (tx) => {
        const created = await tx.vehicle.create({
          data: {
            id: uuidv7(),
            plate,
            make: snapshot.make,
            model: snapshot.model,
            year: input.year,
            color: input.color?.trim() ?? '',
            vehicleType: snapshot.vehicleType,
            // LOTE 1: la categoría MTC cruda de la tarjeta (fuente de verdad del tipo). Null si no vino.
            mtcCategory: input.mtcCategory ?? null,
            modelSpecId: snapshot.modelSpecId,
            driverId,
            // Onboarding: pendiente de verificación, no se activa automáticamente.
            active: false,
          },
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: created.id,
            eventType: FleetEventType.VEHICLE_REGISTERED,
            envelope: buildFleetEvent(FleetEventType.VEHICLE_REGISTERED, {
              vehicleId: created.id,
              driverId,
              plate: created.plate,
              vehicleType: created.vehicleType,
              registeredAt: created.createdAt.toISOString(),
            }) as unknown as Prisma.InputJsonValue,
          },
        });

        return created;
      });
    } catch (err) {
      // Carrera perdida contra otra alta concurrente con la MISMA placa (el @unique global ganó).
      // Re-resolvemos el dueño en vez de un 500: mismo dueño → idempotente; otro → conflicto.
      if (isUniqueViolation(err, 'plate')) {
        const raced = await this.prisma.write.vehicle.findUnique({ where: { plate } });
        if (raced) return this.resolveExistingForDriver(driverId, raced, resolvedInput, snapshot);
      }
      throw err;
    }

    // LOTE 3 · DoS de la cola: el modelo OCR se encola SOLO ahora, tras el alta EXITOSA del vehículo (un alta
    // fallida o spam NO ensucia la cola del operador). Best-effort: si falla, el vehículo igual queda creado con
    // su freetext (ver enqueueOcrModel). Solo se llega acá por el camino del `create` real (NO el idempotente).
    if (snapshot.pendingOcrModel) {
      await this.enqueueOcrModel(snapshot.pendingOcrModel);
    }

    // El alta puede convertir al nuevo vehículo en el activo (si es el primero/único operable): lo
    // resolvemos sobre la flota completa del conductor para no mentir el `isActive` de la respuesta.
    const all = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(all);
    // Operabilidad documental REAL del vehículo recién dado de alta (sin SOAT/ITV operables → PENDING_REVIEW,
    // que es CORRECTO: un alta nace sin docs aprobados, no puede operar hasta que el operador los apruebe).
    const docsOperable = await this.vehicleDocsOperable(vehicle.id);
    return toDriverVehicleResponse(vehicle, active?.id === vehicle.id, docsOperable);
  }

  /**
   * Resuelve una placa YA existente en el alta self-service según el dueño:
   *  - de ESTE conductor → UPDATE idempotente (correcciones del wizard) SIN re-emitir el evento de alta.
   *  - de OTRO conductor (o flota del operador, driverId=null) → ConflictError de dominio.
   */
  private async resolveExistingForDriver(
    driverId: string,
    existing: Vehicle,
    input: RegisterDriverVehicleDto,
    // `snapshot.pendingOcrModel` NO se encola por este camino a propósito: es el UPDATE idempotente del wizard
    // (o el conflicto de otro dueño), NO un alta REAL nueva → no debe alimentar la cola del operador.
    snapshot: ModelSnapshot,
  ): Promise<DriverVehicleResponse> {
    if (existing.driverId !== driverId) {
      throw new ConflictError('Esa placa ya está registrada por otro conductor', {
        plate: existing.plate,
      });
    }

    // Mismo dueño: reenvío del wizard ⇒ actualizamos con lo último (snapshot/año/color/tipo). NO
    // tocamos `active` (sigue pendiente de verificación) ni re-emitimos `vehicle_registered`.
    const updated = await this.prisma.write.vehicle.update({
      where: { id: existing.id },
      data: {
        make: snapshot.make,
        model: snapshot.model,
        year: input.year,
        color: input.color?.trim() ?? '',
        vehicleType: snapshot.vehicleType,
        // LOTE 1: re-scan/corrección del wizard puede traer una categoría nueva → la persistimos.
        mtcCategory: input.mtcCategory ?? null,
        modelSpecId: snapshot.modelSpecId,
      },
    });

    const all = await this.prisma.read.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(all);
    const docsOperable = await this.vehicleDocsOperable(updated.id);
    return toDriverVehicleResponse(updated, active?.id === updated.id, docsOperable);
  }

  /**
   * Resuelve marca/modelo/tipo del alta. Compartido por el alta del CONDUCTOR (B5-2) y la del OPERADOR
   * (F4 · C2) — la misma fuente única, sin duplicar la lógica del catálogo. Caminos:
   *  - CON modelSpecId → se eligió un modelo del CATÁLOGO: se valida que exista y esté APPROVED y se
   *    snapshotea make/model/vehicleType del spec (server-authoritative; ignora el texto libre).
   *  - SIN modelSpecId, con `fuzzy` (alta del conductor · OCR) → el texto libre pasa por el FUZZY-MATCH del
   *    catálogo (LOTE 3): si hay un aprobado parecido (>= umbral), se LINKEA ese modelSpecId y se snapshotea
   *    del spec (reusa el modelo curado, evita duplicados "TOYOTA" vs "Toyota Yaris"); si NO, se ENCOLA con
   *    requestModel(source: OCR) → PENDING_REVIEW (el catálogo crece de registros reales, el operador lo cura)
   *    y el vehículo se crea con el FREETEXT (modelSpecId null, snapshot del texto libre).
   *  - SIN modelSpecId, sin `fuzzy` (alta admin/seed) → texto libre legacy puro: exige make+model y usa el
   *    vehicleType del body (default CAR). El operador carga deliberadamente, no se auto-encola.
   *
   * FRONTERA TRANSACCIONAL (monolito-1-DB, ACID, NO saga): el modelo del catálogo es un AGREGADO independiente
   * del vehículo. Este método es READ-ONLY: el link (fuzzy-match) es una lectura, y el encolado (write) NO ocurre
   * acá — cuando no hay match devuelve `pendingOcrModel` para que el caller lo encole DESPUÉS de que el vehículo
   * se creó con éxito (best-effort, fuera de la tx ACID del vehículo). Así SOLO un alta real alimenta la cola del
   * operador: un alta fallida (placa duplicada de otro conductor, etc.) o spam con texto variado NO la ensucia.
   */
  private async resolveModelSnapshot(
    input: {
      modelSpecId?: string;
      make?: string;
      model?: string;
      vehicleType?: VehicleType;
      year?: number;
    },
    fuzzy?: { requestedBy: string; source: VehicleModelSource },
  ): Promise<ModelSnapshot> {
    if (input.modelSpecId) {
      const spec = await this.prisma.read.vehicleModelSpec.findFirst({
        where: { id: input.modelSpecId, status: VehicleModelStatus.APPROVED },
      });
      if (!spec) {
        throw new ValidationError('El modelo seleccionado no existe o no está aprobado', {
          modelSpecId: input.modelSpecId,
        });
      }
      return {
        make: spec.make,
        model: spec.model,
        vehicleType: spec.vehicleType,
        modelSpecId: spec.id,
        pendingOcrModel: null,
      };
    }

    const make = input.make?.trim();
    const model = input.model?.trim();
    if (!make || !model) {
      throw new ValidationError('Indicá la marca y el modelo, o elegí un modelo del catálogo', {
        make: make ?? null,
        model: model ?? null,
      });
    }
    const vehicleType = input.vehicleType ?? VehicleType.CAR;

    // LOTE 3 · alta del conductor con texto libre (OCR): fuzzy-match (read) → link o señalar pendiente. El alta
    // admin no pasa `fuzzy` y cae directo al freetext legacy de abajo (sin encolar, carga deliberada).
    if (fuzzy) {
      const match = await this.vehicleModels.findBestApprovedMatch(make, model, vehicleType);
      if (match) {
        // Match fuerte: reusa el modelo curado (server-authoritative) y evita el duplicado.
        return {
          make: match.spec.make,
          model: match.spec.model,
          vehicleType: match.spec.vehicleType,
          modelSpecId: match.spec.id,
          pendingOcrModel: null,
        };
      }
      // Sin match: NO encolamos acá (sería antes de crear el vehículo → DoS de la cola: un conductor inflaría
      // el catálogo reenviando texto variado SIN alta real). Devolvemos la señal para que el caller encole SOLO
      // si el vehículo se crea con éxito. El vehículo queda con el freetext (modelSpecId null) — degradación honesta.
      return {
        make,
        model,
        vehicleType,
        modelSpecId: null,
        pendingOcrModel: { make, model, vehicleType, year: input.year, ...fuzzy },
      };
    }

    return { make, model, vehicleType, modelSpecId: null, pendingOcrModel: null };
  }

  /**
   * LOTE 3 · encola un modelo NUEVO nacido del OCR (sin match en el catálogo) reusando requestModel. Se llama
   * POST-éxito del alta del vehículo (best-effort): SOLO un registro REAL alimenta la cola del operador. El alta
   * del vehículo solo conoce `year` (no el rango ni los asientos del catálogo): usamos yearFrom=yearTo=year y
   * dejamos que el OPERADOR complete la ficha al aprobar (no inventamos asientos). `seats` lo fija el operador;
   * acá va un placeholder mínimo válido (1) que el approve corrige.
   *
   * BEST-EFFORT (no revierte el vehículo): si el encolado falla, el vehículo YA está creado con su freetext
   * (modelSpecId null) — el modelo pendiente es nice-to-have, lo recupera el operador o el próximo alta. NO se
   * traga el error en silencio:
   *  - ConflictError (dedup): otro conductor ya lo pidió/curó → es el resultado deseado, se loguea como debug.
   *  - Cualquier otro error: se loguea como error (NO se propaga: el alta del vehículo ya tuvo éxito).
   */
  private async enqueueOcrModel(pending: PendingOcrModel): Promise<void> {
    const yearValue = pending.year ?? new Date().getUTCFullYear();
    try {
      await this.vehicleModels.requestModel(
        pending.requestedBy,
        {
          make: pending.make,
          model: pending.model,
          yearFrom: yearValue,
          yearTo: yearValue,
          vehicleType: pending.vehicleType,
          // El operador fija los asientos reales al aprobar; placeholder mínimo válido (ficha incompleta es
          // la norma de un PENDING_REVIEW).
          seats: 1,
        },
        pending.source,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        // Dedup: el modelo ya está en la cola/curado. Resultado deseado; no es un fallo. Visible en debug.
        this.logger.debug(
          `Modelo OCR ya solicitado/curado (dedup), no se re-encola: ${pending.make} ${pending.model}`,
        );
        return;
      }
      // Fallo inesperado del encolado post-éxito: el vehículo YA quedó creado con freetext. No revertimos ni
      // propagamos (el alta tuvo éxito), pero NO lo tragamos en silencio: queda en el log para diagnóstico.
      this.logger.error(
        `No se pudo encolar el modelo OCR pendiente tras el alta (${pending.make} ${pending.model}); el vehículo quedó con freetext (modelSpecId=null)`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Rehidrata los vehículos del conductor (más recientes primero), marcando cuál es el ACTIVO. */
  async listForDriver(driverId: string): Promise<DriverVehicleResponse[]> {
    const vehicles = await this.prisma.read.vehicle.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
    });
    const active = pickActiveVehicle(vehicles);
    // ANTI-N+1: los docs requeridos de TODA la flota del conductor en UNA query, agrupados por vehicleId.
    const operableById = await this.vehicleDocsOperableMap(vehicles.map((v) => v.id));
    return vehicles.map((v) =>
      toDriverVehicleResponse(v, v.id === active?.id, operableById.get(v.id) ?? false),
    );
  }

  /**
   * Vehículo ACTIVO (operado) del conductor, server-authoritative: el de `selectedAt` más reciente con
   * docs vigentes (o el más reciente registrado si ninguno fue seleccionado). `null` si no tiene ninguno
   * operable. Lo usa el driver-bff para sellar el tipo en el ping (sin confiar en lo que declara la app).
   */
  async getActiveVehicle(driverId: string): Promise<DriverVehicleResponse | null> {
    // READ-YOUR-WRITES (primario, NO réplica): `pickActiveVehicle` decide el activo por `selectedAt`,
    // el MISMO campo que escribe `setActiveVehicle` en `prisma.write`. Leerlo de `read` (réplica) expone
    // el swap al lag → un cambio de vehículo recién hecho no se vería, reabriendo el TOCTOU aguas arriba
    // en el driver-bff (ADR-017 §5(d) vector 4 / landmine de réplica). Por eso este read va al primario,
    // según la advertencia del wrapper read-write.ts: "NUNCA leer de `read` un registro que se acaba de
    // escribir en un flujo crítico; usar `write`". Las lecturas no-críticas de abajo (certs, docs del
    // vehículo, catálogo de specs) quedan en `read`: no las toca el swap.
    const vehicles = await this.prisma.write.vehicle.findMany({ where: { driverId } });
    const active = pickActiveVehicle(vehicles);
    if (!active) return null;
    // B5-3.2 · certificaciones de operador VIGENTES del conductor (del MISMO driverId; ownerType DRIVER).
    // El driver-bff las sella en el ping y dispatch gatea las verticales FAIL-CLOSED. Índice [ownerType,
    // ownerId]; el endpoint lo cachea el driver-bff (TTL 20s), no es hot-path directo.
    const docs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.DRIVER, ownerId: driverId },
    });
    const certifications = validCertificationsOf(docs);
    // Operabilidad documental del vehículo OPERADO: sus docs requeridos (SOAT+ITV) son ownerType=VEHICLE,
    // ownerId=active.id (NO los certs DRIVER de arriba). Si NO está operable, NO se crashea: el `status`
    // deriva a PENDING_REVIEW correctamente y el driver-bff/dispatch sellan seats/segment solo cuando opera.
    const vehicleDocs = await this.prisma.read.fleetDocument.findMany({
      where: { ownerType: FleetOwnerType.VEHICLE, ownerId: active.id },
    });
    const docsOperable = hasRequiredVehicleDocsOperable(vehicleDocs);
    const base: DriverVehicleResponse = {
      ...toDriverVehicleResponse(active, true, docsOperable),
      certifications,
    };
    // B5-3 · enriquece SOLO el vehículo activo con seats/segment del modelSpec elegido, para que el
    // driver-bff los selle en el ping (eligibilidad de oferta en dispatch). Legacy sin modelSpecId →
    // sin attrs (degradación honesta: dispatch no restringe a ese conductor).
    if (!active.modelSpecId) return base;
    const spec = await this.prisma.read.vehicleModelSpec.findUnique({
      where: { id: active.modelSpecId },
    });
    if (!spec) return base;
    return { ...base, seats: spec.seats, segment: spec.segment ?? undefined };
  }

  /**
   * Selecciona el vehículo ACTIVO del conductor (marca `selectedAt = ahora`, así gana por recencia).
   * Anti-IDOR: el vehículo debe ser de ESTE conductor (si no → NotFound, no se filtra existencia ajena).
   * No se puede activar un vehículo con docs VENCIDOS (BR-D04). Idempotente: re-seleccionar el mismo es ok.
   */
  async setActiveVehicle(driverId: string, vehicleId: string): Promise<DriverVehicleResponse> {
    const vehicle = await this.prisma.read.vehicle.findUnique({ where: { id: vehicleId } });
    if (vehicle?.driverId !== driverId) {
      throw new NotFoundError('Vehículo no encontrado');
    }
    if (vehicle.docStatus === VehicleDocStatus.EXPIRED) {
      throw new ValidationError('No podés operar un vehículo con documentos vencidos', {
        vehicleId,
        docStatus: vehicle.docStatus,
      });
    }
    const updated = await this.prisma.write.vehicle.update({
      where: { id: vehicleId },
      data: { selectedAt: new Date() },
    });
    const docsOperable = await this.vehicleDocsOperable(updated.id);
    return toDriverVehicleResponse(updated, true, docsOperable);
  }
}

/**
 * Proyecta un Vehicle al shape de respuesta self-service con el estado de revisión DERIVADO de señales reales.
 * `docsOperable` (¿tiene SOAT+ITV presentes+aprobados+vigentes?) lo precomputa el caller desde los docs del
 * vehículo (ownerType=VEHICLE) — junto con `modelSpecId != null` decide ACTIVE vs PENDING_REVIEW.
 */
function toDriverVehicleResponse(
  vehicle: Vehicle,
  isActive: boolean,
  docsOperable: boolean,
): DriverVehicleResponse {
  return {
    id: vehicle.id,
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    vehicleType: vehicle.vehicleType,
    docStatus: vehicle.docStatus,
    status: deriveVehicleReviewStatus({ docsOperable, modelSpecId: vehicle.modelSpecId }),
    isActive,
  };
}
