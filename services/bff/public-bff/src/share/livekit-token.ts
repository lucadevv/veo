/**
 * Minteo de access tokens para LiveKit self-hosted (soberanía §0.7).
 * El token es un JWT HS256 firmado con el API secret del servidor LiveKit (formato que LiveKit espera).
 * El viewer familiar recibe SOLO permiso de suscripción (no publica): es un espectador del habitáculo.
 * Se usa node:crypto puro para no depender de SDKs de terceros.
 */
import { createHmac, randomUUID } from 'node:crypto';

export interface LiveKitConfig {
  /** URL wss/ws del servidor LiveKit self-hosted. */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** TTL del token de viewer en segundos. */
  ttlSec: number;
}

/** El video está habilitado solo si hay credenciales reales del servidor LiveKit. */
export function liveKitEnabled(cfg: LiveKitConfig): boolean {
  return cfg.apiKey.length > 0 && cfg.apiSecret.length > 0;
}

/**
 * Nombre de la sala LiveKit del habitáculo de un viaje. CONTRATO CROSS-SERVICE: DEBE coincidir
 * carácter a carácter con `roomNameForTrip` de media-service (`trip-${tripId}`), que es donde el
 * conductor PUBLICA su cámara (y donde corre el egress de grabación). Antes acá se reusaba la sala
 * de Socket.IO `familyRoom` (`trip:${tripId}`), un room DISTINTO → el viewer entraba a una sala vacía
 * y no veía nada. No usar `familyRoom`/`passengerRoom` (esos son salas Socket.IO, otro espacio).
 */
export function liveKitRoomForTrip(tripId: string): string {
  return `trip-${tripId}`;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Acuña un token de viewer (solo suscripción) para una sala concreta.
 * Claims según el contrato de LiveKit: iss=apiKey, sub=identity, exp/nbf y el grant `video`.
 */
export function mintViewerToken(
  cfg: LiveKitConfig,
  opts: { room: string; identityPrefix: string },
): { token: string; identity: string; expiresAt: string } {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + cfg.ttlSec;
  const identity = `${opts.identityPrefix}-${randomUUID()}`;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: cfg.apiKey,
    sub: identity,
    nbf: nowSec,
    exp: expSec,
    video: {
      room: opts.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    },
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', cfg.apiSecret).update(signingInput).digest('base64url');

  return {
    token: `${signingInput}.${signature}`,
    identity,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}
