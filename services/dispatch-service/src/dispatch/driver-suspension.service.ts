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
 * AUTO-CURA (backstop de over-exclusion): el registry de suspensión tiene TTL (RedisTtlExclusionRegistry).
 * `onReactivated` es el camino RÁPIDO (limpia al instante en el caso normal), pero NO es el único. El caso
 * que necesita el backstop es el MULTI-HOLD: el conductor entró al set por una DISCIPLINARIA; al levantarla
 * sobrevive un hold doc/ITV (se mantiene excluido, correcto); cuando regulariza ese doc/ITV, la vía
 * fleet-auto quita el ÚLTIMO hold pero NO emite `driver.reactivated` → sin la auto-cura quedaría excluido
 * para siempre ya estando ACTIVO. Con el TTL la exclusión EXPIRA sola y re-entra al pool. El modo de falla
 * queda del lado SEGURO (re-admitir; el accept-gate fail-closed es la autoridad que 403ea a un suspendido
 * que se cuele). Ver RedisTtlExclusionRegistry. (El eje fleet-auto PURO doc/ITV-only aún no entra al set:
 * dispatch no consume `fleet.driver_suspended` todavía — es el Lote 2b.)
 *
 * Idempotente: excluir/limpiar repetidos son no-op (tolera la re-entrega at-least-once de Kafka).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SUSPENSION_REGISTRY, type ExclusionRegistry } from '../hot-index/hot-index.port';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';

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
}
