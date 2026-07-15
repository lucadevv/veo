/**
 * SessionIdleGuard — enforcement de la política `auth.session-timeout` (PBAC · ADR-024 §5 · Fase 2 NET-NEW).
 *
 * Cierra la sesión admin tras N minutos de INACTIVIDAD (idle), complementando el TTL DURO del access token
 * (15m). Hermano del `SessionRevocationGuard`: corre tras `JwtAuthGuard` (necesita `req.user`) y toca el MISMO
 * Redis compartido, pero con su propia clave `lastseen` por sesión (`sid`). Aditivo y fail-safe — NO modifica
 * el JWT, ni el refresh, ni la revocación existentes.
 *
 * MECÁNICA (por request autenticado):
 *   1. lee `lastseen:{sid}`; si existe y `now - last > idleMin` → RECHAZA (fuerza re-login) y borra la clave.
 *   2. si no excede (o es la primera actividad) → refresca `lastseen:{sid} = now` con TTL.
 *
 * REGLA DE ORO PBAC (nunca fail-open · ADR §4):
 *   • Sin `req.user` (@Public/sonda) → ALLOW (no hay sesión que trackear).
 *   • Política `enabled=false` (default NET-NEW) → ALLOW sin tocar Redis: solo rige el TTL duro del token.
 *   • Redis caído/lento → ALLOW (log ruidoso): NO trabar la sesión por un blip de infra. El TTL duro del token
 *     (≤15m) sigue siendo el respaldo. Fail-safe hacia DISPONIBILIDAD, igual que el `SessionRevocationGuard`.
 *
 * ALCANCE CONTENIDO (honesto): el idle se enforcea sobre las requests que portan access token (≤15m de vida),
 * usando el `sid` estable de la sesión. El TTL de la clave `lastseen` cubre al menos la vida de un token, así
 * que para `idleMin` < 15m la detección es fiable dentro de la vida del token. Un idle MÁS LARGO que la clave,
 * seguido de un `refresh` (endpoint @Public, no guardado), reinicia el tracking: la enforcement AIRTIGHT
 * cross-refresh (rechazar el refresh token de una sesión idle) exige tocar identity-service y queda FUERA de
 * este lote (follow-up), por invasiva. Aquí el backstop duro sigue siendo el TTL de 15m del access token.
 */
import {
  Injectable,
  Inject,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ForbiddenError, CLOCK, type Clock } from '@veo/utils';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AuthenticatedUser,
} from '@veo/auth';
import { POLICY_READER, type PolicyReader } from '@veo/policy';
import { REDIS } from '../infra/tokens';

/** Rechazo por inactividad — 403 terminal (no dispara el auto-refresh que sí haría un 401). */
export class SessionIdleTimeoutError extends ForbiddenError {
  constructor(idleMin: number) {
    super('Sesión cerrada por inactividad; volvé a iniciar sesión', {
      policy: 'auth.session-timeout',
      idleMin,
    });
  }
}

/** Margen sobre la ventana idle para que el timestamp sobreviva lo suficiente para evaluarse (skew + red). */
const LASTSEEN_TTL_MARGIN_SECONDS = 60;

const lastSeenKey = (sid: string): string => `veo:admin:session:lastseen:${sid}`;

interface RequestLike {
  user?: AuthenticatedUser;
}

@Injectable()
export class SessionIdleGuard implements CanActivate {
  private readonly logger = new Logger(SessionIdleGuard.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(POLICY_READER) private readonly policy: PolicyReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestLike>();
    const user = req.user;
    if (!user) return true; // @Public / sonda: nada que trackear.

    // Fail-safe: política apagada (default NET-NEW) → no chequeamos idle (solo rige el TTL duro del token).
    if (!(await this.policy.getEnabled('auth.session-timeout'))) return true;

    const idleMin = await this.policy.number('auth.session-timeout', 'idleMin', 30);
    const idleSec = idleMin * 60;
    const nowSec = Math.floor(this.clock.now() / 1000);
    const key = lastSeenKey(user.sessionId);
    // La clave debe sobrevivir al menos la vida de un token para que el idle sea detectable en ese lapso.
    const ttlSec = Math.max(idleSec, ACCESS_TOKEN_TTL_SECONDS) + LASTSEEN_TTL_MARGIN_SECONDS;

    try {
      const prev = await this.redis.get(key);
      if (prev != null) {
        const last = Number(prev);
        if (Number.isFinite(last) && nowSec - last > idleSec) {
          // Idle excedido: cerrar la sesión. Borrar la clave para que el próximo login arranque limpio.
          await this.redis.del(key).catch(() => undefined);
          throw new SessionIdleTimeoutError(idleMin);
        }
      }
      // Actividad válida: refrescar lastActivity con TTL.
      await this.redis.set(key, String(nowSec), 'EX', ttlSec);
    } catch (err) {
      if (err instanceof SessionIdleTimeoutError) throw err;
      // Redis indisponible → NO trabar la sesión (fail-safe a disponibilidad). El TTL duro del token respalda.
      this.logger.warn(
        { err, sid: user.sessionId },
        'session-idle: Redis indisponible → se omite el chequeo idle (respaldo: TTL duro del token)',
      );
      return true;
    }
    return true;
  }
}
