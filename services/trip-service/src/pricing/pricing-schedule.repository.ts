/**
 * Puerto + adaptador Prisma del SINGLETON pricing_mode_schedule (ADR 011 · clean arch).
 *
 * El ModeResolver es PURO (domain/pricing-mode.ts) y NO conoce la DB. Este puerto lo desacopla del
 * almacenamiento: el servicio depende de la INTERFAZ (PRICING_SCHEDULE_REPO), no de Prisma. Así el
 * resolver + su servicio se testean con un repo en memoria, y la persistencia real vive en el adaptador.
 */
import { Injectable } from '@nestjs/common';
import type { PricingModeSchedule } from '../trips/domain/pricing-mode';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const PRICING_SCHEDULE_REPO = Symbol('PRICING_SCHEDULE_REPO');

/** Snapshot persistido + metadatos de versión (lo que el GET expone y el PUT bumpea). */
export interface PersistedSchedule extends PricingModeSchedule {
  version: number;
  updatedAt: string;
}

/** Cliente de transacción mínimo aceptado por `replace` (para encolar el outbox en la MISMA tx). */
export interface ScheduleTx {
  pricingModeSchedule: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ version: number; updatedAt: Date }>;
  };
  outboxEvent: {
    create(args: { data: { aggregateId: string; eventType: string; envelope: unknown } }): Promise<unknown>;
  };
}

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface PricingScheduleRepository {
  /** Lee el singleton; `null` si la fila aún no existe (el servicio degrada a DEFAULT_SCHEDULE). */
  find(): Promise<PersistedSchedule | null>;
  /** Abre una transacción de escritura y entrega el cliente tx al callback (replace wholesale + outbox). */
  runInTx<T>(fn: (tx: ScheduleTx) => Promise<T>): Promise<T>;
}

/** Id fijo del singleton (Tier 1 GLOBAL). */
export const SINGLETON_ID = 'GLOBAL';

@Injectable()
export class PrismaPricingScheduleRepository implements PricingScheduleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(): Promise<PersistedSchedule | null> {
    const row = await this.prisma.read.pricingModeSchedule.findUnique({ where: { id: SINGLETON_ID } });
    if (!row) return null;
    return {
      defaultMode: row.defaultMode,
      rules: parseRules(row.rules),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async runInTx<T>(fn: (tx: ScheduleTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(async (tx) => fn(tx as unknown as ScheduleTx));
  }
}

/**
 * Parsea de forma DEFENSIVA el `rules` JSON de la fila (Prisma.JsonValue) a PricingModeRule[]. Sin `any`:
 * estrechamos cada elemento. Una fila corrupta/forma inesperada degrada a [] (honesto, no crash) — el
 * PUT valida el shape antes de escribir, así que esto es cinturón-y-tirantes.
 */
function parseRules(raw: Prisma.JsonValue): PricingModeSchedule['rules'] {
  if (!Array.isArray(raw)) return [];
  const out: PricingModeSchedule['rules'] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const { dayMask, startMinute, endMinute, mode } = rec;
    if (
      typeof dayMask === 'number' &&
      typeof startMinute === 'number' &&
      typeof endMinute === 'number' &&
      (mode === 'PUJA' || mode === 'FIXED')
    ) {
      out.push({ dayMask, startMinute, endMinute, mode });
    }
  }
  return out;
}
