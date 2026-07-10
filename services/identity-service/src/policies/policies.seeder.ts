/**
 * PoliciesSeeder — siembra IDEMPOTENTE del registro PBAC en el arranque del módulo (OnModuleInit).
 *
 * Garantiza que la tabla `Policy` contenga SIEMPRE las 16 keys del catálogo canónico (@veo/policy · ADR-024 §5):
 * inserta las que FALTEN con su estado seguro de default (`defaultEnabled` / `defaults` / `mandatory` / `family`)
 * y NO pisa las que el admin ya cambió (delega en `createMany(skipDuplicates)` del repo). Correrlo en cada boot
 * es un no-op salvo que aparezca una key nueva en el catálogo (self-healing: agregar una política al catálogo la
 * materializa sola en el próximo arranque). El seed marca `updatedBy:'system'` (no lo originó un operador) y NO
 * publica `policy.updated` (no es un cambio del admin; solo completa el catálogo).
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { POLICY_LIST } from '@veo/policy';
import { PoliciesRepository } from './policies.repository';
import { Prisma } from '../generated/prisma';

@Injectable()
export class PoliciesSeeder implements OnModuleInit {
  private readonly logger = new Logger(PoliciesSeeder.name);

  constructor(private readonly repo: PoliciesRepository) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  /** Inserta las políticas del catálogo que aún no existan. Devuelve cuántas se insertaron (0 = ya completo). */
  async seed(): Promise<number> {
    const rows: Prisma.PolicyCreateManyInput[] = POLICY_LIST.map((def) => ({
      key: def.key,
      family: def.family,
      enabled: def.defaultEnabled,
      params: def.defaults as Prisma.InputJsonValue,
      mandatory: def.mandatory,
      version: 1,
      updatedBy: 'system',
    }));

    const { count } = await this.repo.seedMissing(rows);
    if (count > 0) {
      this.logger.log(
        `seed PBAC: ${count} política(s) faltante(s) insertada(s) desde el catálogo ` +
          `(idempotente · no pisa cambios del admin)`,
      );
    }
    return count;
  }
}
