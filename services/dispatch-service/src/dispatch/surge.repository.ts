/**
 * Puerto + adaptador Prisma de SurgeService (FOUNDATION §10). Dueño del acceso a `SurgeZone` (las zonas de
 * pricing dinámico). El resto de las señales del surge (demanda en Redis, oferta en el hot-index) NO son
 * Prisma y siguen en el service. El casteo a `ZoneRow` (proyección de dominio del service) se queda en el
 * service — el repo devuelve el tipo generado tal cual.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { SurgeZone } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const SURGE_REPO = Symbol('SURGE_REPO');

/** Puerto: el SurgeService depende de esto, NO de Prisma. */
export interface SurgeRepository {
  /** Todas las zonas de surge ACTIVAS (read); el service resuelve cuál contiene el punto. */
  findActiveZones(): Promise<SurgeZone[]>;
}

@Injectable()
export class PrismaSurgeRepository implements SurgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveZones(): Promise<SurgeZone[]> {
    return this.prisma.read.surgeZone.findMany({ where: { active: true } });
  }
}
