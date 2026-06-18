import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NotificationChannel, NotificationStatus } from '@veo/shared-types';
import type { InboxCategory } from '../../engine/template.catalog';
import { NotificationPriority } from '../../engine/types';

export class CreateNotificationDto {
  @ApiProperty({ description: 'Id del destinatario (usuario, operador o "central").' })
  @IsString()
  @MinLength(1)
  recipientId!: string;

  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @ApiProperty({
    description: 'Clave de la plantilla i18n a renderizar.',
    example: 'trip.assigned',
  })
  @IsString()
  @MinLength(1)
  template!: string;

  @ApiProperty({
    description: 'Dirección de destino: token push / teléfono E.164 / email / URL de webhook.',
    example: '+51987654321',
  })
  @IsString()
  @MinLength(1)
  to!: string;

  @ApiPropertyOptional({
    description: 'Variables de render y datos del canal. Se fusiona con `to`.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Clave de idempotencia: misma dedupKey no se reenvía.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  dedupKey?: string;

  @ApiPropertyOptional({
    description: 'Máximo de intentos para esta notificación.',
    minimum: 1,
    maximum: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxAttempts?: number;

  @ApiPropertyOptional({
    description:
      'Prioridad de drenado del worker (mayor = más urgente). Critical=100 salta la cola (OTP, ' +
      'pánico), Normal=0 (transaccional, default), Bulk=-100 (broadcast). Default Normal.',
    enum: Object.values(NotificationPriority),
  })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;
}

export class NotificationView {
  @ApiProperty() id!: string;
  @ApiProperty() recipientId!: string;
  @ApiProperty({ enum: NotificationChannel }) channel!: NotificationChannel;
  @ApiProperty() template!: string;
  @ApiProperty({ enum: NotificationStatus }) status!: NotificationStatus;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiPropertyOptional({ nullable: true }) dedupKey!: string | null;
  @ApiPropertyOptional({ nullable: true }) nextAttemptAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) sentAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) deliveredAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) failedReason!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ description: 'true si se devolvió una notificación existente por dedup.' })
  deduped?: boolean;
}

/**
 * Vista de BANDEJA in-app: la notificación PUSH ya RENDERIZADA (título + cuerpo del template i18n)
 * y categorizada. A diferencia de NotificationView (operacional: status/attempts/template-key), esta
 * es la que ve el USUARIO. Sin estado leído/no-leído por ahora (MVP cronológico).
 */
export class InboxNotificationView {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Categoría para ícono/tono en la app.', example: 'trip' })
  category!: InboxCategory;
  @ApiProperty({ description: 'Título renderizado.', example: 'Tu conductor confirmó' })
  title!: string;
  @ApiProperty({ description: 'Cuerpo renderizado.' })
  body!: string;
  @ApiProperty({ description: 'ISO-8601 de emisión.' })
  createdAt!: string;
}
