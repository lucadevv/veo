/**
 * VehicleModelsController — catálogo de modelos de vehículo (B5-2).
 * Auth base: InternalIdentityGuard (identidad propagada por el BFF). La LECTURA del catálogo aprobado la
 * consume cualquier usuario autenticado (selector del onboarding + panel admin). El conductor SOLICITA
 * modelos nuevos (B5-2.c); el OPERADOR los revisa/aprueba/rechaza (role-gated).
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  InternalIdentityGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { ForbiddenError } from '@veo/utils';
import { VehicleModelsService } from './vehicle-models.service';
import {
  ApproveVehicleModelDto,
  ListReviewQuery,
  ListVehicleModelsQuery,
  RequestVehicleModelDto,
  type VehicleModelReviewView,
  type VehicleModelSpecView,
} from './dto/vehicle-model.dto';
import type { Page } from '../infra/pagination';

/** Roles del operador habilitados para revisar/curar el catálogo (espeja el review de documentos). */
const CATALOG_REVIEWERS = [
  AdminRole.COMPLIANCE_SUPERVISOR,
  AdminRole.ADMIN,
  AdminRole.SUPERADMIN,
] as const;

@ApiTags('vehicle-models')
@ApiBearerAuth()
@UseGuards(InternalIdentityGuard)
@Controller('vehicle-models')
export class VehicleModelsController {
  constructor(private readonly models: VehicleModelsService) {}

  @Get()
  @ApiOperation({
    summary: 'Catálogo APROBADO de modelos (selector de onboarding). Filtros: vehicleType, q',
  })
  list(@Query() query: ListVehicleModelsQuery): Promise<Page<VehicleModelSpecView>> {
    return this.models.listApproved({
      vehicleType: query.vehicleType,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @ApiOperation({ summary: 'El conductor SOLICITA un modelo nuevo (queda PENDING_REVIEW). B5-2.c' })
  requestModel(
    @Body() dto: RequestVehicleModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VehicleModelReviewView> {
    return this.models.requestModel(this.driverId(user), dto);
  }

  // ── Revisión del operador (role-gated). Declaradas ANTES de `:id` para que `review` no matchee como id. ──

  @UseGuards(RolesGuard)
  @Roles(...CATALOG_REVIEWERS)
  @Get('review')
  @ApiOperation({ summary: 'Cola de revisión de modelos (default PENDING_REVIEW). Solo operador' })
  review(@Query() query: ListReviewQuery): Promise<Page<VehicleModelReviewView>> {
    return this.models.listForReview({
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @UseGuards(RolesGuard)
  @Roles(...CATALOG_REVIEWERS)
  @Put(':id/approve')
  @ApiOperation({
    summary: 'Aprobar una solicitud completando la ficha técnica (PENDING→APPROVED). Solo operador',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveVehicleModelDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VehicleModelReviewView> {
    return this.models.approve(id, user.userId, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(...CATALOG_REVIEWERS)
  @Put(':id/reject')
  @ApiOperation({ summary: 'Rechazar una solicitud (PENDING→REJECTED). Solo operador' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VehicleModelReviewView> {
    return this.models.reject(id, user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un modelo APROBADO del catálogo por id' })
  getById(@Param('id', ParseUUIDPipe) id: string): Promise<VehicleModelSpecView> {
    return this.models.getById(id);
  }

  /** Exige que la identidad sea un conductor antes de crear una solicitud a su nombre; devuelve su User.id. */
  private driverId(user: AuthenticatedUser): string {
    if (user.type !== 'driver') {
      throw new ForbiddenError('Solo un conductor puede solicitar un modelo nuevo', {
        type: user.type,
      });
    }
    return user.userId;
  }
}
