/**
 * PaymentPollService — POLL FALLBACK del estado de cobros (modo prontopaga, sin webhook).
 *
 * PROBLEMA: el webhook de ProntoPaga NO llega a `localhost` (y Cloudflare rechaza esas urls como SSRF).
 * En local sin túnel, un cobro PENDING_EXTERNAL nunca se capturaría. SOLUCIÓN (espejo del /show de
 * afiliaciones): un barrido suave consulta el estado real del cobro al proveedor (PULL) y lo aplica por
 * el MISMO camino idempotente que el webhook (`PaymentsService.applyWebhookResult`).
 *
 * SUAVE por diseño (no martillar al proveedor):
 *  - Solo corre en modo prontopaga Y si el gateway soporta consulta de estado (type-guard ISP).
 *  - Pagos PENDING con `externalUid` (oldest-first, capado a N por tick). Los que el proveedor nunca registró
 *    y superan la ventana de gracia se EXPIRAN (checkout abandonado); el resto se reconcilia por su estado real.
 *  - Tope de N por tick. Lock Redis por tick (no se solapa entre instancias / ticks lentos).
 *  - Intervalo configurable (~25s). Activable por env (en prod con webhook público puede ser red de seguridad).
 *
 * Una captura por poll y una redelivery posterior del webhook NO duplican nada: applyWebhookResult es
 * idempotente por status-guard. Es exactamente el mismo desenlace que habría traído el webhook.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { withDistributedLock } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import {
  PAYMENT_GATEWAY,
  supportsStatusQuery,
  type PaymentGateway,
} from '../ports/gateway/payment-gateway.port';
import { PaymentsService } from '../payments/payments.service';
import type { Env } from '../config/env.schema';

const POLL_LOCK_KEY = 'veo:payment:lock:prontopaga-poll';
/** TTL del lock por tick: corto (un barrido acotado por batch no debería pasarse de esto). */
const POLL_LOCK_TTL_SECONDS = 30;
/** Nombre del intervalo en el SchedulerRegistry (registro dinámico desde la config validada). */
const POLL_INTERVAL_NAME = 'prontopaga-payment-poll';

@Injectable()
export class PaymentPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentPollService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxAgeMin: number;
  private readonly batch: number;
  private readonly paymentMode: 'live' | 'sandbox' | 'prontopaga';
  /** Evita reentrada dentro de la MISMA instancia si un tick tarda más que el intervalo. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    private readonly scheduler: SchedulerRegistry,
    config: ConfigService<Env, true>,
  ) {
    this.paymentMode = config.getOrThrow<'live' | 'sandbox' | 'prontopaga'>('VEO_PAYMENT_MODE');
    this.enabled = config.getOrThrow<boolean>('PRONTOPAGA_POLL_ENABLED');
    this.intervalMs = config.getOrThrow<number>('PRONTOPAGA_POLL_INTERVAL_MS');
    this.maxAgeMin = config.getOrThrow<number>('PRONTOPAGA_POLL_MAX_AGE_MIN');
    this.batch = config.getOrThrow<number>('PRONTOPAGA_POLL_BATCH');
  }

  /**
   * Registra el intervalo SOLO si el poll está activo (modo prontopaga + gateway con consulta + env).
   * Registro dinámico (no decorador) para leer el intervalo de la config VALIDADA y no encender el
   * barrido en sandbox/live (donde no hay nada que consultar).
   */
  onModuleInit(): void {
    if (!this.active) {
      this.logger.log(
        `Poll fallback ProntoPaga INACTIVO (mode=${this.paymentMode}, enabled=${this.enabled})`,
      );
      return;
    }
    const handle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.scheduler.addInterval(POLL_INTERVAL_NAME, handle);
    this.logger.log(
      `Poll fallback ProntoPaga ACTIVO: cada ${this.intervalMs}ms, ventana ${this.maxAgeMin}min, batch ${this.batch}`,
    );
  }

  onModuleDestroy(): void {
    this.running = false;
    if (this.scheduler.doesExist('interval', POLL_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(POLL_INTERVAL_NAME);
    }
  }

  /** ¿El poll debe correr? Solo modo prontopaga + gateway con consulta de estado + activado por env. */
  private get active(): boolean {
    return this.enabled && this.paymentMode === 'prontopaga' && supportsStatusQuery(this.gateway);
  }

  async tick(): Promise<void> {
    if (!this.active || this.running) return;

    // Lock por tick (no se solapa entre instancias). NX+EX: si otro lo tomó, salimos en silencio.
    // Se libera al terminar (releaseOnSettle): el próximo tick no debe encontrar un lock residual.
    await withDistributedLock(
      this.redis,
      POLL_LOCK_KEY,
      POLL_LOCK_TTL_SECONDS,
      async () => {
        this.running = true;
        try {
          await this.pollOnce();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'error';
          this.logger.warn(
            `Poll fallback ProntoPaga: tick con error (continúa el próximo): ${msg}`,
          );
        } finally {
          this.running = false;
        }
      },
      { releaseOnSettle: true },
    );
  }

  /**
   * Un barrido: toma hasta `batch` pagos PENDING con externalUid (oldest-first), consulta el estado al proveedor
   * y aplica el desenlace por el camino idempotente del webhook. Devuelve el conteo (para tests/observabilidad).
   * Ya NO filtra por ventana (`createdAt>=since` dejaba HUÉRFANO todo PENDING más viejo — #24, gemelo del
   * payout-poll #7): escanea TODO PENDING (capado a batch, los viejos primero) y usa `since` solo como umbral de
   * GRACIA para expirar los que el proveedor nunca registró (abajo).
   */
  async pollOnce(): Promise<{ scanned: number; applied: number }> {
    if (!supportsStatusQuery(this.gateway)) return { scanned: 0, applied: 0 };

    const since = new Date(Date.now() - this.maxAgeMin * 60_000);
    const pending = await this.prisma.read.payment.findMany({
      where: {
        status: 'PENDING',
        externalUid: { not: null },
      },
      select: { id: true, externalUid: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: this.batch,
    });
    if (pending.length === 0) return { scanned: 0, applied: 0 };

    let applied = 0;
    for (const p of pending) {
      if (!this.running) break; // corte limpio si el módulo se destruye a mitad del barrido
      const uid = p.externalUid;
      if (!uid) continue;
      try {
        const detail = await this.gateway.getPaymentStatus(uid);
        if (!detail.found) {
          // El proveedor no reconoce el uid. RECIENTE → puede ser lag de registro, reintentar. VIEJO
          // (createdAt < since, > maxAgeMin) → el cobro NUNCA se registró (checkout abandonado / submission
          // fallida tras asignar el uid): el dinero no se movió → EXPIRAR por el MISMO camino idempotente del
          // webhook EXPIRED (FARE→DEBT reintentable, TIP→FAILED). Sin esto quedaba PENDING para siempre (#24).
          if (p.createdAt < since) {
            const res = await this.payments.applyWebhookResult({
              paymentId: p.id,
              externalUid: uid,
              status: 'EXPIRED',
            });
            if (res.applied) {
              applied += 1;
              this.logger.warn(
                `Poll: pago=${p.id} PENDING sin registro en el proveedor tras ${this.maxAgeMin}min (checkout abandonado) → EXPIRADO (${res.status})`,
              );
            }
          } else {
            this.logger.debug(
              `Poll: proveedor no reconoce uid=${uid} (pago=${p.id}); se reintenta luego`,
            );
          }
          continue;
        }
        if (detail.status === 'PENDING') continue; // sigue en curso: nada que aplicar

        const res = await this.payments.applyWebhookResult({
          paymentId: p.id,
          externalUid: uid,
          status: detail.status,
        });
        if (res.applied) {
          applied += 1;
          this.logger.log(
            `Poll fallback: pago=${p.id} resuelto por consulta (proveedor=${detail.rawStatus ?? '-'} → ${res.status})`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'error';
        this.logger.warn(`Poll: consulta falló pago=${p.id}: ${msg}`);
      }
    }
    if (applied > 0)
      this.logger.log(`Poll fallback ProntoPaga: ${applied}/${pending.length} pagos resueltos`);
    return { scanned: pending.length, applied };
  }
}
