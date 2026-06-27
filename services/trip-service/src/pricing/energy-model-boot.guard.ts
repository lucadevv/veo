/**
 * F2.1b · guard de ARRANQUE del flip del modelo de energía (PRICING_ENERGY_MODEL_ENABLED).
 *
 * Con el flip ON la tarifa AUTORITATIVA deriva el costo de energía del EnergyCatalog (precio/fuente ÷
 * rendimiento de la oferta). Si el catálogo NO tiene precio para una fuente que una oferta usa, el create
 * caería a 0 (cobro-de-menos ~13% en rutas largas) o lanzaría InvalidStateError. Este guard FALLA EL BOOT en
 * esa config inválida: no se sirve tráfico con el flip a medio poblar. Exige TODA fuente referenciada por
 * CUALQUIER oferta (visible u oculta — ver `requiredEnergySources`), no solo las visibles.
 *
 * Fail-fast (FOUNDATION §0 · validación al arranque, como el zod del env). Secuencia segura del flip:
 *   1) deploy con flag OFF → 2) el admin puebla el catálogo (panel de precios de energía) →
 *   3) redeploy con flag ON → este guard verifica que (2) se hizo. Si no, el servicio no levanta.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type EnergySource } from '@veo/shared-types';
import { InvalidStateError } from '@veo/utils';
import { EnergyCatalogService } from './energy-catalog.service';
import { requiredEnergySources } from './energy-requirements';
import type { Env } from '../config/env.schema';

@Injectable()
export class EnergyModelBootGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(EnergyModelBootGuard.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly energyCatalog: EnergyCatalogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('PRICING_ENERGY_MODEL_ENABLED')) {
      return; // flip OFF → manda el fuel viejo (B4); el catálogo de energía puede estar vacío sin riesgo.
    }
    // Flip ON: TODA fuente referenciada por CUALQUIER oferta del catálogo (visible u oculta) DEBE tener
    // precio. Incluye DIESEL (ambulancia/grúa, defaultEnabled:false): si NO se exigiera, encenderlas luego
    // por overlay tumbaría el create autoritativo. Es la MISMA fuente única que valida el replace() del
    // catálogo (energy-requirements.ts) — NO filtrar por defaultEnabled o se reabre el outage de la vertical.
    const requiredSources = requiredEnergySources();
    const missing: EnergySource[] = [];
    for (const source of requiredSources) {
      if ((await this.energyCatalog.getPriceFor(source)) === null) missing.push(source);
    }
    if (missing.length > 0) {
      throw new InvalidStateError(
        'PRICING_ENERGY_MODEL_ENABLED=true pero el catálogo de energía no tiene precio para todas las ' +
          'fuentes que el flip exige (incl. las verticales como el diésel de ambulancia/grúa). Poblá el ' +
          'catálogo (panel de precios de energía) ANTES de flipear — si no, el create cobraría de menos o no levantaría.',
        { missingSources: missing },
      );
    }
    this.logger.log(
      `flip de energía ACTIVO · catálogo poblado para ${requiredSources.size} fuente(s) requerida(s) — OK`,
    );
  }
}
