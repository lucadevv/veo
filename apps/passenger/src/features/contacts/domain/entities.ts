/**
 * Entidades de dominio de Trusted Contacts (BR-I06).
 *
 * El contrato soberano vive en `@veo/api-client` (`contactView`/`contactResource`); la capa data
 * valida las respuestas con esos schemas. Estas entidades son la abstracción de DOMINIO sobre ambos
 * shapes (listado y recurso de comando), desacoplada del transporte.
 */
export interface TrustedContact {
  id: string;
  /** Nombre visible del contacto. */
  name: string;
  /** Teléfono peruano (+51 9XXXXXXXX). */
  phone: string;
  /** Parentesco / relación (requerido por el bff). */
  relationship: string;
  /** true cuando el contacto verificó su OTP (regla: cada contacto verifica). */
  verified: boolean;
  /** Correo opcional (solo presente en respuestas de comando del bff). */
  email?: string | null;
  /** Fecha de alta ISO (solo presente en respuestas de comando del bff). */
  createdAt?: string;
}

/** Datos para registrar un nuevo contacto (hasta 3, según reglas del producto). */
export interface NewTrustedContact {
  name: string;
  phone: string;
  relationship: string;
  email?: string;
}

/** Máximo de contactos de confianza permitido por el producto. */
export const MAX_TRUSTED_CONTACTS = 3;
