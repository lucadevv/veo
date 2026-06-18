import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalIdentityGuard } from '@veo/auth';
import { InternalStorageService } from './internal-storage.service';
import {
  PresignGetDto,
  PresignPutDto,
  type PresignGetView,
  type PresignPutView,
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
}
