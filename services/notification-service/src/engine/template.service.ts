/**
 * TemplateService — resuelve plantillas i18n (default es-PE) desde Postgres y las renderiza.
 * Interpolación simple y segura: reemplaza {{var}} por el valor de las variables del payload.
 * `payload.to` es la dirección de destino; `payload.vars` (o el propio payload) las variables.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError, ValidationError } from '@veo/utils';
import { TemplateRepository } from './template.repository';
import type { Env } from '../config/env.schema';
import type { NotificationRecord, RenderedMessage, TemplateRenderer } from './types';

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Interpola {{var}} con las variables dadas. Variables ausentes → cadena vacía. */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ya acotado a primitivos
    return String(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Texto renderizado para la BANDEJA in-app (título + cuerpo, sin dirección de destino). */
export interface InboxRendered {
  title: string;
  body: string;
}

/** Plantilla mínima necesaria para renderizar (subset de la fila completa). */
export interface RenderableTemplate {
  subject: string | null;
  body: string;
}

@Injectable()
export class TemplateService implements TemplateRenderer {
  private readonly defaultLocale: string;

  constructor(
    private readonly templates: TemplateRepository,
    config: ConfigService<Env, true>,
  ) {
    this.defaultLocale = config.getOrThrow<string>('DEFAULT_LOCALE');
  }

  async render(rec: NotificationRecord): Promise<RenderedMessage> {
    const to = typeof rec.payload.to === 'string' ? rec.payload.to : '';
    if (!to) throw new ValidationError('payload.to es requerido para entregar la notificación');

    const tpl = await this.templates.findByKey(rec.template);
    if (!tpl) throw new NotFoundError(`Plantilla '${rec.template}' no encontrada`);
    if (tpl.channel !== rec.channel) {
      throw new ValidationError(
        `Plantilla '${rec.template}' es del canal ${tpl.channel}, no ${rec.channel}`,
      );
    }

    const vars = isRecord(rec.payload.vars) ? rec.payload.vars : rec.payload;
    return {
      to,
      subject: tpl.subject ? interpolate(tpl.subject, vars) : undefined,
      body: interpolate(tpl.body, vars),
    };
  }

  /**
   * Carga las plantillas de las `keys` dadas en UNA sola query (evita N+1 al renderizar la bandeja,
   * §5 escalabilidad). Devuelve un mapa key→plantilla; las keys sin plantilla quedan ausentes.
   */
  async loadTemplatesByKeys(keys: readonly string[]): Promise<Map<string, RenderableTemplate>> {
    if (keys.length === 0) return new Map();
    const rows = await this.templates.findRenderableByKeys(keys);
    return new Map(rows.map((t) => [t.key, { subject: t.subject, body: t.body }]));
  }

  /**
   * Renderiza una notificación para la BANDEJA in-app. A diferencia de `render()` (entrega):
   * NO exige `payload.to` ni valida el canal — la bandeja solo MUESTRA texto, no entrega a un riel.
   * Resiliente: si la plantilla no existe (key huérfana), devuelve un fallback honesto en vez de
   * lanzar — una sola plantilla faltante NO debe romper toda la lista.
   */
  renderInbox(rec: NotificationRecord, tpl: RenderableTemplate | undefined): InboxRendered {
    if (!tpl) return { title: 'VEO', body: 'Tienes una notificación nueva.' };
    const vars = isRecord(rec.payload.vars) ? rec.payload.vars : rec.payload;
    const title = tpl.subject ? interpolate(tpl.subject, vars) : '';
    return { title: title || 'VEO', body: interpolate(tpl.body, vars) };
  }
}
