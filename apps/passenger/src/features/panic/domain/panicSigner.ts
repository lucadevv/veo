import type {GeoPoint} from '@veo/api-client';

/** Mensaje canónico a firmar (BR-S04). El orden/serialización lo define el módulo nativo. */
export interface PanicSignaturePayload {
  tripId: string;
  dedupKey: string;
  geo: GeoPoint;
}

/**
 * Puerto de firma HMAC del pánico (DIP). La firma HMAC-SHA256 la produce el dispositivo con su
 * secreto provisionado de forma segura (Keychain/Keystore); el bff la reenvía sin tocarla. La
 * generación REAL la implementa la OLEADA NATIVA: aquí solo se define la abstracción.
 *
 * Firma exacta para la oleada nativa:
 *   sign(payload: PanicSignaturePayload): Promise<string>   // hex de HMAC-SHA256
 */
export interface PanicSigner {
  sign(payload: PanicSignaturePayload): Promise<string>;
}
