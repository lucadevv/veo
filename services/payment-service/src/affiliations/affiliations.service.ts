/**
 * AffiliationsService — dominio de afiliación de wallet (Yape On File · ProntoPaga).
 *
 * SEGURIDAD (no negociable):
 *  - `walletUid` (el secreto que habilita el cobro on-file) vive SOLO server-side: lo guarda la tabla
 *    y lo lee `resolveActiveWalletUid` (consumido por PaymentsService al cobrar). NUNCA sale en un DTO.
 *  - Los getters públicos devuelven `{status, phoneMasked}` SIN walletUid ni PII completa.
 *  - Logs estructurados con phone/document SIEMPRE enmascarados (Ley 29733).
 *
 * Flujo RECURRENT (implementado):
 *  createAffiliation → llama subscription API → guarda PROCESS + walletUid (si lo da) → devuelve
 *  {affiliationId, deepLink} (el deepLink SÍ va al cliente para abrir Yape y aprobar).
 *  webhook de afiliación → ACTIVE/EXPIRED (markFromWebhook). revoke → REVOKED local.
 *
 * ON_DEMAND: fuera de alcance L1 (gap documentado).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { InvalidStateError, NotFoundError, uuidv7 } from '@veo/utils';
import { AffiliationsRepository } from './affiliations.repository';
import {
  PAYMENT_GATEWAY,
  supportsYapeSubscription,
  type PaymentGateway,
} from '../ports/gateway/payment-gateway.port';
import { maskDocument, maskPhone } from './masking';
import { ProntoPagaAffiliationStatus } from '../ports/gateway/prontopaga.mapping';
import { AffiliationStatus, type WalletAffiliation } from '../generated/prisma';

export interface CreateAffiliationInput {
  document: string;
  documentType: 'DN' | 'CE' | 'PP';
  clientName: string;
  /** Origen del cliente. MOBILE (default): deepLink abre Yape, sin phone. WEB: requiere phone. */
  origin?: 'WEB' | 'MOBILE';
  /** Teléfono Yape. SOLO requerido/usado en origin=WEB; en MOBILE se omite (lo trae el /show al aceptar). */
  phone?: string;
}

/** Ventana mínima entre re-consultas al proveedor por usuario (throttle del refresh defensivo). */
const REFRESH_THROTTLE_MS = 10_000;
/** Cota del Map de throttle in-memory: al superarla se podan las entradas más viejas que la ventana (ver uso). */
const REFRESH_THROTTLE_MAX_ENTRIES = 10_000;

/** Vista pública SIN walletUid ni PII completa. Es lo ÚNICO que sale al BFF/cliente. */
export interface AffiliationView {
  affiliationId: string;
  status: AffiliationStatus;
  wallet: string;
  phoneMasked: string | null;
}

@Injectable()
export class AffiliationsService {
  private readonly logger = new Logger(AffiliationsService.name);
  private readonly provider = 'PRONTOPAGA';
  private readonly wallet = 'YAPE';
  /** Throttle in-memory del refresh contra el proveedor: userId → epoch ms del último /show. */
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(
    private readonly repo: AffiliationsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Crea (o re-inicia) la afiliación Yape On File del usuario. Idempotente por (userId, provider, wallet):
   * si ya hay una ACTIVE, no re-afilia; si está PROCESS/EXPIRED/REVOKED, la reinicia.
   * Devuelve el deepLink para que el cliente apruebe en su app Yape.
   */
  async createAffiliation(
    userId: string,
    input: CreateAffiliationInput,
  ): Promise<{ affiliationId: string; status: AffiliationStatus; deepLink?: string }> {
    if (!supportsYapeSubscription(this.gateway)) {
      throw new InvalidStateError(
        'El gateway activo no soporta afiliación Yape On File (usá VEO_PAYMENT_MODE=prontopaga)',
      );
    }

    const existing = await this.repo.findByKey({
      userId,
      provider: this.provider,
      wallet: this.wallet,
    });
    if (existing?.status === AffiliationStatus.ACTIVE) {
      // Ya afiliado: no re-afiliamos (no hay deepLink que abrir).
      this.logger.log(`Afiliación YA ACTIVE user=${userId} aff=${existing.id} (no-op)`);
      return { affiliationId: existing.id, status: existing.status };
    }

    const origin = input.origin ?? 'MOBILE';
    // En WEB el phone es obligatorio (se manda al proveedor); en MOBILE se omite (deepLink abre Yape).
    if (origin === 'WEB' && !input.phone) {
      throw new InvalidStateError('origin=WEB requiere phone (en MOBILE se omite)');
    }

    // Llamada al proveedor (puede tardar; el deepLink es efímero, NO se persiste).
    const sub = await this.gateway.createYapeSubscription({
      origin,
      document: input.document,
      clientDocumentType: input.documentType,
      // MOBILE omite phone; WEB lo envía. El gateway igual filtra por origin.
      phoneNumber: origin === 'WEB' ? input.phone : undefined,
      clientName: input.clientName,
      type: 'RECURRENT',
    });

    // En MOBILE el phone aún no se conoce (lo trae el /show al aceptar) → phoneMasked null hasta ACTIVE.
    const phoneMasked = input.phone ? maskPhone(input.phone) : null;
    const documentMasked = maskDocument(input.document);
    const id = existing?.id ?? uuidv7();

    const saved = await this.repo.upsertByKey(
      { userId, provider: this.provider, wallet: this.wallet },
      { status: 'PROCESS', walletUid: sub.uid ?? null, phoneMasked, documentMasked },
      {
        id,
        userId,
        provider: this.provider,
        wallet: this.wallet,
        type: 'RECURRENT',
        status: 'PROCESS',
        walletUid: sub.uid ?? null,
        phoneMasked,
        documentMasked,
      },
    );

    // AUDIT sin PII completa (phone/document enmascarados; walletUid jamás logueado).
    this.logger.log(
      `Afiliación creada user=${userId} aff=${saved.id} origin=${origin} estado=PROCESS`,
    );
    if (!sub.deepLink) {
      this.logger.warn(
        `Afiliación ${saved.id} sin deepLink del proveedor (revisar respuesta de ProntoPaga)`,
      );
    }
    return { affiliationId: saved.id, status: saved.status, deepLink: sub.deepLink };
  }

  /**
   * Estado público de la afiliación del usuario. SIN walletUid.
   * Si el estado local es PROCESS, intenta un refresh DEFENSIVO contra el proveedor (/show) para resolver
   * ACTIVE sin depender del webhook (cuyo payload no está documentado), con throttle por usuario.
   */
  async getAffiliationStatus(userId: string): Promise<AffiliationView | null> {
    let aff = await this.repo.findByKey({
      userId,
      provider: this.provider,
      wallet: this.wallet,
    });
    if (!aff) return null;
    if (aff.status === AffiliationStatus.PROCESS) {
      const refreshed = await this.refreshFromProvider(userId, aff);
      if (refreshed) aff = refreshed;
    }
    return this.toView(aff);
  }

  /**
   * Baja de la afiliación. CANCEL REAL: pide la baja al proveedor (POST .../cancel/{walletUID}) y marca
   * REVOKED local. Si el proveedor falla, igual revocamos local + log (el usuario recibe el push de Yape
   * al desafiliar; no bloqueamos su baja por un fallo del riel). Idempotente.
   */
  async revokeAffiliation(userId: string): Promise<AffiliationView> {
    const aff = await this.repo.findByKey({
      userId,
      provider: this.provider,
      wallet: this.wallet,
    });
    if (!aff) throw new NotFoundError('No hay afiliación para revocar');
    if (aff.status === AffiliationStatus.REVOKED) return this.toView(aff);

    // Cancel en el proveedor (best-effort): si tenemos walletUid y el gateway lo soporta.
    if (aff.walletUid && supportsYapeSubscription(this.gateway)) {
      try {
        await this.gateway.cancelYapeSubscription(aff.walletUid);
        this.logger.log(`Afiliación cancelada en el proveedor user=${userId} aff=${aff.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'error';
        this.logger.warn(
          `Cancel en el proveedor falló (revoco local igual) user=${userId} aff=${aff.id}: ${msg}`,
        );
      }
    }

    const updated = await this.repo.updateById(aff.id, { status: 'REVOKED', walletUid: null });
    this.logger.log(`Afiliación revocada user=${userId} aff=${aff.id}`);
    return this.toView(updated);
  }

  /**
   * Refresh DEFENSIVO de una afiliación PROCESS contra el proveedor (/show). Resuelve ACTIVE sin depender
   * del webhook. Throttle simple: máx 1 consulta al proveedor cada REFRESH_THROTTLE_MS por usuario.
   * Al resolver ACCEPTED → ACTIVE: guarda phoneMasked (el /show trae el phoneNumber) y emite
   * payment.affiliation_activated (idempotente con el camino del webhook). Devuelve la fila actualizada o null.
   */
  private async refreshFromProvider(
    userId: string,
    aff: WalletAffiliation,
  ): Promise<WalletAffiliation | null> {
    if (!aff.walletUid || !supportsYapeSubscription(this.gateway)) return null;

    const now = Date.now();
    const last = this.lastRefreshAt.get(userId) ?? 0;
    if (now - last < REFRESH_THROTTLE_MS) return null; // throttle: no martillamos al proveedor
    this.lastRefreshAt.set(userId, now);
    // Poda del Map (evita el memory-leak por-pod): las entradas más viejas que la ventana ya no sirven (el
    // throttle solo mira los últimos REFRESH_THROTTLE_MS). Se barre SOLO al superar el cap (amortizado O(n)
    // ocasional, no en cada refresh) → el Map queda acotado a los usuarios activos en la ventana.
    if (this.lastRefreshAt.size > REFRESH_THROTTLE_MAX_ENTRIES) {
      for (const [uid, ts] of this.lastRefreshAt) {
        if (now - ts >= REFRESH_THROTTLE_MS) this.lastRefreshAt.delete(uid);
      }
    }

    let detail: { status?: string; phoneNumber?: string | null };
    try {
      detail = await this.gateway.showYapeSubscription(aff.walletUid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      this.logger.warn(`Refresh /show falló user=${userId} aff=${aff.id}: ${msg}`);
      return null;
    }

    // `detail.status` es el estado CRUDO del proveedor (ProntoPaga /show) — comparamos contra su contrato
    // tipado, no contra literales. (Smell latente: idealmente el gateway normaliza esto a dominio antes de
    // devolverlo; mientras tanto, el const explícito deja la dependencia del proveedor a la vista.)
    const status = (detail.status ?? '').toUpperCase();
    if (
      status === ProntoPagaAffiliationStatus.ACCEPTED ||
      status === ProntoPagaAffiliationStatus.ACTIVE
    ) {
      const phoneMasked = detail.phoneNumber ? maskPhone(detail.phoneNumber) : aff.phoneMasked;
      return this.activateAndEmit(aff, { phoneMasked, source: 'refresh' });
    }
    if (status === ProntoPagaAffiliationStatus.EXPIRED) {
      const updated = await this.repo.updateById(aff.id, { status: AffiliationStatus.EXPIRED });
      this.logger.log(`Afiliación ${aff.id} → EXPIRED (por refresh /show)`);
      return updated;
    }
    return null; // sigue PROCESS
  }

  /**
   * Transición idempotente PROCESS→ACTIVE + emisión de payment.affiliation_activated (outbox, misma tx).
   * Compartida por el camino del webhook y el del refresh: re-aplicar sobre una afiliación ya ACTIVE/REVOKED
   * es no-op (no re-emite). Devuelve la fila resultante.
   */
  private async activateAndEmit(
    aff: WalletAffiliation,
    opts: { phoneMasked: string | null; walletUid?: string | null; source: 'webhook' | 'refresh' },
  ): Promise<WalletAffiliation> {
    if (aff.status === AffiliationStatus.ACTIVE || aff.status === AffiliationStatus.REVOKED)
      return aff; // idempotente / no pisar
    return this.repo.runInTransaction(async (tx) => {
      // CAS por status (no `update where {id}`): el guard de arriba es un READ-then-check (TOCTOU) — dos caminos
      // concurrentes (webhook + refresh /show) que leyeron PROCESS ambos lo pasan y emitirían
      // payment.affiliation_activated DOS veces. Con el CAS `where {id, status: <lo leído>}` solo UNO gana
      // (count=1) y emite; el perdedor ve count=0 → no-op (devuelve la fila ya ACTIVE sin re-emitir).
      const { count } = await this.repo.casActivateInTx(
        tx,
        aff.id,
        aff.status,
        opts.phoneMasked,
        opts.walletUid ?? aff.walletUid,
      );
      const updated = await this.repo.findByIdInTx(tx, aff.id);
      if (count === 0) return updated; // otra corrida concurrente ya activó: NO re-emitir
      const envelope = createEnvelope({
        eventType: 'payment.affiliation_activated',
        producer: 'payment-service',
        payload: {
          affiliationId: updated.id,
          userId: updated.userId,
          wallet: 'YAPE',
          phoneMasked: updated.phoneMasked ?? undefined,
          at: new Date().toISOString(),
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, updated.id);
      this.logger.log(`Afiliación ${updated.id} → ACTIVE (por ${opts.source})`);
      return updated;
    });
  }

  /**
   * Aplica el resultado de un webhook de afiliación: PROCESS→ACTIVE (CONFIRMED) o →EXPIRED.
   * Idempotente por estado: re-aplicar el mismo webhook es no-op. Emite evento por outbox.
   * `externalUid` correlaciona por walletUid si el webhook no trae nuestro id.
   */
  async markFromWebhook(input: {
    affiliationId?: string;
    walletUid?: string;
    status: 'CONFIRMED' | 'EXPIRED' | 'DECLINED' | 'PENDING';
  }): Promise<void> {
    const aff = await this.findForWebhook(input.affiliationId, input.walletUid);
    if (!aff) {
      this.logger.warn(
        `Webhook de afiliación sin match (aff=${input.affiliationId ?? '-'} walletUid=${input.walletUid ? '***' : '-'})`,
      );
      return;
    }
    if (input.status === 'PENDING') return; // sin transición

    // CONFIRMED → ACTIVE por el helper compartido (idempotente entre webhook y refresh).
    if (input.status === 'CONFIRMED') {
      await this.activateAndEmit(aff, {
        phoneMasked: aff.phoneMasked,
        // Si el webhook trae el walletUid y aún no lo teníamos, lo guardamos (server-side).
        walletUid: input.walletUid ?? aff.walletUid,
        source: 'webhook',
      });
      return;
    }

    // EXPIRED/DECLINED → EXPIRED (no pisar ACTIVE/REVOKED; idempotente por estado).
    if (
      aff.status === AffiliationStatus.EXPIRED ||
      aff.status === AffiliationStatus.ACTIVE ||
      aff.status === AffiliationStatus.REVOKED
    )
      return;
    const emitted = await this.repo.runInTransaction(async (tx) => {
      // CAS por status (mismo motivo que activateAndEmit): dos webhooks EXPIRED/DECLINED concurrentes que leyeron
      // el mismo estado fuente NO deben emitir payment.affiliation_expired dos veces. Solo el que matchea emite.
      const { count } = await this.repo.casExpireInTx(
        tx,
        aff.id,
        aff.status,
        input.walletUid ?? aff.walletUid,
      );
      if (count === 0) return false; // otra corrida ya transicionó: NO re-emitir
      const updated = await this.repo.findByIdInTx(tx, aff.id);
      const envelope = createEnvelope({
        eventType: 'payment.affiliation_expired',
        producer: 'payment-service',
        payload: {
          affiliationId: updated.id,
          userId: updated.userId,
          wallet: 'YAPE',
          at: new Date().toISOString(),
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, updated.id);
      return true;
    });
    if (emitted) this.logger.log(`Afiliación ${aff.id} → EXPIRED (por webhook)`);
  }

  /**
   * Derecho al olvido (Ley 29733, BR-S06) — consumido desde `user.deleted` (S7c). Da de baja la
   * afiliación en el proveedor (best-effort, MISMO trato que revokeAffiliation: la purga local no se
   * bloquea por un fallo del riel) y BORRA la PII local: `walletUid` (el token que habilita cobros
   * on-file), `phoneMasked` y `documentMasked` → null; status → REVOKED. La fila se conserva
   * (integridad referencial), sin PII. Idempotente: re-aplicar deja el mismo estado.
   */
  async eraseUser(userId: string): Promise<{ erased: boolean }> {
    const aff = await this.repo.findByKey({
      userId,
      provider: this.provider,
      wallet: this.wallet,
    });
    if (!aff) return { erased: false };

    if (aff.walletUid && supportsYapeSubscription(this.gateway)) {
      try {
        await this.gateway.cancelYapeSubscription(aff.walletUid);
        this.logger.log(
          `Derecho al olvido: afiliación cancelada en el proveedor user=${userId} aff=${aff.id}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'error';
        this.logger.warn(
          `Cancel en el proveedor falló (purgo PII local igual) user=${userId} aff=${aff.id}: ${msg}`,
        );
      }
    }

    await this.repo.updateById(aff.id, {
      status: 'REVOKED',
      walletUid: null,
      phoneMasked: null,
      documentMasked: null,
    });
    this.logger.log(`Derecho al olvido: PII de la afiliación ${aff.id} purgada (user=${userId})`);
    return { erased: true };
  }

  /**
   * Resuelve el walletUid ACTIVE de un usuario para cobrar on-file (SOLO uso interno del dominio).
   * Devuelve null si no hay afiliación activa. NUNCA exponer este valor fuera del servidor.
   */
  async resolveActiveWalletUid(userId: string): Promise<string | null> {
    const aff = await this.repo.findByKey({
      userId,
      provider: this.provider,
      wallet: this.wallet,
    });
    if (aff?.status !== 'ACTIVE' || !aff.walletUid) return null;
    return aff.walletUid;
  }

  private async findForWebhook(
    affiliationId?: string,
    walletUid?: string,
  ): Promise<WalletAffiliation | null> {
    if (affiliationId) {
      const byId = await this.repo.findById(affiliationId);
      if (byId) return byId;
    }
    if (walletUid) {
      return this.repo.findByWalletUid(walletUid);
    }
    return null;
  }

  private toView(aff: WalletAffiliation): AffiliationView {
    // EXCLUYE walletUid y documentMasked del payload público por diseño.
    return {
      affiliationId: aff.id,
      status: aff.status,
      wallet: aff.wallet,
      phoneMasked: aff.phoneMasked,
    };
  }
}
