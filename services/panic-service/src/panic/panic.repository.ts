/**
 * Puerto + adaptador Prisma del panic-service (FOUNDATION §10: el repositorio es el ÚNICO dueño de
 * Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde del dispatch-radius-config
 * (token DI + interfaz + adaptador) y del NotificationRepository (mismo service family, outbox).
 *
 * Las lecturas/escrituras directas son métodos del puerto. Las 3 transacciones del dominio de pánico
 * (trigger/acknowledge/resolve) se abren con `runInTx`: el CUERPO transaccional —CAS con status-guard +
 * `enqueueOutbox` en la MISMA tx (FOUNDATION §6)— SIGUE viviendo en el service, que recibe el cliente
 * de transacción. El tx se tipa como `Prisma.TransactionClient` (el real): los cuerpos combinan varias
 * operaciones sobre `panicEvent` con `enqueueOutbox`, que exige el delegate `outboxEvent` real; un puerto
 * estrecho re-implementaría a mano los tipos de Prisma en un flujo de SEGURIDAD — riesgo que no se paga.
 */
import { Injectable } from '@nestjs/common';
import { PanicStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type PanicEvent } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const PANIC_REPO = Symbol('PANIC_REPO');

/** Puerto: el PanicService depende de esto, NO de Prisma. */
export interface PanicRepository {
  /**
   * Abre una transacción de ESCRITURA y entrega el cliente tx al callback. El cuerpo (CAS + outbox en
   * la MISMA tx) vive en el service; aquí solo se abre/cierra la tx sobre el primario.
   */
  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  /**
   * Lectura post-write crítica por dedupKey tras el P2002 (BR-S04): usa el PRIMARIO (write) para no leer
   * de una réplica con lag y perder la fila recién creada por el submit ganador.
   */
  findByDedupKeyOnPrimary(dedupKey: string): Promise<PanicEvent | null>;
  /** Lee un evento por id desde la réplica (read). `null` si no existe. */
  findById(panicId: string): Promise<PanicEvent | null>;
  /** Sobrescribe las keys S3 de evidencia (write). El merge sin duplicados lo calcula el service. */
  updateEvidenceKeys(panicId: string, keys: string[]): Promise<PanicEvent>;
  /** Lista de eventos (read), opcionalmente filtrada por estado; más recientes primero, tope 200. */
  list(status?: PanicStatus): Promise<PanicEvent[]>;
  /** Cantidad de pánicos ABIERTOS (TRIGGERED + ACKNOWLEDGED) para el KPI del dashboard admin (read). */
  countOpen(): Promise<number>;
}

@Injectable()
export class PrismaPanicRepository implements PanicRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  findByDedupKeyOnPrimary(dedupKey: string): Promise<PanicEvent | null> {
    return this.prisma.write.panicEvent.findUnique({ where: { dedupKey } });
  }

  findById(panicId: string): Promise<PanicEvent | null> {
    return this.prisma.read.panicEvent.findUnique({ where: { id: panicId } });
  }

  updateEvidenceKeys(panicId: string, keys: string[]): Promise<PanicEvent> {
    return this.prisma.write.panicEvent.update({
      where: { id: panicId },
      data: { evidenceS3Keys: keys },
    });
  }

  list(status?: PanicStatus): Promise<PanicEvent[]> {
    return this.prisma.read.panicEvent.findMany({
      where: status ? { status } : undefined,
      orderBy: { triggeredAt: 'desc' },
      take: 200,
    });
  }

  countOpen(): Promise<number> {
    return this.prisma.read.panicEvent.count({
      where: { status: { in: [PanicStatus.TRIGGERED, PanicStatus.ACKNOWLEDGED] } },
    });
  }
}
