/**
 * Gateway Socket.IO namespace `/driver`.
 * Handshake: el cliente envía el access token (Bearer) en `auth.token` o en el header Authorization.
 * Se verifica el JWT (ES256), se exige tipo 'driver', se resuelve el driverId vía identity (gRPC)
 * y se une el socket a su sala (`driver:{driverId}`). El consumidor Kafka empuja eventos a esa sala.
 *
 * Ingesta GPS (soberanía: NO MQTT): el conductor emite `location` (lat/lon/heading/speed/accuracy/ts);
 * se valida con el schema compartido, se exige que el socket esté autenticado, y se publica
 * `driver.location_updated` a Kafka. El servidor responde por ack `{ ok }`.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket, type Namespace } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import {
  JWT_SERVICE,
  SessionRevocationStore,
  SessionRevokedError,
  toAuthenticatedUser,
  type JwtService,
  type AuthenticatedUser,
  type AccessTokenClaims,
} from '@veo/auth';
import {
  driverLocationReport,
  DRIVER_NAMESPACE,
  HANDSHAKE_SESSION_REVOKED,
  type DriverLocationAck,
} from '@veo/api-client';
import { VehicleClass } from '@veo/shared-types';
import { createLogger, type Logger } from '@veo/observability';
import { GrpcGateway } from '../infra/grpc.gateway';
import type { DriverReply } from '../common/grpc-replies';
import { roomForDriver } from './rooms';
import { LocationPublisherService } from './location-publisher.service';
import { ActiveVehicleTypeResolver } from './active-vehicle-type.resolver';
import type { Env } from '../config/env.schema';

interface HandshakeAuth {
  token?: string;
}

/** Estado que el handshake fija en el socket: el id de perfil (para la sala) y la identidad (para fleet). */
interface DriverSocketData {
  driverId?: string;
  identity?: AuthenticatedUser;
}

/** Evento server→cliente que avisa al device SUPERADO (otra sesión más nueva ganó) para que se deslogue. */
const SESSION_SUPERSEDED_EVENT = 'session:superseded';

/** Evento server→cliente que avisa al conductor SUSPENDIDO (un operador lo suspendió mid-turno) para que
 *  cierre sesión. Espejo de {@link SESSION_SUPERSEDED_EVENT}: se emite ANTES de cerrar el socket vivo. */
const SESSION_SUSPENDED_EVENT = 'session:suspended';

/** Delay (ms) entre el aviso `session:superseded` y el cierre del transporte: `disconnect(true)` descarta la
 *  cola de salida, así garantizamos que el paquete de aviso SALGA antes de cortar el socket del device viejo. */
const SUPERSEDE_FLUSH_MS = 200;

@Injectable()
@WebSocketGateway({ namespace: '/driver', cors: { origin: true, credentials: true } })
export class DriverGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server?: Server;

  private readonly logger: Logger;

  /**
   * SINGLE ACTIVE SESSION: socket ACTIVO por conductor (`driverId → { socketId, sid }`). El `sid` es el id de
   * sesión (uuidv7, time-ordered) del JWT → "el más nuevo gana" es decidible sin coordinación y SIN guerra de
   * reconexión. En memoria = por réplica (dev/1-réplica OK). DEUDA multi-réplica: el kick INMEDIATO cross-réplica
   * necesita Redis pub/sub; la correctitud cross-réplica ya la da el revoke en el login (identity, Lote 1) — el
   * device viejo se desloguea al vencer su access token / fallar el refresh.
   */
  private readonly activeByDriver = new Map<string, { socket: Socket; sid: string }>();

  constructor(
    @Inject(JWT_SERVICE) private readonly jwt: JwtService,
    private readonly grpc: GrpcGateway,
    private readonly locationPublisher: LocationPublisherService,
    private readonly activeVehicleType: ActiveVehicleTypeResolver,
    private readonly revocation: SessionRevocationStore,
    config: ConfigService<Env, true>,
  ) {
    this.logger = createLogger('driver-bff-ws');
    void config;
  }

  /**
   * Registra el middleware de REVOCACIÓN en el namespace `/driver`. Corre en el handshake, ANTES de
   * `handleConnection`: si la sesión está revocada (denylist en Redis), rechaza con `next(Error)` cuyo
   * `message` es {@link HANDSHAKE_SESSION_REVOKED} → el cliente recibe `connect_error` con ese motivo y se
   * desloguea. Un token ausente/inválido NO se rechaza acá (lo maneja `handleConnection` como antes): este
   * middreware SOLO enforcea la revocación (mantiene el comportamiento previo para el resto de rechazos).
   */
  afterInit(server: Server): void {
    // NestJS puede pasar el Server RAÍZ o el Namespace `/driver` ya resuelto según la versión del adapter.
    // Normalizamos al Namespace `/driver`: si el objeto tiene `.of`, es el Server raíz → resolvemos el
    // namespace; si no, ya ES el namespace. Así el middleware queda SIEMPRE en `/driver` (no en `/`).
    const asServer = server as Server & { of?: Server['of'] };
    const namespace: Namespace =
      typeof asServer.of === 'function'
        ? asServer.of(DRIVER_NAMESPACE)
        : (server as unknown as Namespace);
    namespace.use((socket, next) => {
      void this.assertHandshakeNotRevoked(socket as Socket).then(
        () => next(),
        (err: unknown) => next(err instanceof Error ? err : new Error('handshake rechazado')),
      );
    });
  }

  /**
   * Enforcement de revocación en el handshake. Lanza `Error(HANDSHAKE_SESSION_REVOKED)` SOLO si el denylist
   * confirma la revocación. Token ausente/inválido → resuelve sin rechazar (lo decide `handleConnection`).
   * Cualquier otro fallo (p. ej. Redis) → `assertNotRevoked` ya hace fail-open, no rechaza.
   */
  private async assertHandshakeNotRevoked(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) return;
    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAccess(token);
    } catch {
      return; // token inválido/expirado: no es revocación → handleConnection lo rechaza (disconnect).
    }
    try {
      await this.revocation.assertNotRevoked({ sub: claims.sub, sid: claims.sid, iat: claims.iat });
    } catch (err) {
      if (err instanceof SessionRevokedError) {
        this.logger.info({ sid: claims.sid }, 'ws handshake rechazado: sesión revocada');
        throw new Error(HANDSHAKE_SESSION_REVOKED);
      }
      // No debería ocurrir (assertNotRevoked es fail-open), pero por robustez no tumbamos el handshake.
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const { user: identity, sid } = await this.authenticate(client);
      const { driverId, suspended } = await this.resolveDriver(identity);
      // GATE DE SUSPENSIÓN EN EL HANDSHAKE (cierra el residual del RE-LOGIN): el force-disconnect por
      // `driver.suspended` mata la sesión YA abierta, pero un conductor suspendido que RE-LOGUEA obtiene un
      // `sid` NUEVO que no está en el denylist → sin este gate volvería a abrir el socket. `suspended` sale
      // de la MISMA lectura gRPC que resuelve el driverId (costo cero extra). Fail-closed en el handshake.
      if (suspended) throw new Error('conductor suspendido: sesión de socket denegada');

      // SINGLE ACTIVE SESSION (gate DURO en tiempo real). El `sid` es uuidv7 (time-ordered):
      //  · sesión VIEJA (sid < activo) intentando conectar → device superado (su access token aún vive) → rechazar.
      //  · sesión NUEVA (sid > activo) → desplaza: echamos el socket viejo y le avisamos para que se deslogue.
      //  · misma sesión reconectando (sid ==) → solo se actualiza el socketId abajo (no hay a quién echar).
      const active = this.activeByDriver.get(driverId);
      if (active && sid < active.sid) {
        // Sesión VIEJA (sid menor) intentando (re)conectar tras una más nueva → device superado: avisar+cerrar.
        this.supersede(client);
        return;
      }
      if (active && sid > active.sid) {
        // Llegó una sesión MÁS NUEVA (otro device) → echamos al socket viejo (guardado por referencia).
        this.supersede(active.socket);
      }

      await client.join(roomForDriver(driverId));
      const data = client.data as DriverSocketData;
      data.driverId = driverId;
      data.identity = identity;
      this.activeByDriver.set(driverId, { socket: client, sid });
      this.logger.info({ driverId, sid: client.id }, 'ws conductor conectado');
    } catch (err) {
      this.logger.warn({ err, sid: client.id }, 'handshake ws rechazado');
      client.disconnect(true);
    }
  }

  /** Limpia el registro de sesión activa al desconectar — SOLO si el que se va es el ACTIVO (un socket ya
   *  desplazado no debe borrar al nuevo dueño). */
  handleDisconnect(client: Socket): void {
    const { driverId } = client.data as DriverSocketData;
    if (driverId && this.activeByDriver.get(driverId)?.socket.id === client.id) {
      this.activeByDriver.delete(driverId);
    }
  }

  /**
   * Avisa al device SUPERADO (`session:superseded`) y cierra su socket. Delega el patrón avisar→cerrar en
   * {@link kickSocket}.
   */
  private supersede(socket: Socket): void {
    this.kickSocket(socket, SESSION_SUPERSEDED_EVENT);
  }

  /**
   * Cierre PROACTIVO del socket VIVO de un conductor SUSPENDIDO. Lo invoca el consumer de `driver.suspended`:
   * sin esto la sesión ya conectada seguía viva ≤15m (hasta vencer el access token), emitiendo GPS a Kafka +
   * presencia fantasma en el mapa /ops + recibiendo pushes en su sala `driver:{driverId}`.
   *
   * KEY-SPACE (hazard marcado por el gate): el Map `activeByDriver` está keyeado por el id de PERFIL Driver
   * (lo resuelve el handshake vía `resolveDriver` → identity.GetDriverByUser → `driver.id`), y el evento
   * `driver.suspended` trae ESE MISMO `driverId` de perfil (identity lo emite con el CAS de `Driver.suspendedAt`).
   * Coinciden → NO hay traducción userId↔driverId acá. (La vía `fleet.driver_suspended` por ITV, keyeada por
   * `userId`, es otra clase y queda fuera de este lote.)
   *
   * Idempotente: sin sesión activa (ya cerrada / doble evento / conductor offline) → no-op silencioso.
   * @returns `true` si había una sesión activa que se echó; `false` si no había a quién cerrar.
   */
  disconnectSuspendedDriver(driverId: string): boolean {
    const active = this.activeByDriver.get(driverId);
    if (!active) return false;
    this.logger.info({ driverId }, 'ws conductor suspendido: forzando cierre de sesión en vivo');
    this.kickSocket(active.socket, SESSION_SUSPENDED_EVENT);
    return true;
  }

  /**
   * Patrón avisar→cerrar de un socket: emite `event` (la señal de por qué se cierra) y cierra el transporte
   * tras un pequeño delay. `disconnect(true)` descarta la cola de salida de socket.io, así el paquete de aviso
   * SALE antes de cortar (la app lo usa para deslogar con un mensaje claro). Si el socket ya se fue antes del
   * timer, `disconnect` es un no-op seguro.
   */
  private kickSocket(socket: Socket, event: string): void {
    socket.emit(event);
    setTimeout(() => socket.disconnect(true), SUPERSEDE_FLUSH_MS);
  }

  /**
   * Evento entrante `location`: GPS del conductor. Exige socket autenticado (driverId en client.data,
   * fijado en el handshake), valida el reporte y publica `driver.location_updated` a Kafka.
   */
  @SubscribeMessage('location')
  async onLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<DriverLocationAck> {
    const { driverId, identity } = client.data as DriverSocketData;
    if (!driverId || !identity) return { ok: false, error: 'unauthenticated' };
    const parsed = driverLocationReport.safeParse(body);
    if (!parsed.success) {
      // Observabilidad (regla #6): un reporte inválido no debe morir en silencio. Deja ver POR QUÉ se
      // rechaza el ping (campo/tipo) sin depender de los logs del cliente RN.
      this.logger.warn(
        { driverId, issues: parsed.error.issues },
        'location report inválido (ping descartado)',
      );
      return { ok: false, error: 'invalid_report' };
    }
    // SERVER-AUTHORITATIVE: la clase de vehículo la decide el vehículo ACTIVO del conductor en fleet, NO
    // lo que declara el cliente en el ping (que era spoofeable). Sobreescribimos `vehicleType` con el
    // resuelto; si fleet no responde, el resolver cae al valor del ping (degradación honesta).
    // El `?? CAR` SE QUEDA (ADR 013 · Lote D): es el fallback de ÚLTIMO recurso para apps viejas que no
    // mandan el campo Y fleet caído a la vez — no oculta una clase nueva (si el ping la trae, viaja; si
    // fleet responde, manda la clase certificada). Sin él, un ping legacy dejaría de publicar ubicación.
    const activeVehicle = await this.activeVehicleType.resolve(
      identity,
      parsed.data.vehicleType ?? VehicleClass.CAR,
    );
    const published = await this.locationPublisher.publishDriverLocation(driverId, {
      ...parsed.data,
      vehicleType: activeVehicle.vehicleType,
      // Identidad del vehículo activo: key del carry anti-clobber en dispatch (no vehicleType).
      vehicleId: activeVehicle.vehicleId,
      // B5-3 · attrs de eligibilidad (si el modelo activo los aporta); el publisher los sella en el ping.
      seats: activeVehicle.seats,
      segment: activeVehicle.segment,
      vehicleYear: activeVehicle.vehicleYear,
      // B5-3.2 · certs vigentes del conductor para el gate de verticales en dispatch (fail-closed).
      certifications: activeVehicle.certifications,
    });
    return published ? { ok: true } : { ok: false, error: 'publish_failed' };
  }

  /** Emite un evento a la sala del conductor. Lo invoca el consumidor Kafka. */
  emitToDriver(driverId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(roomForDriver(driverId)).emit(event, payload);
  }

  private async authenticate(client: Socket): Promise<{ user: AuthenticatedUser; sid: string }> {
    const token = this.extractToken(client);
    if (!token) throw new Error('falta el token de acceso');
    const claims = await this.jwt.verifyAccess(token);
    const user = toAuthenticatedUser(claims);
    if (user.type !== 'driver') throw new Error('el socket /driver es exclusivo de conductores');
    // `sid` = id de sesión (uuidv7) del JWT: gobierna el single-active-session del handshake.
    return { user, sid: claims.sid };
  }

  private extractToken(client: Socket): string | undefined {
    const auth = client.handshake.auth as HandshakeAuth | undefined;
    if (auth?.token) return auth.token.replace(/^Bearer\s+/i, '');
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return undefined;
  }

  /**
   * Resuelve el perfil del conductor a partir de la identidad autenticada (identity.GetDriverByUser).
   * Devuelve el id de PERFIL Driver (clave de la sala y del Map `activeByDriver`) y si está SUSPENDIDO.
   * `suspendedAt` viaja como "" cuando NO está suspendido y como ISO-8601 cuando sí → `Boolean(...)` lo
   * normaliza (una sola lectura gRPC alimenta la sala Y el gate de suspensión del handshake).
   */
  private async resolveDriver(
    identity: AuthenticatedUser,
  ): Promise<{ driverId: string; suspended: boolean }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found) throw new Error('no existe perfil de conductor para el usuario');
    return { driverId: driver.id, suspended: Boolean(driver.suspendedAt) };
  }
}
