/**
 * AuditController (REST, prefijo global /api/v1).
 *  - POST /audit         registrar una acción síncrona (cualquier servicio interno).
 *  - GET  /audit         consultar entradas (RBAC COMPLIANCE_SUPERVISOR / SUPERADMIN).
 *  - GET  /audit/verify  verificar integridad de la cadena en un rango (RBAC).
 */
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';
import { AuditService } from './audit.service';
import type { RecordedEntry } from './audit.repository';
import {
  AuditEntryResponse,
  ExportAuditDto,
  QueryAuditDto,
  RecordAuditDto,
  VerifyAuditDto,
  VerifyResponse,
} from './dto/audit.dto';

/** Forma mínima del request HTTP que necesitamos (evita depender de @types/express). */
interface HttpRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Post()
  @UseGuards(InternalIdentityGuard)
  @ApiOperation({ summary: 'Registrar una acción auditable (append-only, hash chain).' })
  async record(
    @Body() dto: RecordAuditDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: HttpRequest,
  ): Promise<AuditEntryResponse> {
    // INTEGRIDAD del WORM (Ley 29733): el actor que se persiste es SIEMPRE la identidad VERIFICADA por el
    // InternalIdentityGuard (firma HMAC del caller), NUNCA un `actorId` del body (forjable). El guard exige
    // identidad válida → `user` no puede faltar acá. `actorId` ya NO existe en RecordAuditDto.
    const actorId = user.userId;
    const entry = await this.audit.recordSync({
      actorId,
      action: dto.action,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      payload: dto.payload ?? {},
      ip: clientIp(req),
      userAgent: header(req, 'user-agent'),
      // Id estable provisto por el caller (opcional) → idempotencia del registro síncrono.
      eventId: dto.eventId,
    });
    return toResponse(entry);
  }

  @Get()
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Consultar el audit log (filtros estructurados + paginación por cursor).' })
  async list(@Query() dto: QueryAuditDto): Promise<AuditEntryResponse[]> {
    const entries = await this.audit.query({
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      actorId: dto.actorId,
      action: dto.action,
      category: dto.category,
      q: dto.q,
      from: parseDate(dto.from),
      to: parseDate(dto.to),
      limit: dto.limit ?? 50,
      beforeSeq: parseSeq(dto.beforeSeq),
    });
    return entries.map(toResponse);
  }

  // Export del SET COMPLETO del filtro (server-side, sin paginar). Ruta LITERAL `export` — no colisiona con
  // ninguna paramétrica (el audit no expone `:id`). Mismo gate que el listado (COMPLIANCE_SUPERVISOR/SUPERADMIN):
  // devuelve el set entero (acotado por el tope duro del service); el admin-bff arma el CSV y audita la exportación.
  @Get('export')
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Set completo del filtro para exportar (sin paginar, acotado por tope duro).' })
  async export(@Query() dto: ExportAuditDto): Promise<AuditEntryResponse[]> {
    const entries = await this.audit.exportRows({
      resourceType: dto.resourceType,
      actorId: dto.actorId,
      action: dto.action,
      category: dto.category,
      q: dto.q,
      from: parseDate(dto.from),
      to: parseDate(dto.to),
    });
    return entries.map(toResponse);
  }

  @Get('verify')
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.COMPLIANCE_SUPERVISOR, AdminRole.SUPERADMIN)
  @ApiOperation({ summary: 'Verificar la integridad de la cadena (detección de tampering).' })
  async verify(@Query() dto: VerifyAuditDto): Promise<VerifyResponse> {
    const result = await this.audit.verifyRange({
      fromSeq: parseSeq(dto.fromSeq),
      toSeq: parseSeq(dto.toSeq),
    });
    return {
      valid: result.valid,
      checked: result.checked,
      fromSeq: result.fromSeq,
      toSeq: result.toSeq,
      brokenAtSeq: result.brokenAtSeq,
      reason: result.reason,
    };
  }
}

function toResponse(e: RecordedEntry): AuditEntryResponse {
  return {
    id: e.id,
    seq: String(e.seq),
    eventId: e.eventId,
    actorId: e.actorId,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    ip: e.ip,
    userAgent: e.userAgent,
    occurredAt: e.occurredAt.toISOString(),
    payload: e.payload,
    prevHash: e.prevHash,
    hash: e.hash,
    s3ObjectKey: e.s3ObjectKey,
    createdAt: e.createdAt.toISOString(),
  };
}

function parseSeq(value: string | undefined): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new ValidationError('seq inválido (debe ser entero)', { value });
  }
}

/** Parsea el borde ISO-8601 del rango de fecha (ya validado @IsISO8601 en el DTO). Vacío → sin cota. */
function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('fecha inválida (ISO-8601)', { value });
  }
  return d;
}

/**
 * IP del actor que se escribe en el log INMUTABLE (Ley 29733). DEBE ser la IP real, no forjable.
 * Se resuelve SOLO de `req.ip` (Express la puebla vía `trust proxy`, ver main.ts: camina el XFF
 * descartando los hops privados ALB+ingress-nginx y deja la IP pública real del cliente). NO se lee
 * `x-forwarded-for` crudo: el atacante lo controla por completo y escribiría una IP falsa —
 * HASHEADA — en la cadena append-only, envenenando el rastro de compliance. Fallback al peer TCP.
 */
function clientIp(req: HttpRequest): string {
  return req.ip ?? req.socket.remoteAddress ?? '';
}

function header(req: HttpRequest, name: string): string {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
