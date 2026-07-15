/**
 * DriverSuspensionService — mantiene la EXCLUSIÓN del pool de matching sincronizada con la suspensión
 * autoritativa del conductor (identity). Un conductor suspendido NO debe recibir ofertas FIXED aunque
 * siga pingeando GPS (su loc sigue viva en el hot-index): el `accept` ya lo frena fail-closed
 * (EligibilityGate.assertActiveDriver), y esto cierra la MEMBRESÍA del pool para NO ofertarle de gusto
 * (evita la oferta-desperdiciada + el match que se estanca hasta el sweep tras un accept 403).
 *
 * HOLDS-AWARE: la suspensión es MULTI-CAUSA (disciplinaria + doc/ITV → `suspendedAt` derivado de TODOS
 * los holds en identity). Suspender SIEMPRE excluye (cualquier hold ⇒ suspendido). Al REACTIVAR NO se
 * limpia a ciegas: un evento de reactivación cierra UNA causa, pero el conductor puede seguir suspendido
 * por otra → se re-valida `suspendedAt` autoritativo y solo se reincorpora al pool si quedó SIN holds.
 *
 * DOS EJES de entrada al set (ambos excluyen igual): el DISCIPLINARIO (`driver.suspended`/`reactivated`,
 * driverId de perfil directo) y el FLEET doc/ITV (`fleet.driver_suspended`/`reactivated`, clave dual
 * driverId|userId → onFleetSuspended/onFleetReactivated, Lote 2b). La reactivación de AMBOS limpia PRONTO
 * (holds-aware).
 *
 * AUTO-CURA (backstop de over-exclusion): el registry tiene TTL (RedisTtlExclusionRegistry). La reactivación
 * por evento es el camino RÁPIDO, pero el TTL la respalda en dos casos: (a) la CARRERA del eje fleet —
 * dispatch e identity consumen el MISMO `fleet.driver_reactivated` en paralelo, así que dispatch puede
 * re-validar `suspendedAt` antes de que identity confirme el quite del hold y leer estado viejo; (b) la
 * pérdida dura de un evento de reactivación. En ambos la exclusión EXPIRA sola y el conductor re-entra al
 * pool en vez de quedar shadow-baneado para siempre estando ACTIVO. El modo de falla queda del lado SEGURO
 * (re-admitir; el accept-gate fail-closed es la autoridad que 403ea a un suspendido que se cuele).
 *
 * Idempotente: excluir/limpiar repetidos son no-op (tolera la re-entrega at-least-once de Kafka).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SUSPENSION_REGISTRY, type ExclusionRegistry } from '../hot-index/hot-index.port';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';

/**
 * Sujeto de un evento del eje FLEET (doc/ITV). El conductor llega por UNA de dos claves (XOR garantizado
 * por el schema `fleetDriverSuspended`/`fleetDriverReactivated`):
 *  - `driverId` (id de PERFIL Driver) → vía DOCUMENTO crítico.
 *  - `userId` (User.id = `Vehicle.driverId`) → vía INSPECCIÓN técnica (ITV); se resuelve a id de perfil.
 */
export interface FleetDriverKey {
  driverId?: string;
  userId?: string;
}

@Injectable()
export class DriverSuspensionService {
  private readonly logger = new Logger(DriverSuspensionService.name);

  constructor(
    @Inject(SUSPENSION_REGISTRY) private readonly suspension: ExclusionRegistry,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClient,
  ) {}

  /**
   * Suspensión (cualquier causa): el conductor sale del pool de matching. No requiere re-validar identity
   * —un evento de suspensión YA implica `suspendedAt != null`—; excluir es idempotente.
   */
  async onSuspended(driverId: string): Promise<void> {
    await this.suspension.exclude(driverId);
    this.logger.log(`conductor ${driverId} excluido del pool de matching por suspensión`);
  }

  /**
   * Reactivación HOLDS-AWARE: re-valida `suspendedAt` autoritativo en identity y solo reincorpora al pool
   * si quedó SIN holds. Casos:
   *  - `found=false` (conductor inexistente/borrado) ⇒ limpia (no excluir un fantasma).
   *  - `suspendedAt == null` ⇒ reactivado de verdad ⇒ limpia.
   *  - `suspendedAt != null` ⇒ sigue suspendido por OTRO hold ⇒ permanece excluido.
   *
   * Error de red gRPC ⇒ RELANZA: el handler no-ackea y kafkajs RE-ENTREGA (at-least-once), así la
   * reactivación se re-procesa cuando identity vuelve — sin reincorporar un posible-suspendido a ciegas
   * ni dejar al reactivado colgado para siempre. (El `accept` fail-closed es el backstop de seguridad.)
   */
  async onReactivated(driverId: string): Promise<void> {
    const driver = await this.identity.getDriver(driverId);
    if (driver.found && driver.suspendedAt !== null) {
      this.logger.log(
        `conductor ${driverId} reactivado de una causa pero sigue suspendido por otro hold; permanece excluido`,
      );
      return;
    }
    await this.suspension.clear(driverId);
    this.logger.log(`conductor ${driverId} reincorporado al pool de matching (sin holds activos)`);
  }

  /**
   * SUSPENSIÓN por el eje FLEET (doc/ITV vencido): resuelve el sujeto a un Driver.id y lo excluye del pool,
   * igual que el eje disciplinario. La vía DOCUMENTO trae el Driver.id directo; la vía ITV trae el User.id
   * (se resuelve User.id → perfil por gRPC). Si el conductor no existe (purgado por derecho-al-olvido, o un
   * evento que llegó antes del onboarding) ⇒ no-op: no hay a quién excluir (espejo del guard de identity).
   */
  async onFleetSuspended(key: FleetDriverKey): Promise<void> {
    const driverId = await this.resolveDriverId(key);
    if (driverId === null) return;
    await this.onSuspended(driverId);
  }

  /**
   * REACTIVACIÓN por el eje FLEET (doc/ITV regularizado): resuelve el sujeto a Driver.id y reincorpora
   * HOLDS-AWARE (igual que el eje disciplinario: solo limpia si NO sobrevive otro hold). No-op si no existe.
   *
   * CARRERA acotada (sin regresión): dispatch e identity consumen el MISMO `fleet.driver_reactivated` en
   * paralelo (consumidores independientes). Si dispatch re-valida `suspendedAt` ANTES de que identity
   * confirme el quite del hold, lee estado viejo y MANTIENE excluido — el TTL de auto-cura lo reincorpora
   * igual (RedisTtlExclusionRegistry). El caso común (sin carrera) limpia al instante. Falla del lado SEGURO.
   */
  async onFleetReactivated(key: FleetDriverKey): Promise<void> {
    const driverId = await this.resolveDriverId(key);
    if (driverId === null) return;
    await this.onReactivated(driverId);
  }

  /**
   * Resuelve el sujeto de un evento fleet a un Driver.id de perfil. `driverId` (vía documento) YA es el id
   * de perfil. `userId` (vía ITV) se traduce por gRPC (identity es el dueño del mapeo User.id → Driver.id).
   * Devuelve null si el conductor no existe (⇒ no-op aguas arriba) o si el evento no trae clave (no debería:
   * el schema garantiza XOR). Un error de red gRPC se PROPAGA ⇒ el handler relanza ⇒ kafkajs reintenta.
   *
   * Criterio de presencia por TRUTHINESS (`key.driverId`, no `!== undefined`): espeja el `Boolean()` del XOR
   * del schema (`fleetDriverSuspended`/`Reactivated`) — un `''` cuenta como AUSENTE en ambos lados, así no se
   * resuelve a una key vacía si un producer llegara a emitir cadena vacía (hoy ninguno lo hace).
   */
  private async resolveDriverId(key: FleetDriverKey): Promise<string | null> {
    if (key.driverId) return key.driverId;
    if (key.userId) {
      const driver = await this.identity.getDriverByUser(key.userId);
      return driver.found ? driver.id : null;
    }
    return null;
  }
}
