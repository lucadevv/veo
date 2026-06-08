/**
 * TemplateService — resuelve plantillas i18n (default es-PE) desde Postgres y las renderiza.
 * Interpolación simple y segura: reemplaza {{var}} por el valor de las variables del payload.
 * `payload.to` es la dirección de destino; `payload.vars` (o el propio payload) las variables.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundError, ValidationError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
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

@Injectable()
export class TemplateService implements TemplateRenderer {
  private readonly defaultLocale: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultLocale = config.getOrThrow<string>('DEFAULT_LOCALE');
  }

  async render(rec: NotificationRecord): Promise<RenderedMessage> {
    const to = typeof rec.payload.to === 'string' ? rec.payload.to : '';
    if (!to) throw new ValidationError('payload.to es requerido para entregar la notificación');

    const tpl = await this.prisma.read.template.findUnique({ where: { key: rec.template } });
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
}
