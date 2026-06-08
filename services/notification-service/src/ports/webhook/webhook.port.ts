/**
 * Puerto WEBHOOK (FOUNDATION §9). HTTP saliente FIRMADO (HMAC-SHA256) hacia destinos externos
 * (central de monitoreo, integraciones). Es propio (no third-party). Selección por VEO_WEBHOOK_MODE.
 */
export interface WebhookMessage {
  url: string;
  payload: Record<string, unknown>;
}

export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');

export interface WebhookSender {
  send(msg: WebhookMessage): Promise<void>;
}
