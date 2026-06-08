/**
 * PricingService (ADR 011 §6 · M3) — proxy del schedule de modo PUJA↔FIJO hacia trip-service vía
 * REST interno firmado (InternalRestClient). El BFF propaga la identidad `admin` autenticada por JWT
 * (firma HMAC, NUNCA el JWT crudo) → trip-service la verifica con InternalIdentityGuard y, para el PUT,
 * con AdminIdentityGuard (exige type==='admin'). El RBAC fino (pricing:view / pricing:manage) se aplica
 * en el controller con @Roles. La mutación se audita (Ley 29733).
 */
import { Inject, Injectable } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PricingMode } from '@veo/shared-types';
import { REST_TRIP } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { ReplaceScheduleDto } from './dto/pricing.dto';

/** Vista del schedule devuelta por trip-service (proyección vigente o el default). */
export interface ModeScheduleView {
  version: number;
  defaultMode: PricingMode;
  rules: Array<{ dayMask: number; startMinute: number; endMinute: number; mode: PricingMode }>;
  updatedAt: string | null;
}

const BASE = '/internal/pricing/mode-schedule';

@Injectable()
export class PricingService {
  constructor(
    @Inject(REST_TRIP) private readonly rest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** pricing:view — lee el schedule vigente (o el default PUJA si no hay config). */
  getSchedule(identity: AuthenticatedUser): Promise<ModeScheduleView> {
    return this.rest.get<ModeScheduleView>(BASE, { identity });
  }

  /** pricing:manage — reemplaza wholesale el schedule. trip-service bump-ea version y emite el evento. */
  async replaceSchedule(identity: AuthenticatedUser, dto: ReplaceScheduleDto): Promise<ModeScheduleView> {
    const res = await this.rest.put<ModeScheduleView>(BASE, {
      identity,
      body: { defaultMode: dto.defaultMode, rules: dto.rules },
    });
    await this.audit.record(identity, {
      action: 'pricing.mode_schedule_replace',
      resourceType: 'pricing_mode_schedule',
      resourceId: String(res.version),
      payload: { defaultMode: dto.defaultMode, ruleCount: dto.rules.length, version: res.version },
    });
    return res;
  }
}
