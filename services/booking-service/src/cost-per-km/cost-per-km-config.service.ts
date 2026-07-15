/**
 * CostPerKmConfigService (F2.5) — el costo de OPERACIÓN por km (céntimos Int) que alimenta DIRECTO el tope
 * legal de cost-sharing (CostCapService), editable EN CALIENTE por el admin, POR PAÍS.
 *
 * CAMBIO DE MODELO (vs F2.5 viejo): antes el costo/km del carpooling se DERIVABA del precio de energía vivo
 * de trip-service (precio_gasolina ÷ rendimiento). MAL: (1) solo combustible (sin desgaste → bajo), (2) sin
 * peajes, (3) derivado en vez de un valor real. AHORA el costo/km es un valor de OPERACIÓN real (combustible
 * + desgaste/depreciación, estilo "IRS mileage rate") que el ADMIN fija por país (CostPerKmConfig en DB). El
 * peaje viaja aparte (lo declara el conductor por viaje; lo suma el cost-cap). booking ya NO le pega a
 * trip-service por energía para el tope.
 *
 * Espeja CommissionService de payment-service (config editable + version CAS + cache + degradación al env):
 *  - `getConfig(pais)` / `getCostPerKmCents(pais)`: el valor vigente (DB), o el env de FALLBACK si la config
 *    no está disponible (DB sin migrar / país no sembrado / error transitorio) — NUNCA rompe el publish.
 *  - `listConfigs()`: PE + EC para el panel admin (GET).
 *  - `replace(pais, costPerKmCents, expectedVersion)`: PUT — REEMPLAZA el costo/km de un país, bumpea
 *    `version` (CAS optimista) y persiste. Autoaplica: invalida el cache in-proc → el tope usa el nuevo valor.
 *
 * SIN evento Kafka cross-réplica: el admin edita rara vez y la fuente del cambio es el PUT a ESTE servicio
 * (no un evento de otro). El cache es un slot por país con TTL corto; el PUT invalida la réplica que lo
 * atiende de inmediato y las demás convergen al vencer el TTL (degradación honesta, sin acoplar a Kafka).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConflictError, ValidationError } from '@veo/utils';
import {
  costPerKmCentsFor,
  isPais,
  PAIS,
  type CostPerKmConfig,
  type Pais,
} from '../domain/cost-cap';
import {
  COST_PER_KM_CONFIG_REPO,
  type CostPerKmConfigRepository,
  type PersistedCostPerKm,
} from './cost-per-km-config.repository';
import { bumpCostPerKmDegraded } from '../published-trips/cost-cap-metrics';

/** Token DI del objeto de FALLBACK desde env (COST_PER_KM_CENTS_PE/EC). Provisto por el módulo. */
export const COST_PER_KM_ENV_FALLBACK = Symbol('COST_PER_KM_ENV_FALLBACK');

/** Token DI (opcional) del TTL del cache; default 10s — espeja el slot corto de las otras configs de pricing. */
export const COST_PER_KM_CACHE_TTL_MS = Symbol('COST_PER_KM_CACHE_TTL_MS');

/** Cota de cordura del costo/km en el dominio (defensa en profundidad sobre el DTO): S/0.01 .. S/100 por km. */
const MIN_COST_PER_KM_CENTS = 1;
const MAX_COST_PER_KM_CENTS = 10_000;

@Injectable()
export class CostPerKmConfigService {
  private readonly logger = new Logger(CostPerKmConfigService.name);

  /** Cache in-proc por país (un slot cada uno). SOLO lecturas exitosas; el PUT del país lo invalida. */
  private readonly cache = new Map<Pais, { value: PersistedCostPerKm; expiresAt: number }>();

  constructor(
    @Inject(COST_PER_KM_CONFIG_REPO) private readonly repo: CostPerKmConfigRepository,
    @Inject(COST_PER_KM_ENV_FALLBACK) private readonly envConfig: CostPerKmConfig,
    @Optional()
    @Inject(COST_PER_KM_CACHE_TTL_MS)
    private readonly cacheTtlMs = 10_000,
  ) {}

  /**
   * GET vigente del costo/km de un país: el valor persistido (DB) + version + updatedAt. País no soportado →
   * ValidationError tipado. Sin fila / error de DB → DEGRADACIÓN HONESTA al env (version 0), SIN cachear el
   * fallback (para reintentar la lectura real). El tope legal NUNCA debe romperse porque la config no esté.
   */
  async getConfig(pais: string): Promise<PersistedCostPerKm> {
    if (!isPais(pais)) {
      throw new ValidationError('País no soportado para el cálculo del tope de cost-sharing', {
        pais,
      });
    }
    const now = Date.now();
    const cached = this.cache.get(pais);
    if (cached && cached.expiresAt > now) return cached.value;

    let value: PersistedCostPerKm;
    try {
      const persisted = await this.repo.find(pais);
      value = persisted ?? this.envFallback(pais);
      if (persisted && this.cacheTtlMs > 0) {
        // Solo cacheamos el valor REAL persistido; el fallback se relee siempre (no nos clavamos en degradado).
        this.cache.set(pais, { value, expiresAt: now + this.cacheTtlMs });
      }
    } catch (err) {
      // Counter alertable: un valor SOSTENIDO = config rota (el tope aplicado diverge del del admin), no un blip.
      bumpCostPerKmDegraded('config_unavailable');
      this.logger.warn(
        `cost_per_km_config no disponible para ${pais}; degradando al env COST_PER_KM_CENTS_${pais} (${(err as Error).message})`,
      );
      return this.envFallback(pais);
    }
    return value;
  }

  /** Costo/km (céntimos Int) del país — el valor que el cost-cap consume directo (degradación honesta al env). */
  async getCostPerKmCents(pais: string): Promise<number> {
    return (await this.getConfig(pais)).costPerKmCents;
  }

  /** PE + EC para el panel admin (GET). Cada país por separado (incluye su fallback si no hay fila). */
  async listConfigs(): Promise<PersistedCostPerKm[]> {
    return Promise.all([this.getConfig(PAIS.PE), this.getConfig(PAIS.EC)]);
  }

  /**
   * PUT: REEMPLAZA el costo/km de un país, bumpea `version` (CAS) y persiste. Autoaplica: invalida el cache
   * in-proc del país → la próxima lectura del tope usa el nuevo valor de inmediato (misma réplica). País no
   * soportado / valor fuera de rango → ValidationError. CAS optimista: el UPDATE solo pega si la versión
   * vigente sigue siendo `expectedVersion` (si no, ConflictError 409 → sin lost update).
   */
  async replace(
    pais: string,
    costPerKmCents: number,
    expectedVersion: number,
  ): Promise<PersistedCostPerKm> {
    if (!isPais(pais)) {
      throw new ValidationError('País no soportado para el costo/km', { pais });
    }
    // Guard de dominio (defensa en profundidad sobre el DTO): céntimos Int en rango de cordura. Cero floats.
    if (
      !Number.isInteger(costPerKmCents) ||
      costPerKmCents < MIN_COST_PER_KM_CENTS ||
      costPerKmCents > MAX_COST_PER_KM_CENTS
    ) {
      throw new ValidationError(
        `el costo/km debe ser un entero en céntimos entre ${MIN_COST_PER_KM_CENTS} y ${MAX_COST_PER_KM_CENTS}`,
        { costPerKmCents },
      );
    }
    const nextVersion = expectedVersion + 1;

    const result = await this.repo.runInTx(async (tx) => {
      const updated = await tx.costPerKmConfig.updateMany({
        where: { pais, version: expectedVersion },
        data: { costPerKmCents, version: nextVersion },
      });

      let row: { version: number; updatedAt: Date };
      if (updated.count === 1) {
        const persisted = await tx.costPerKmConfig.findUnique({ where: { pais } });
        if (!persisted) throw new ConflictError('el costo/km desapareció durante el reemplazo');
        row = persisted;
      } else if (expectedVersion === 0) {
        // Primer write de un país sin fila. Si OTRO la creó en la carrera → conflicto, no lost update.
        const existing = await tx.costPerKmConfig.findUnique({ where: { pais } });
        if (existing) {
          throw new ConflictError(
            `el costo/km de ${pais} ya fue inicializado (v${existing.version}); recargá y reintentá`,
          );
        }
        row = await tx.costPerKmConfig.create({
          data: { pais, costPerKmCents, version: nextVersion },
        });
      } else {
        throw new ConflictError(
          `el costo/km de ${pais} cambió (esperabas v${expectedVersion}); recargá y reintentá`,
        );
      }
      return row;
    });

    this.cache.delete(pais); // autoaplica: el PUT y la lectura del tope viven en el mismo proceso.
    this.logger.log(
      `costo/km de ${pais} REEMPLAZADO → version ${result.version} (S/${costPerKmCents / 100}/km); cache invalidado`,
    );
    return {
      pais,
      costPerKmCents,
      version: result.version,
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  /** Snapshot de degradación honesta: el costo/km del env, version 0 (no hay config persistida). */
  private envFallback(pais: Pais): PersistedCostPerKm {
    return {
      pais,
      costPerKmCents: costPerKmCentsFor(pais, this.envConfig),
      version: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}
