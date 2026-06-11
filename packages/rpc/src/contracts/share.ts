/**
 * Tipos wire de veo.share.v1 (proto/share.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** Contacto de confianza verificado de un usuario (para notificar en pánico). */
export interface TrustedContact {
  id: string;
  userId: string;
  phone: string;
  name: string;
  relationship: string;
  otpVerified: boolean;
}

/** share.GetTrustedContacts / mensaje TrustedContactsReply. */
export interface TrustedContactsReply {
  contacts: TrustedContact[];
}
