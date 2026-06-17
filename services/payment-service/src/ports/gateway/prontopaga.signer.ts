/**
 * Firmador HMAC-SHA256 de ProntoPaga (helper PURO, sin I/O — testeable con vectores).
 * Doc oficial: https://docs.prontopaga.com/docs/sign-transactions
 *
 * Algoritmo (verificado contra la doc):
 *   1. Tomar todos los parámetros del body EXCEPTO `sign`.
 *   2. Ordenar las CLAVES alfabéticamente.
 *   3. Concatenar `clave + valor` de cada par, SIN separador.
 *   4. `sign = HMAC_SHA256(concat, secretKey)` en hex.
 *   5. El `sign` viaja como un campo más del JSON del request.
 *
 * El MISMO algoritmo verifica los webhooks entrantes: ProntoPaga firma el body del webhook con la
 * misma secretKey; recomputamos sobre todos los campos salvo `sign` y comparamos TIMING-SAFE.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Valores admitidos en el body firmable. ProntoPaga firma strings/numbers planos. */
export type SignableValue = string | number | boolean | null | undefined;
export type SignablePayload = Record<string, SignableValue>;

/**
 * Construye la cadena a firmar: claves (≠ `sign`) ordenadas alfabéticamente, concatenando
 * `clave+valor` sin separador. Los valores se serializan con String(); se OMITEN los `undefined`/`null`
 * (no se envían al proveedor, así que no entran en la firma — espeja lo que viaja en el JSON).
 */
export function buildSignBase(payload: SignablePayload): string {
  return Object.keys(payload)
    .filter((k) => k !== 'sign' && payload[k] !== undefined && payload[k] !== null)
    .sort()
    .reduce((acc, k) => acc + k + String(payload[k]), '');
}

/** Firma un payload con la secretKey. Devuelve el HMAC-SHA256 en hex (campo `sign`). */
export function signPayload(payload: SignablePayload, secretKey: string): string {
  return createHmac('sha256', secretKey).update(buildSignBase(payload), 'utf8').digest('hex');
}

/** Devuelve una copia del payload con el campo `sign` ya calculado (listo para enviar). */
export function withSignature<T extends SignablePayload>(
  payload: T,
  secretKey: string,
): T & { sign: string } {
  return { ...payload, sign: signPayload(payload, secretKey) };
}

/**
 * Verifica la firma de un payload (webhook entrante) de forma TIMING-SAFE.
 * Recomputa la firma sobre todos los campos salvo `sign` y compara con `crypto.timingSafeEqual`
 * (evita oráculos de tiempo). Devuelve false si falta `sign`, si difiere la longitud, o si no coincide.
 */
export function verifySignature(
  payload: SignablePayload,
  secretKey: string,
  provided: string | undefined,
): boolean {
  if (!provided || typeof provided !== 'string') return false;
  const expected = signPayload(payload, secretKey);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual exige longitudes iguales; si difieren, ya es inválida (comparación corta segura).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
