/**
 * Puerto PUSH (FOUNDATION §9). Riel externo (FCM/APNs) tras puerto propio.
 *
 * Convención del subsistema: los DISCRIMINANTES de dominio (plataforma, riel, resultado) son objetos
 * `as const` con su tipo derivado — NUNCA string literals sueltos. Esto da una fuente única de verdad,
 * autocompletado, refactor-safe y comparaciones `=== PushOutcome.Accepted` (no `=== 'accepted'`).
 */

/** Plataforma destino del push. */
export const PushPlatform = { Ios: 'ios', Android: 'android' } as const;
export type PushPlatform = (typeof PushPlatform)[keyof typeof PushPlatform];

/** Riel de transporte concreto (qué proveedor entrega). */
export const PushTransportKey = { Fcm: 'fcm', Apns: 'apns' } as const;
export type PushTransportKey = (typeof PushTransportKey)[keyof typeof PushTransportKey];

/** Modo del adapter PUSH (sandbox = log determinista; live = envía por el riel real). */
export const PushMode = { Sandbox: 'sandbox', Live: 'live' } as const;
export type PushMode = (typeof PushMode)[keyof typeof PushMode];

/** Resultado TIPADO de un intento de envío al riel. */
export const PushOutcome = {
  /** El riel ACEPTÓ el mensaje (FCM/APNs 200). NO garantiza recepción en el device. Estado honesto: SENT. */
  Accepted: 'accepted',
  /** Token inválido/baja (FCM UNREGISTERED · APNs 410). Borrar token, NO reintentar. */
  InvalidToken: 'invalidToken',
  /** Cuota/throttling (429). Reintentar respetando `retryAfterMs`. */
  RateLimited: 'rateLimited',
  /** Fallo transitorio (5xx, red, timeout). Reintentar con backoff. */
  Transient: 'transient',
} as const;
export type PushOutcome = (typeof PushOutcome)[keyof typeof PushOutcome];

/** A QUÉ se envía el push. Token = 1 device (targeted); Topic/Condition = broadcast (FCM hace el fanout). */
export const PushTargetKind = { Token: 'token', Topic: 'topic', Condition: 'condition' } as const;
export type PushTargetKind = (typeof PushTargetKind)[keyof typeof PushTargetKind];

/**
 * Destino del push (discriminated union). El caso `Token` mantiene EXACTO el comportamiento 1-a-1
 * (un device, con su plataforma para el ruteo). `Topic`/`Condition` son broadcast: un solo request a
 * FCM que entrega a N suscriptores (APNs no tiene topics → solo el riel FCM los soporta).
 */
export type PushTarget =
  | {
      readonly kind: typeof PushTargetKind.Token;
      readonly token: string;
      readonly platform: PushPlatform;
    }
  | { readonly kind: typeof PushTargetKind.Topic; readonly topic: string }
  | { readonly kind: typeof PushTargetKind.Condition; readonly condition: string };

export interface PushMessage {
  /** A quién/dónde se entrega: un token (targeted) o un topic/condición (broadcast). */
  target: PushTarget;
  title: string;
  body: string;
  /** Datos planos (FCM exige string→string; APNs los anida junto a `aps`). */
  data?: Record<string, string>;
}

/**
 * Resultado del riel. El cliente NUNCA tira excepción por un rechazo: traduce el status/cuerpo a uno de
 * estos casos para que el motor decida sin parsear strings (estado honesto, limpieza de tokens, retry).
 */
export type PushResult =
  | { readonly outcome: typeof PushOutcome.Accepted; readonly providerMessageId?: string }
  | { readonly outcome: typeof PushOutcome.InvalidToken; readonly reason: string }
  | {
      readonly outcome: typeof PushOutcome.RateLimited;
      readonly retryAfterMs?: number;
      readonly reason: string;
    }
  | { readonly outcome: typeof PushOutcome.Transient; readonly reason: string };

/**
 * Strategy: un riel concreto de entrega (FcmTransport, ApnsTransport, futuro WebPushTransport). Todos
 * implementan la MISMA interfaz; el `PushSender` resuelve cuál usar por un registry (sin if/switch).
 */
export interface PushTransport {
  send(msg: PushMessage): Promise<PushResult>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Fachada de envío de push (sandbox o live con registry de transportes). */
export interface PushSender {
  /** Envía un push y devuelve el resultado TIPADO del riel (sin lanzar por rechazos del proveedor). */
  send(msg: PushMessage): Promise<PushResult>;
}

export const TOKEN_INVALIDATOR = Symbol('TOKEN_INVALIDATOR');

/**
 * Puerto para dar de baja un token de push MUERTO (FCM UNREGISTERED · APNs 410). Lo implementa el
 * registro de dispositivos. Cierra el feedback loop riel→registro: un token rechazado se borra y deja
 * de reintentarse/acumularse. DIP: el dispatcher depende de esta abstracción, no del repo concreto.
 */
export interface TokenInvalidator {
  invalidate(token: string): Promise<void>;
}
