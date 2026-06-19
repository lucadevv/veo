import { Body, Controller, Delete, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard, RolesGuard, Roles } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { InternalStorageService } from './internal-storage.service';
import {
  PresignGetDto,
  PresignPutDto,
  PurgeDriverDocsDto,
  type PresignGetView,
  type PresignPutView,
  type PurgeDriverDocsView,
} from './dto/internal-storage.dto';

/**
 * Controlador INTERNO (server-to-server, InternalIdentityGuard). Lo consume admin-bff para obtener
 * una URL GET prefirmada de corta vida de una key arbitraria (p. ej. documentos de flota). No es un
 * endpoint de cara al usuario: la autorización de quién puede pedir qué vive en el BFF.
 */
@ApiTags('internal-storage')
@ApiBearerAuth()
@Controller('media/internal')
export class InternalStorageController {
  constructor(private readonly storage: InternalStorageService) {}

  @UseGuards(InternalIdentityGuard)
  @Post('presign-get')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generar URL prefirmada de descarga (presigned GET) de una key arbitraria' })
  presignGet(@Body() dto: PresignGetDto): Promise<PresignGetView> {
    return this.storage.presignGet({
      bucket: dto.bucket,
      key: dto.key,
      ttlSeconds: dto.ttlSeconds,
    });
  }

  @UseGuards(InternalIdentityGuard)
  @Post('presign-put')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generar URL prefirmada de subida (presigned PUT) para un documento de flota',
  })
  presignPut(@Body() dto: PresignPutDto): Promise<PresignPutView> {
    return this.storage.presignPut({
      bucket: dto.bucket,
      key: dto.key,
      contentType: dto.contentType,
      ttlSeconds: dto.ttlSeconds,
    });
  }

  /**
   * HARD purge de los documentos (binarios S3) de un conductor: barre `drivers/<driverId>/`. SUPERADMIN
   * (el guard de trips vive aguas arriba en el admin-bff). El prefijo lo arma el servicio desde el
   * `driverId` de la ruta; el body sólo trae el bucket.
   *
   * GUARDS (orden importa): InternalIdentityGuard PRIMERO verifica la identidad firmada por el admin-bff
   * y puebla `req.user` (con sus roles); RolesGuard DESPUÉS valida SUPERADMIN sobre ese usuario. Sin el
   * InternalIdentityGuard, `req.user` quedaría vacío y RolesGuard rechazaría con 403 "Rol insuficiente"
   * (espeja el patrón de fleet/identity, que montan InternalIdentityGuard a nivel de clase).
   */
  @UseGuards(InternalIdentityGuard, RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  @Delete('drivers/:driverId/documents')
  @HttpCode(200)
  @ApiOperation({ summary: 'HARD purge de los binarios de documentos del conductor (drivers/<id>/). SUPERADMIN.' })
  purgeDriverDocs(
    @Param('driverId') driverId: string,
    @Body() dto: PurgeDriverDocsDto,
  ): Promise<PurgeDriverDocsView> {
    return this.storage.purgeDriverDocs({ bucket: dto.bucket, driverId });
  }
}
