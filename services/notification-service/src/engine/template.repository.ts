/**
 * TemplateRepository — único dueño de Prisma para las plantillas i18n (FOUNDATION §10).
 * Solo lecturas: resolver una plantilla por key (entrega) y cargar varias en UNA query (bandeja).
 * El TemplateService depende de este repo, no de Prisma (mismo patrón que Notification/DeviceToken repos).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import type { Template } from '../generated/prisma';

/** Subset renderizable de la fila (lo que la bandeja in-app necesita). */
export type RenderableTemplateRow = Pick<Template, 'key' | 'subject' | 'body'>;

@Injectable()
export class TemplateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Plantilla completa por key de negocio (`null` si no existe). */
  findByKey(key: string): Promise<Template | null> {
    return this.prisma.read.template.findUnique({ where: { key } });
  }

  /**
   * Carga las plantillas de las `keys` dadas en UNA sola query (evita N+1 al renderizar la bandeja,
   * §5 escalabilidad). Deduplica las keys. Las keys sin plantilla simplemente no aparecen en el resultado.
   */
  findRenderableByKeys(keys: readonly string[]): Promise<RenderableTemplateRow[]> {
    return this.prisma.read.template.findMany({
      where: { key: { in: [...new Set(keys)] } },
      select: { key: true, subject: true, body: true },
    });
  }
}
