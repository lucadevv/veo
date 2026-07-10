/**
 * KafkaCachedPolicyReader — el CLIENTE RUNTIME de `@veo/policy` (ADR-024 Fase 1 · §2/§4).
 *
 * Implementa la interfaz `PolicyReader` (async, contrato de `@veo/policy`) y el puerto síncrono
 * `PolicyReaderPort` (de `@veo/auth`, para los guards). Sirve TODA lectura desde un cache en memoria:
 *   1. CARGA INICIAL (OnModuleInit): trae todas las políticas del registro (identity-service) y las cachea.
 *      Si el registro es INALCANZABLE al arrancar, NO tira: deja el cache vacío → toda lectura cae al DEFAULT
 *      del catálogo (fail-safe, §4). Reintenta con backoff y loguea.
 *   2. FRESCURA POR EVENTO: `applyEvent` (lo llama el `PolicyUpdatedConsumer` ante `policy.updated`) actualiza
 *      la entrada de esa key → el cambio del superadmin surte efecto INMEDIATO, sin TTL.
 *   3. LECTURAS: cache → DEFAULT del catálogo → `fallback` del caller. NUNCA fail-open: ante ausencia de dato
 *      se devuelve el valor endurecido, jamás se afloja el candado.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PolicyReaderPort } from '@veo/auth';
import { getPolicyDef } from '../helpers.js';
import { isPolicyKey, type PolicyKey } from '../keys.js';
import type { PolicyReader } from '../reader.js';
import { overrideKey } from '../overlay.js';
import type { PolicyParams } from '../catalog.js';
import type { PolicyRegistryPort } from './registry.js';

/** Estado vigente cacheado de una política (traído del registro o de un `policy.updated`). */
interface CachedPolicy {
  enabled: boolean;
  params: PolicyParams;
  version: number;
}

/** Parche mínimo que aplica un `policy.updated` (el evento no porta `mandatory`; el cache no lo necesita). */
export interface PolicyUpdate {
  key: string;
  enabled: boolean;
  params: PolicyParams;
  version: number;
}

/** Estado cacheado de un override (traído del registro o de un `permission_override.updated`). */
interface CachedOverride {
  hidden: boolean;
  version: number;
}

/** Parche mínimo que aplica un `permission_override.updated` (audit-only fields no llegan al cache). */
export interface PermissionOverrideUpdate {
  role: string;
  permission: string;
  hidden: boolean;
  version: number;
}

const INITIAL_LOAD_MAX_ATTEMPTS = 3;
const INITIAL_LOAD_BASE_DELAY_MS = 300;

@Injectable()
export class KafkaCachedPolicyReader implements PolicyReader, PolicyReaderPort, OnModuleInit {
  private readonly logger = new Logger(KafkaCachedPolicyReader.name);
  private readonly cache = new Map<PolicyKey, CachedPolicy>();
  /** Overlay (ADR-025): overrides RESTADOS, keyed por `role|permission`. Vacío = sin overrides = rige la base. */
  private readonly overlay = new Map<string, CachedOverride>();

  constructor(private readonly registry: PolicyRegistryPort) {}

  async onModuleInit(): Promise<void> {
    await this.loadInitial();
    await this.loadOverrides();
  }

  /**
   * Carga inicial FAIL-SAFE: puebla el cache desde el registro. Reintenta errores transitorios con backoff;
   * si tras todos los intentos el registro sigue inalcanzable, deja el cache vacío y RETORNA (no throw) →
   * las lecturas caen al DEFAULT del catálogo (ADR §4). Boot resiliente: identity caído no tumba al servicio.
   */
  async loadInitial(): Promise<void> {
    for (let attempt = 1; attempt <= INITIAL_LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const rows = await this.registry.list();
        this.cache.clear();
        let loaded = 0;
        for (const row of rows) {
          if (!isPolicyKey(row.key)) continue; // key ajena al catálogo → se ignora (defensa)
          this.cache.set(row.key, {
            enabled: row.enabled,
            params: row.params,
            version: row.version,
          });
          loaded++;
        }
        this.logger.log(`cache de políticas poblada desde el registro: ${loaded} política(s)`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= INITIAL_LOAD_MAX_ATTEMPTS) {
          this.logger.warn(
            `registro de políticas inalcanzable en el arranque tras ${attempt} intento(s): ${message}. ` +
              `Sirviendo DEFAULTS del catálogo (fail-safe · ADR-024 §4).`,
          );
          return; // NO throw: el servicio arranca; las lecturas usan el DEFAULT endurecido.
        }
        const delay = INITIAL_LOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `carga inicial de políticas falló (intento ${attempt}/${INITIAL_LOAD_MAX_ATTEMPTS}), ` +
            `reintento en ${delay}ms: ${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Carga inicial del OVERLAY (ADR-025 §3), FAIL-SAFE y SIN retry: puebla el cache de overrides desde el
   * registro. A diferencia de las políticas, el endpoint `/internal/permission-overrides` puede AÚN NO EXISTIR
   * (identity lo expone en la Ola 2) → un 404/inalcanzable NO es transitorio: se traga el error y se deja el
   * overlay VACÍO = sin overrides = rige la base pura. Nunca throw (boot resiliente), nunca se resta por un fallo.
   */
  async loadOverrides(): Promise<void> {
    try {
      const rows = await this.registry.listOverrides();
      this.overlay.clear();
      for (const row of rows) {
        this.overlay.set(overrideKey(row.role, row.permission), {
          hidden: row.hidden,
          version: row.version,
        });
      }
      this.logger.log(`overlay de permisos poblado desde el registro: ${rows.length} override(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `registro de overrides inalcanzable/ausente en el arranque: ${message}. ` +
          `Overlay VACÍO (sin overrides = rige la base · fail-safe · ADR-025 §3).`,
      );
    }
  }

  /**
   * Aplica un `permission_override.updated`: upsert del par `(role, permission)`. Ignora eventos FUERA DE ORDEN
   * (version menor a la cacheada · reentrega/rebalanceo). `hidden=false` (des-restaurado) se GUARDA como tal —
   * `isPermissionHidden` devolverá `false` igual que si la fila no existiera, pero conservamos la version para
   * el orden. El caller compone `base ∧ ¬override`; acá solo se mantiene la mitad restada, fresca sin TTL.
   */
  applyOverrideEvent(update: PermissionOverrideUpdate): void {
    const key = overrideKey(update.role, update.permission);
    const current = this.overlay.get(key);
    if (current && update.version < current.version) {
      this.logger.warn(
        `permission_override.updated v${update.version} < cache v${current.version} para '${key}'; ignorado (stale)`,
      );
      return;
    }
    this.overlay.set(key, { hidden: update.hidden, version: update.version });
    this.logger.log(
      `overlay de '${key}' actualizado a v${update.version} (hidden=${update.hidden})`,
    );
  }

  /**
   * Aplica un `policy.updated`: actualiza (upsert) la entrada de esa key. Ignora keys desconocidas y eventos
   * FUERA DE ORDEN (version menor a la cacheada · reentrega/rebalanceo de Kafka) para no pisar un estado nuevo.
   */
  applyEvent(update: PolicyUpdate): void {
    if (!isPolicyKey(update.key)) {
      this.logger.warn(`policy.updated con key desconocida '${update.key}'; ignorado`);
      return;
    }
    const current = this.cache.get(update.key);
    if (current && update.version < current.version) {
      this.logger.warn(
        `policy.updated v${update.version} < cache v${current.version} para '${update.key}'; ignorado (stale)`,
      );
      return;
    }
    this.cache.set(update.key, {
      enabled: update.enabled,
      params: update.params,
      version: update.version,
    });
    this.logger.log(
      `cache de política '${update.key}' actualizada a v${update.version} (enabled=${update.enabled})`,
    );
  }

  // ── PolicyReader (async): cache → DEFAULT del catálogo → fallback. NUNCA fail-open. ──

  async getEnabled(key: PolicyKey): Promise<boolean> {
    const cached = this.cache.get(key);
    return cached ? cached.enabled : getPolicyDef(key).defaultEnabled;
  }

  async number(key: PolicyKey, param: string, fallback: number): Promise<number> {
    return this.numberSync(key, param, fallback);
  }

  async bool(key: PolicyKey, param: string, fallback: boolean): Promise<boolean> {
    const value = this.readParam(key, param);
    return typeof value === 'boolean' ? value : fallback;
  }

  async list(key: PolicyKey, param: string, fallback: string[]): Promise<string[]> {
    const value = this.readParam(key, param);
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value as string[];
    }
    return fallback;
  }

  async params(key: PolicyKey): Promise<PolicyParams> {
    const cached = this.cache.get(key);
    return { ...(cached ? cached.params : getPolicyDef(key).defaults) };
  }

  /** OVERLAY async (ADR-025): del cache; ausencia = `false` (no restado = rige la base). Nunca fail-open. */
  async isPermissionHidden(role: string, permission: string): Promise<boolean> {
    return this.isPermissionHiddenSync(role, permission);
  }

  // ── PolicyReaderPort (sync · guards): misma semántica cache → DEFAULT → fallback, sin await. ──

  numberSync(key: string, param: string, fallback: number): number {
    if (!isPolicyKey(key)) return fallback; // key ajena al catálogo → fallback (nunca fail-open)
    const value = this.readParam(key, param);
    return typeof value === 'number' ? value : fallback;
  }

  /** OVERLAY sync (ADR-025 · guards): el par restado devuelve su `hidden`; sin fila → `false` (rige la base). */
  isPermissionHiddenSync(role: string, permission: string): boolean {
    const cached = this.overlay.get(overrideKey(role, permission));
    return cached ? cached.hidden : false;
  }

  /**
   * Valor crudo de un param: del cache si la key está cacheada Y define el param; si no (key ausente o param
   * ausente), el DEFAULT del catálogo. El narrowing por tipo (number/bool/list) lo hace cada lector.
   */
  private readParam(key: PolicyKey, param: string): unknown {
    const cached = this.cache.get(key);
    if (cached && param in cached.params) return cached.params[param];
    return getPolicyDef(key).defaults[param];
  }
}
