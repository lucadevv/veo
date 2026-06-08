/**
 * WsTicketService — acuña y consume tickets efímeros de un solo uso para el handshake de Socket.IO `/ops`.
 *
 * Motivación: el JWT admin vive en una cookie httpOnly del origen de admin-web y NUNCA llega al navegador,
 * por lo que el cliente no puede ponerlo en el handshake del WebSocket. El Route Handler server-side de
 * admin-web acuña un ticket con su Bearer (este endpoint) y entrega solo el ticket al navegador; el gateway
 * lo verifica y lo consume (GETDEL) en la conexión. Un ticket vale para un único handshake y caduca rápido.
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type { AuthenticatedUser } from '@veo/auth';
import type { WsTicket } from '@veo/api-client';
import { REDIS } from '../infra/tokens';

/** TTL corto: el ticket solo cubre el lapso entre la petición del cliente y el handshake. */
const TICKET_TTL_SECONDS = 30;
const KEY_PREFIX = 'ops:wsticket:';

/** Identidad mínima serializada en el ticket; reconstruye el AuthenticatedUser en el gateway. */
export interface WsTicketUser {
  userId: string;
  type: AuthenticatedUser['type'];
  roles: AuthenticatedUser['roles'];
  sessionId: string;
  mfaAt?: number;
}

@Injectable()
export class WsTicketService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Acuña un ticket aleatorio criptográfico y persiste la identidad en Redis con TTL corto. */
  async mint(user: AuthenticatedUser): Promise<WsTicket> {
    const ticket = randomBytes(32).toString('base64url');
    const payload: WsTicketUser = {
      userId: user.userId,
      type: user.type,
      roles: user.roles,
      sessionId: user.sessionId,
      mfaAt: user.mfaVerifiedAt,
    };
    await this.redis.set(
      `${KEY_PREFIX}${ticket}`,
      JSON.stringify(payload),
      'EX',
      TICKET_TTL_SECONDS,
    );
    return { ticket, expiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString() };
  }

  /**
   * Consume el ticket de forma atómica (GETDEL): un segundo uso siempre falla.
   * Devuelve la identidad o `null` si el ticket no existe, expiró o está corrupto.
   */
  async consume(ticket: string): Promise<WsTicketUser | null> {
    if (!ticket) return null;
    const raw = await this.redis.getdel(`${KEY_PREFIX}${ticket}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WsTicketUser;
    } catch {
      return null;
    }
  }
}
