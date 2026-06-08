import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** Cuerpo opcional al pedir el token de publicación (la identidad sale del JWT). */
export class IssuePublisherTokenDto {
  @ApiPropertyOptional({ description: 'Nombre visible del conductor en la room' })
  @IsOptional()
  @IsString()
  name?: string;
}

/** Contrato canónico que consume la app del conductor para publicar su cámara. */
export interface PublisherGrant {
  url: string;
  token: string;
  room: string;
}
