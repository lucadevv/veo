/**
 * ClickHouseService — cliente mínimo a la interfaz HTTP de ClickHouse (sin dependencias nuevas).
 * Ejecuta SQL y devuelve filas JSON. Si la consulta falla (p.ej. tabla inexistente), lanza para que
 * el llamador degrade la métrica a 0/empty con un flag (no inventar datos).
 *
 * DEUDA: sin uso hoy — el overview migró a agregación OLTP (trip/dispatch/panic/payment). Se retiene para
 * analytics GPS/OLAP (activeDrivers/pings + serie histórica por hora desde gps_pings). · techo: no está
 * wired a ningún controller · gatillo: cuando tracking-service (Go) + ClickHouse estén arriba y se quiera
 * el panel de GPS histórico → re-wire en un AnalyticsModule (o borrar si se descarta esa capacidad).
 */
import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalServiceError } from '@veo/utils';
import { LOGGER, type Logger } from '@veo/observability';
import type { Env } from '../config/env.schema';

interface ClickHouseJsonResponse<T> {
  data: T[];
  rows: number;
}

@Injectable()
export class ClickHouseService {
  private readonly base: string;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly timeoutMs = 5000;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.base = config.get('CLICKHOUSE_URL', { infer: true }).replace(/\/$/, '');
    this.database = config.get('CLICKHOUSE_DB', { infer: true });
    this.user = config.get('CLICKHOUSE_USER', { infer: true });
    this.password = config.get('CLICKHOUSE_PASSWORD', { infer: true });
  }

  async query<T>(sql: string): Promise<T[]> {
    const url = new URL(this.base + '/');
    url.searchParams.set('database', this.database);
    url.searchParams.set('user', this.user);
    url.searchParams.set('password', this.password);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: `${sql.trim()} FORMAT JSON`,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn({ status: res.status }, 'consulta ClickHouse fallida');
        throw new ExternalServiceError('consulta ClickHouse fallida', { status: res.status, body: text.slice(0, 200) });
      }
      const parsed = JSON.parse(text) as ClickHouseJsonResponse<T>;
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
