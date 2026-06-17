/**
 * TripSnapshotService — mantiene el read-model del viaje a partir de eventos consumidos
 * (trip.started, panic.triggered, panic.resolved). Es la ÚNICA fuente que alimenta la página pública:
 * share-service no consulta tablas de otros servicios.
 */
import { Injectable } from '@nestjs/common';
import { PanicStatus } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';

/** Estado con el que el read-model ENMASCARA un viaje en pánico (la vista familiar nunca lo revela). */
const PANIC_SNAPSHOT_STATUS = 'PANIC';

@Injectable()
export class TripSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * trip.started → el viaje está en curso. Proyecta también el passengerId (trip-service lo enriquece
   * en el evento justamente para el dominó de compartir/familia): es lo que permite a ShareService
   * validar pertenencia FALLA-CERRADO al crear/revocar enlaces.
   */
  async onTripStarted(
    tripId: string,
    driverId: string,
    startedAt: Date,
    passengerId?: string,
  ): Promise<void> {
    await this.prisma.write.tripSnapshot.upsert({
      where: { tripId },
      create: {
        tripId,
        status: 'IN_PROGRESS',
        driverId,
        startedAt,
        passengerId: passengerId ?? null,
      },
      // Si un evento legacy viene sin passengerId, NO pisamos con null uno ya proyectado (p.ej. por panic.triggered).
      update: {
        status: 'IN_PROGRESS',
        driverId,
        startedAt,
        ...(passengerId ? { passengerId } : {}),
      },
    });
  }

  /**
   * panic.triggered → guarda pasajero, marca pánico (status="PANIC") y registra la ubicación aproximada.
   *
   * SEGURIDAD-CRÍTICA: ANTES de pisar `status` con PANIC, preserva el estado previo (p.ej. IN_PROGRESS)
   * en `prePanicStatus`, para poder DESENMASCARAR la vista familiar más tarde SOLO si el operador cierra
   * como FALSE_ALARM (`onPanicResolved`). Se hace dentro de UNA transacción (lectura + upsert) para que
   * el estado previo capturado sea consistente. IDEMPOTENTE: si el snapshot YA está en PANIC (redelivery
   * de panic.triggered), NO sobrescribimos `prePanicStatus` con "PANIC" (se perdería el estado real).
   */
  async onPanic(
    tripId: string,
    passengerId: string,
    geo: { lat: number; lon: number },
    at: Date,
  ): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const current = await tx.tripSnapshot.findUnique({ where: { tripId } });
      // Solo capturamos el prePanicStatus si NO estábamos ya en PANIC: una redelivery no debe pisar
      // el estado real guardado (que sería "PANIC", inservible para desenmascarar). Si no hay fila previa
      // (panic antes que trip.started), no hay nada que preservar → prePanicStatus queda null.
      const prePanicStatus =
        current && current.status !== PANIC_SNAPSHOT_STATUS
          ? current.status
          : (current?.prePanicStatus ?? null);
      await tx.tripSnapshot.upsert({
        where: { tripId },
        create: {
          tripId,
          status: PANIC_SNAPSHOT_STATUS,
          prePanicStatus,
          passengerId,
          lastLat: geo.lat,
          lastLon: geo.lon,
          lastLocationAt: at,
        },
        update: {
          status: PANIC_SNAPSHOT_STATUS,
          prePanicStatus,
          passengerId,
          lastLat: geo.lat,
          lastLon: geo.lon,
          lastLocationAt: at,
        },
      });
    });
  }

  /**
   * panic.resolved → DESENMASCARADO CONDICIONAL de la vista familiar (decisión del dueño, conservadora).
   *
   * PROPIEDAD DE SEGURIDAD NO NEGOCIABLE:
   *  - `FALSE_ALARM` (falsa alarma): restaura `status` desde `prePanicStatus` (el viaje vuelve a verse en
   *    vivo para la familia) y limpia `prePanicStatus`. La máscara se LEVANTA.
   *  - `RESOLVED` (emergencia REAL atendida): NO restaura — la máscara se MANTIENE. El enlace pudo ser
   *    capturado por el agresor; restaurar la ubicación en vivo lo expondría. NO-OP sobre el snapshot.
   *
   * Se ramifica por el enum TIPADO `PanicStatus` (no string suelto). Idempotente: si el snapshot no está
   * en PANIC (ya desenmascarado, o nunca enmascarado) es no-op. Si no hay `prePanicStatus` (pánico
   * disparado antes de trip.started), restauramos a UNKNOWN honesto en vez de dejarlo colgado en PANIC.
   *
   * NOTA caso borde: si el viaje terminó DE VERDAD durante el pánico, `prePanicStatus` sería IN_PROGRESS
   * y quedaría colgado al desenmascarar. NO es problema: el read-model de la familia (public-bff) consulta
   * trip-service en CADA carga, así que el estado terminal real prevalece en la vista pública. No
   * consumimos trip.completed acá a propósito (scope: ese dominó lo cubre el auto-revoke del kill-switch).
   */
  async onPanicResolved(tripId: string, status: PanicStatus): Promise<void> {
    if (status !== PanicStatus.FALSE_ALARM) {
      // RESOLVED (emergencia real): la máscara se MANTIENE. No tocamos el snapshot.
      return;
    }
    await this.prisma.write.$transaction(async (tx) => {
      const current = await tx.tripSnapshot.findUnique({ where: { tripId } });
      // No enmascarado (sin fila, o ya restaurado): nada que desenmascarar.
      if (!current || current.status !== PANIC_SNAPSHOT_STATUS) return;
      await tx.tripSnapshot.update({
        where: { tripId },
        data: {
          // Restaura el estado previo; si no se capturó (pánico antes de trip.started) cae a UNKNOWN honesto.
          status: current.prePanicStatus ?? 'UNKNOWN',
          prePanicStatus: null,
        },
      });
    });
  }
}
