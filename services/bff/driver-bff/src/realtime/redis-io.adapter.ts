/**
 * Adapter WebSocket de Nest que monta el `@socket.io/redis-adapter` sobre el server Socket.IO del `/driver`.
 *
 * POR QUÉ (Lote 4 · multi-réplica): sin este adapter, socket.io usa el adapter DEFAULT in-memory (estado
 * por-réplica). En multi-pod eso rompe el fan-out (un push a `driver:{id}` NO cruza al pod donde vive el
 * socket), el single-session y el force-disconnect por suspensión. Con el redis-adapter montado, las
 * operaciones de sala (`io.in(room).emit()`, `.disconnectSockets()`, `.fetchSockets()`) y la mensajería
 * inter-servidor (`serverSideEmit`) se PROPAGAN cross-pod por canal Redis pub/sub — el fan-out cross-pod
 * sale gratis porque los sockets ya se unen a la sala `driver:{driverId}`.
 *
 * DEGRADACIÓN HONESTA: montar el adapter NO bloquea el boot. Si Redis está caído, el redis-adapter sigue
 * entregando a los sockets LOCALES (el emit local es síncrono); solo deja de propagar cross-nodo hasta que
 * Redis vuelve. Los clientes pub/sub llevan handler de `error` para que un blip transitorio no tumbe el
 * proceso (Node mata ante un evento `error` sin listener).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createLogger, type Logger } from '@veo/observability';
import type { Redis } from '@veo/redis';
import type { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly logger: Logger;

  constructor(app: INestApplicationContext, redis: Redis) {
    super(app);
    this.logger = createLogger('driver-bff-ws-adapter');
    // pub/sub DEDICADOS: el cliente `sub` entra en modo subscriber (bloquea comandos normales), por eso NO
    // reusamos el REDIS compartido directo — lo duplicamos. `duplicate()` hereda la config resiliente del
    // factory (`maxRetriesPerRequest: null` + backoff) pero NO el handler de `error` → lo re-enganchamos.
    this.pub = redis.duplicate();
    this.sub = redis.duplicate();
    for (const [name, client] of [
      ['pub', this.pub],
      ['sub', this.sub],
    ] as const) {
      client.on('error', (err: Error): void => {
        this.logger.warn({ err, client: name }, 'redis-adapter pub/sub error (auto-retry en curso)');
      });
    }
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    // Se monta en el Server RAÍZ → cubre TODOS los namespaces (incluido `/driver`). No lanza si Redis está
    // caído: el adapter se conecta perezosamente y degrada a entrega local mientras tanto.
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
}
