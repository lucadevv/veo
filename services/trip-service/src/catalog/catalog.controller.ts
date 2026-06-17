/**
 * Endpoints internos del overlay del catálogo (ADR 013 §1.2). Bajo `api/v1` → `/api/v1/internal/catalog`.
 * Protegidos por InternalIdentityGuard (firma HMAC del BFF, FOUNDATION §10):
 *  - GET   → catálogo efectivo (ofertas + enabled + version). Lectura: cualquier identidad interna firmada
 *            (public-bff lo consume para el quote/teaser; admin-bff para el panel).
 *  - PUT   → reemplazo wholesale del overlay + emite catalog.updated. MUTACIÓN: AdminIdentityGuard exige
 *            identidad `admin` (defensa en profundidad; el RBAC fino se aplica además en admin-bff).
 */
import { Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { CatalogService } from './catalog.service';
import { AdminIdentityGuard } from '../pricing/admin-identity.guard';
import { ReplaceCatalogDto } from './dto/catalog.dto';

@ApiTags('catalog')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('internal/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Catálogo efectivo (ofertas + enabled + version). ADR 013 §1.2' })
  getCatalog() {
    return this.catalog.getCatalog();
  }

  @Put()
  @HttpCode(200)
  @UseGuards(AdminIdentityGuard)
  @ApiOperation({
    summary:
      'REEMPLAZA wholesale el overlay del catálogo (bump version) y emite catalog.updated. ' +
      'Solo identidad admin (ADR 013).',
  })
  replaceCatalog(@Body() dto: ReplaceCatalogDto) {
    return this.catalog.replaceOverlay(dto.overrides, dto.expectedVersion);
  }
}
