import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import {
  Roles,
  CurrentUser,
  InternalIdentityGuard,
  RolesGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole, type PanicEvent as PanicEntity } from '@veo/shared-types';
import { NotFoundError } from '@veo/utils';
import { PanicService } from './panic.service';
import {
  AppendEvidenceDto,
  ListPanicQueryDto,
  ResolvePanicDto,
  TriggerPanicDto,
} from './dto/panic.dto';

/** Tipo mínimo de la respuesta HTTP (evita acoplar @types/express como dependencia directa). */
interface ResponseLike {
  setHeader(name: string, value: string): void;
}

/** Operadores autorizados a gestionar alertas de pánico (RBAC, BR-S07). */
const PANIC_OPERATORS = [
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.SUPPORT_L1,
  AdminRole.SUPPORT_L2,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
] as const;

@ApiTags('panic')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('panic')
export class PanicController {
  constructor(private readonly panic: PanicService) {}

  /**
   * BR-S04 · Dispara el pánico. Idempotente por dedupKey. Responde 202 en <800ms (no hace fan-out).
   * IMPORTANTE: este endpoint NUNCA se throttlea (el rate-limit del BFF excluye /panic).
   */
  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Disparar pánico (BR-S04, idempotente, ack 202 <800ms)' })
  @ApiResponse({ status: 202, description: 'Pánico aceptado y publicado vía outbox' })
  async trigger(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TriggerPanicDto,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<{
    panicId: string;
    status: string;
    deduplicated: boolean;
    triggeredAt: string;
    evidenceS3Keys: string[];
  }> {
    const result = await this.panic.trigger({
      tripId: dto.tripId,
      passengerId: user.userId,
      dedupKey: dto.dedupKey,
      lat: dto.geo.lat,
      lon: dto.geo.lon,
      signature: dto.signature,
    });
    // Exponemos la latencia medida como header de diagnóstico (no PII).
    res.setHeader('x-veo-panic-ack-ms', result.ackMs.toFixed(1));
    return {
      panicId: result.panicId,
      status: result.status,
      deduplicated: result.deduplicated,
      triggeredAt: result.triggeredAt,
      evidenceS3Keys: result.evidenceS3Keys,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un evento de pánico por id' })
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<PanicEntity> {
    const row = await this.panic.getById(id);
    if (!row) throw new NotFoundError('Evento de pánico no encontrado');
    return this.toEntity(row);
  }

  // ── Operadores (RBAC) ──
  @UseGuards(RolesGuard)
  @Roles(...PANIC_OPERATORS)
  @Get()
  @ApiOperation({ summary: 'Listar eventos de pánico (filtrable por estado)' })
  async list(@Query() query: ListPanicQueryDto): Promise<PanicEntity[]> {
    const rows = await this.panic.list(query.status);
    return rows.map((r) => this.toEntity(r));
  }

  @UseGuards(RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPPORT_L1, AdminRole.SUPPORT_L2, AdminRole.ADMIN, AdminRole.SUPERADMIN)
  @Post(':id/ack')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reconocer la alerta (ACKNOWLEDGED + panic.acknowledged)' })
  async ack(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PanicEntity> {
    return this.toEntity(await this.panic.acknowledge(id, user.userId));
  }

  @UseGuards(RolesGuard)
  @Roles(...PANIC_OPERATORS)
  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cerrar la alerta (RESOLVED | FALSE_ALARM)' })
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolvePanicDto,
  ): Promise<PanicEntity> {
    return this.toEntity(await this.panic.resolve(id, dto.resolution, user.userId));
  }

  @UseGuards(RolesGuard)
  @Roles(...PANIC_OPERATORS)
  @Post(':id/evidence')
  @HttpCode(200)
  @ApiOperation({ summary: 'Anexar keys S3 de evidencia (Object Lock/WORM si finalize)' })
  async appendEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AppendEvidenceDto,
  ): Promise<{ evidenceS3Keys: string[]; protectedKeys: string[] }> {
    return this.panic.appendEvidence(id, dto.keys, dto.finalize ?? true);
  }

  private toEntity(row: {
    id: string;
    tripId: string;
    passengerId: string;
    triggeredAt: Date;
    geoLat: number;
    geoLon: number;
    dedupKey: string;
    status: string;
    evidenceS3Keys: string[];
    acknowledgedAt: Date | null;
    ackBy: string | null;
  }): PanicEntity {
    return {
      id: row.id,
      tripId: row.tripId,
      passengerId: row.passengerId,
      triggeredAt: row.triggeredAt,
      geoPoint: { lat: row.geoLat, lon: row.geoLon },
      dedupKey: row.dedupKey,
      status: row.status as PanicEntity['status'],
      evidenceS3Keys: row.evidenceS3Keys,
      acknowledgedAt: row.acknowledgedAt ?? undefined,
      ackBy: row.ackBy ?? undefined,
    };
  }
}
