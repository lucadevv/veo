/**
 * CatalogOperabilityService — el corazón del SEAM catálogo↔operabilidad (ADR 013).
 *
 * PROBLEMA que cierra: hasta ahora, si el admin DESACTIVABA del catálogo la última oferta de una CLASE de
 * vehículo (p.ej. apagaba "VEO Moto"), los conductores de esa clase seguían pudiendo iniciar turno, quedar
 * AVAILABLE y publicar GPS — operaban una clase que el producto ya no ofrece (incoherente). Este servicio,
 * alimentado por `catalog.updated` (que emite trip-service, dueño del catálogo), deriva las clases operables y
 * SUSPENDE a los conductores de la clase apagada (hold CATEGORY_DISABLED en identity → `startShift` corta + el
 * enforcement en vivo baja a los que ya estén en línea); al RE-activar la clase, los reincorpora automáticamente.
 *
 * DECISIONES CLAVE:
 *  1. AUTORITATIVO DESDE EL PAYLOAD (no re-lectura): el set de clases operables se deriva del PAYLOAD del evento
 *     con la función PURA `resolveCatalog`/`operableVehicleClasses` de @veo/shared-types (la base `OFFERINGS` es
 *     CÓDIGO, determinista; el overlay viaja en el evento). NUNCA se re-lee el catálogo de trip por REST: así un
 *     blip/caída de trip-service NO puede disparar una suspensión en masa. (El provider con fallback conservador
 *     de `OperableVehicleClassesProvider` es para el gate de ALTA, no para decidir holds.)
 *  2. DELTA, no absoluto: se compara el set NUEVO contra el PREVIO persistido (`CatalogOperableState`, singleton).
 *     Solo se actúa sobre las clases que EFECTIVAMENTE cambiaron de operabilidad → un `catalog.updated` que no
 *     altera ninguna clase (un ajuste de precio) NO toca ningún hold. Baseline sin fila = el default estático de
 *     código (lo shippeado) → un cold-start reconcilia contra el default, no contra "nada".
 *  3. IDEMPOTENTE + monotónico: `version` del catálogo es monotónica; un evento con `version ≤` a la guardada se
 *     DESCARTA (re-entrega Kafka / reordenamiento at-least-once). Aguas abajo, los holds de identity dedup-ean por
 *     su `@@unique`, así que re-emitir el mismo delta es no-op.
 *
 * SUJETO de los eventos: se keyea por `userId` (= `Vehicle.driverId`, que ES el User.id — fleet NO traduce a id
 * de perfil Driver; identity resuelve User.id → Driver.id en su consumer, igual que la vía de ITV). El vehículo
 * que decide la clase del conductor es su OPERADO (`pickActiveVehicle`, la MISMA regla server-authoritative que
 * usan el gate de alta y el sweeper de ITV) — no cualquier vehículo suyo.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  operableVehicleClasses,
  resolveCatalog,
  OPERABLE_VEHICLE_CLASSES,
  VehicleClass, // valor + tipo (alias de VehicleType): `Object.values(VehicleClass)` da ['CAR','MOTO'].
  type OfferingCatalogOverlay,
  type OfferingId,
  type OfferingOverride,
} from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { pickActiveVehicle } from '../vehicles/vehicle-rules';
import { buildFleetEvent, FleetEventType, type DriverSuspendedPayload } from './fleet-events';
import type { DriverReactivatedPayload } from './fleet-events';
import { Prisma } from '../generated/prisma';

/** Singleton del estado delta (una sola fila; el catálogo es global). */
const STATE_ID = 'GLOBAL';

/** Tamaño de lote para emitir eventos y para paginar la resolución de conductores afectados. */
const CHUNK = 500;

/** El overlay del catálogo tal como viaja en `catalog.updated` (ya validado por el schema central). */
export interface CatalogOverlayPayload {
  overrides: readonly { id: string; enabled: boolean; mode?: 'PUJA' | 'FIXED' }[];
  version: number;
}

export interface CatalogOperabilityResult {
  /** El evento era stale (version ≤ la ya aplicada) → no se hizo nada. */
  skipped: boolean;
  version: number;
  /** Clases que pasaron de operable→NO-operable en este evento. */
  disabledClasses: VehicleClass[];
  /** Clases que pasaron de NO-operable→operable en este evento. */
  enabledClasses: VehicleClass[];
  /** Conductores a los que se les emitió suspensión por catálogo. */
  suspended: number;
  /** Conductores a los que se les emitió reincorporación por catálogo. */
  reactivated: number;
}

@Injectable()
export class CatalogOperabilityService {
  private readonly logger = new Logger(CatalogOperabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aplica un `catalog.updated`: deriva las clases operables del payload, computa el delta contra el estado previo
   * y emite las suspensiones/reincorporaciones por catálogo. Público para el consumer y para los tests de negocio.
   */
  async applyCatalogUpdate(
    payload: CatalogOverlayPayload,
    now = new Date(),
  ): Promise<CatalogOperabilityResult> {
    const newOperable = this.deriveOperableClasses(payload);
    const newSet = new Set<string>(newOperable);

    // Estado PREVIO: la fila persistida, o el default ESTÁTICO de código si nunca se procesó un evento (baseline
    // honesto = lo que el sistema shippeó, no "nada" — un cold-start reconcilia contra el default).
    const prev = await this.prisma.read.catalogOperableState.findUnique({ where: { id: STATE_ID } });
    const prevVersion = prev?.version ?? 0;
    const prevClasses = prev?.operableClasses ?? [...OPERABLE_VEHICLE_CLASSES];
    const prevSet = new Set<string>(prevClasses);

    const empty = (): CatalogOperabilityResult => ({
      skipped: true,
      version: prevVersion,
      disabledClasses: [],
      enabledClasses: [],
      suspended: 0,
      reactivated: 0,
    });

    // GUARD MONOTÓNICO: un evento con version ≤ la aplicada es una re-entrega o llegó reordenado → descartar
    // (idempotencia). Estrictamente-mayor es la ÚNICA condición para procesar.
    if (payload.version <= prevVersion) return empty();

    // DELTA (tipado desde el enum, no desde la columna string[]): clases que se APAGARON (estaban en el previo y
    // ya no están operables) y clases que se ENCENDIERON (no estaban y ahora sí). Si el catálogo quedó sin NINGUNA
    // clase operable, `newSet` vacío → todas las previas caen (defensivo).
    const disabled = classesOf(prevClasses).filter((c) => !newSet.has(c));
    const enabled = newOperable.filter((c) => !prevSet.has(c));

    // Sin cambios de clase → NO se toca ningún hold. Igual AVANZAMOS el puntero de versión (monotónico) para que
    // futuros eventos stale se filtren y para registrar que este snapshot ya fue visto. Una sola escritura barata.
    if (disabled.length === 0 && enabled.length === 0) {
      await this.persistState(payload.version, newOperable);
      return {
        skipped: false,
        version: payload.version,
        disabledClasses: [],
        enabledClasses: [],
        suspended: 0,
        reactivated: 0,
      };
    }

    // Resolvemos los conductores afectados de CADA lado (su vehículo OPERADO es de la clase que cambió) y emitimos.
    // El puntero de versión se AVANZA AL FINAL (persistState): si crasheamos entre medio, la re-entrega recomputa
    // el MISMO delta contra el estado previo intacto y re-emite (idempotente aguas abajo por el unique del hold).
    const suspendedUsers = disabled.length ? await this.driversOperating(disabled) : [];
    const reactivatedUsers = enabled.length ? await this.driversOperating(enabled) : [];

    await this.emitSuspensions(suspendedUsers, now);
    await this.emitReactivations(reactivatedUsers);
    await this.persistState(payload.version, newOperable);

    return {
      skipped: false,
      version: payload.version,
      disabledClasses: disabled,
      enabledClasses: enabled,
      suspended: suspendedUsers.length,
      reactivated: reactivatedUsers.length,
    };
  }

  /**
   * Deriva las CLASES operables del PAYLOAD con la función pura compartida (DRY con el default estático y el gate
   * de alta). `resolveCatalog` aplica `enabled = override?.enabled ?? spec.defaultEnabled` e ignora ids que no
   * existen en la base de código; `operableVehicleClasses` devuelve el set de clases con ≥1 oferta activa.
   */
  private deriveOperableClasses(payload: CatalogOverlayPayload): VehicleClass[] {
    const overlay: OfferingCatalogOverlay = {
      version: payload.version,
      // El wire trae `id: string`; `resolveCatalog` matchea por id contra la base e IGNORA los desconocidos, así
      // que el cast a OfferingId es seguro (un id inválido no aporta al resultado). mode/precio no afectan el set.
      overrides: payload.overrides.map(
        (o): OfferingOverride => ({ ...o, id: o.id as OfferingId }),
      ),
    };
    return operableVehicleClasses(resolveCatalog(overlay));
  }

  /**
   * Conductores (userIds = `Vehicle.driverId`) cuyo vehículo OPERADO (pickActiveVehicle) es de alguna de las
   * `classes` dadas. Paginado por vehículo y batcheado por conductor (espeja el pase de ITV del sweeper): primero
   * acota a los dueños de ≥1 vehículo de esas clases, luego resuelve el vehículo operado de cada uno y se queda con
   * los que operan la clase. Dedupe por conductor (un conductor con N vehículos aparece una sola vez).
   */
  private async driversOperating(classes: VehicleClass[]): Promise<string[]> {
    const affected = new Set<string>();
    const seen = new Set<string>();
    let cursorId: string | undefined;
    for (;;) {
      // Dueños candidatos: vehículos de las clases objetivo con conductor. El sujeto es el CONDUCTOR, así que
      // deduplicamos por driverId cross-página con `seen` antes de resolver su vehículo operado. `VehicleClass`
      // (alias de @veo/shared-types) === el `VehicleType` de Prisma (mismos literales) → se pasa directo al filtro.
      const page = await this.prisma.read.vehicle.findMany({
        where: { driverId: { not: null }, vehicleType: { in: classes } },
        select: { id: true, driverId: true },
        orderBy: { id: 'asc' },
        take: CHUNK,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (page.length === 0) break;
      cursorId = page[page.length - 1]?.id;

      const userIds = [
        ...new Set(page.map((v) => v.driverId).filter((id): id is string => !!id)),
      ].filter((id) => !seen.has(id));
      for (const id of userIds) seen.add(id);

      if (userIds.length > 0) {
        // TODOS los vehículos de los candidatos (incluye otras clases): pickActiveVehicle elige el operado.
        const all = await this.prisma.read.vehicle.findMany({
          where: { driverId: { in: userIds } },
          select: { driverId: true, vehicleType: true, docStatus: true, selectedAt: true, createdAt: true },
        });
        const byUser = new Map<string, typeof all>();
        for (const v of all) {
          if (!v.driverId) continue;
          const arr = byUser.get(v.driverId) ?? [];
          arr.push(v);
          byUser.set(v.driverId, arr);
        }
        for (const userId of userIds) {
          const active = pickActiveVehicle(byUser.get(userId) ?? []);
          // El conductor se ve afectado SOLO si su vehículo OPERADO es de la clase que cambió (no cualquiera suyo).
          if (active && classes.includes(active.vehicleType)) affected.add(userId);
        }
      }
      if (page.length < CHUNK) break;
    }
    return [...affected];
  }

  /** Emite `fleet.driver_suspended` (holdCause CATEGORY_DISABLED, por userId) en lotes, cada lote su propia tx. */
  private async emitSuspensions(userIds: string[], now: Date): Promise<void> {
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      await this.prisma.write.$transaction(async (tx) => {
        for (const userId of chunk) {
          const payload: DriverSuspendedPayload = {
            userId,
            reason: 'Categoría de servicio desactivada por el operador (catálogo)',
            holdCause: 'CATEGORY_DISABLED',
            suspendedAt: now.toISOString(),
          };
          await this.enqueue(tx, userId, buildFleetEvent(FleetEventType.DRIVER_SUSPENDED, payload));
        }
      });
    }
  }

  /** Emite `fleet.driver_reactivated` (holdCause CATEGORY_DISABLED, por userId) en lotes, cada lote su propia tx. */
  private async emitReactivations(userIds: string[]): Promise<void> {
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      await this.prisma.write.$transaction(async (tx) => {
        for (const userId of chunk) {
          const payload: DriverReactivatedPayload = {
            userId,
            reason: 'Categoría de servicio re-activada por el operador (catálogo)',
            holdCause: 'CATEGORY_DISABLED',
            reactivatedAt: new Date().toISOString(),
          };
          await this.enqueue(
            tx,
            userId,
            buildFleetEvent(FleetEventType.DRIVER_REACTIVATED, payload),
          );
        }
      });
    }
  }

  /** Persiste el estado delta (version + set operable). Upsert del singleton. */
  private async persistState(version: number, operable: VehicleClass[]): Promise<void> {
    await this.prisma.write.catalogOperableState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, version, operableClasses: operable },
      update: { version, operableClasses: operable },
    });
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

/** El set de valores VÁLIDOS del enum de clases (para filtrar la columna `string[]` sin arrastrar basura). */
const VALID_CLASSES = new Set<string>(Object.values(VehicleClass));

/** Normaliza un `string[]` (columna DB) a `VehicleClass[]` conservando SOLO los valores válidos del enum. */
function classesOf(values: readonly string[]): VehicleClass[] {
  return values.filter((v): v is VehicleClass => VALID_CLASSES.has(v));
}
