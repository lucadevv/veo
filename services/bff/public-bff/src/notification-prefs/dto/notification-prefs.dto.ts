import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * PUT /notification-prefs → body (pasajero). Reemplaza el objeto COMPLETO (idempotente): la app envía
 * SIEMPRE los 5 campos. El `userId` lo deriva el notification-service de la identidad firmada (nunca
 * del cuerpo). Espeja el shape del store del passenger (`notificationPrefsStore.ts`).
 */
export class NotificationPrefsDto {
  @ApiProperty() @IsBoolean() tripStatus!: boolean;
  @ApiProperty() @IsBoolean() driverEnRoute!: boolean;
  @ApiProperty() @IsBoolean() scheduledReminders!: boolean;
  @ApiProperty() @IsBoolean() offers!: boolean;
  @ApiProperty() @IsBoolean() news!: boolean;
}
