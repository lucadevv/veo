/**
 * ConsentsService — registro server-side de consentimientos Ley 29733 (APPEND-ONLY).
 * Cada aceptación del pasajero es un row inmutable nuevo (`Consent`). NUNCA se actualiza ni se borra:
 * el estado vigente de un usuario es el consentimiento más reciente. Esto preserva la evidencia
 * histórica exigida por la Ley 29733 (qué aceptó, cuándo, desde qué IP y con qué versión de política).
 */
import { Injectable } from '@nestjs/common';
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
   * nunca `update`/`delete`. Devuelve la vista del row creado.
   */
  async record(userId: string, input: RecordConsentInput): Promise<ConsentView> {
    const consent = await this.prisma.write.consent.create({
      data: {
        userId,
        dataProcessing: input.dataProcessing,
        inCabinCamera: input.inCabinCamera,
        location: input.location,
        marketing: input.marketing,
        policyVersion: input.policyVersion,
        ip: input.ip,
      },
    });
    return this.toView(consent);
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
