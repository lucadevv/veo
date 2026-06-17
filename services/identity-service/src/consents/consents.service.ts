/**
 * ConsentsService — registro server-side de consentimientos Ley 29733 (APPEND-ONLY).
 * Cada aceptación del pasajero es un row inmutable nuevo (`Consent`). NUNCA se actualiza ni se borra:
 * el estado vigente de un usuario es el consentimiento más reciente. Esto preserva la evidencia
 * histórica exigida por la Ley 29733 (qué aceptó, cuándo, desde qué IP y con qué versión de política).
 */
import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '@veo/database';
import { ValidationError, isUuidV7 } from '@veo/utils';
import type { Consent } from '../generated/prisma';
import { PrismaService } from '../infra/prisma.service';

/** Datos de un evento de aceptación de consentimiento (provienen del pasajero vía el BFF). */
export interface RecordConsentInput {
  dataProcessing: boolean;
  inCabinCamera: boolean;
  location: boolean;
  /** Comunicaciones de marketing/promociones (opt-in). */
  marketing: boolean;
  policyVersion: string;
  /** IP de origen capturada por el BFF; null si no se pudo determinar. */
  ip: string | null;
  /**
   * Clave de idempotencia (UUIDv7) emitida por el cliente. Si viene, reenviar la MISMA dedupKey
   * devuelve el row ya creado (no-op idempotente). Ausente (clientes viejos) → append-only puro.
   */
  dedupKey?: string;
}

/** Vista del consentimiento registrado que se devuelve aguas arriba. */
export interface ConsentView {
  id: string;
  userId: string;
  dataProcessing: boolean;
  inCabinCamera: boolean;
  location: boolean;
  marketing: boolean;
  policyVersion: string;
  acceptedAt: string;
}

@Injectable()
export class ConsentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserta un nuevo consentimiento para `userId`. Operación APPEND-ONLY: solo `create`,
   * nunca `update`/`delete`.
   *
   * Idempotencia (espeja PanicService.trigger / BR-S04): si el cliente envía una `dedupKey`, el
   * UNIQUE(dedup_key) convierte el doble submit (reintento de red) en no-op — el P2002 se captura y
   * se devuelve el row ya registrado, NO se crea otro. Sin `dedupKey` (clientes viejos) sigue siendo
   * append-only puro. Devuelve la vista del row vigente para esa dedupKey.
   */
  async record(userId: string, input: RecordConsentInput): Promise<ConsentView> {
    if (input.dedupKey !== undefined && !isUuidV7(input.dedupKey)) {
      throw new ValidationError('dedupKey debe ser un UUIDv7', { dedupKey: input.dedupKey });
    }
    try {
      const consent = await this.prisma.write.consent.create({
        data: {
          userId,
          dataProcessing: input.dataProcessing,
          inCabinCamera: input.inCabinCamera,
          location: input.location,
          marketing: input.marketing,
          policyVersion: input.policyVersion,
          ip: input.ip,
          dedupKey: input.dedupKey ?? null,
        },
      });
      return this.toView(consent);
    } catch (err) {
      // Doble-submit con la MISMA dedupKey → no-op idempotente: devolvemos el row existente.
      // El P2002 se valida CONTRA la columna del dedup (no cualquier UNIQUE): @veo/database.
      if (input.dedupKey !== undefined && isUniqueViolation(err, 'dedupKey')) {
        const existing = await this.prisma.write.consent.findUnique({
          where: { dedupKey: input.dedupKey },
        });
        if (existing) return this.toView(existing);
      }
      throw err;
    }
  }

  /**
   * Estado VIGENTE de consentimiento del usuario = el row más reciente por `acceptedAt`.
   * `null` si nunca registró ninguno. La app lo usa para mostrar los toggles y, al cambiar uno,
   * re-registrar el snapshot completo (append-only).
   */
  async getCurrent(userId: string): Promise<ConsentView | null> {
    const consent = await this.prisma.read.consent.findFirst({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
    });
    return consent ? this.toView(consent) : null;
  }

  private toView(consent: Consent): ConsentView {
    return {
      id: consent.id,
      userId: consent.userId,
      dataProcessing: consent.dataProcessing,
      inCabinCamera: consent.inCabinCamera,
      location: consent.location,
      marketing: consent.marketing,
      policyVersion: consent.policyVersion,
      acceptedAt: consent.acceptedAt.toISOString(),
    };
  }
}
