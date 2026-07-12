import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Preferencias in-app de notificaciones del usuario. ESPEJA el shape del store del passenger
 * (`notificationPrefsStore.ts`): 5 booleans por categoría (Viajes × 3, Promociones × 2). Las
 * categorías de SEGURIDAD (pánico/biométrica) NO viven acá: son no-desactivables por diseño.
 *
 * PUT reemplaza el objeto COMPLETO (idempotente): el cliente envía SIEMPRE los 5 campos, así que
 * todos son obligatorios (nada opcional que deje el server adivinando). El `userId` lo fija el
 * controlador desde la identidad firmada del BFF — nunca del cuerpo (anti-IDOR).
 */
export class NotificationPrefsDto {
  @ApiProperty({ description: 'Viajes · confirmación/cancelación del conductor.' })
  @IsBoolean()
  tripStatus!: boolean;

  @ApiProperty({ description: 'Viajes · llegada y demoras del conductor.' })
  @IsBoolean()
  driverEnRoute!: boolean;

  @ApiProperty({ description: 'Viajes · recordatorios de viajes programados.' })
  @IsBoolean()
  scheduledReminders!: boolean;

  @ApiProperty({ description: 'Promociones · ofertas y cupones (opt-in).' })
  @IsBoolean()
  offers!: boolean;

  @ApiProperty({ description: 'Promociones · novedades de VEO (opt-in).' })
  @IsBoolean()
  news!: boolean;
}

/** Vista devuelta por GET/PUT: el objeto de preferencias efectivo del usuario. */
export class NotificationPrefsView {
  @ApiProperty() tripStatus!: boolean;
  @ApiProperty() driverEnRoute!: boolean;
  @ApiProperty() scheduledReminders!: boolean;
  @ApiProperty() offers!: boolean;
  @ApiProperty() news!: boolean;
}

/**
 * Defaults canónicos server-side (fuente de verdad de la ausencia de fila). ESPEJAN
 * DEFAULT_NOTIFICATION_PREFS del passenger: viaje encendido, promociones opt-in (apagadas).
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsView = {
  tripStatus: true,
  driverEnRoute: true,
  scheduledReminders: true,
  offers: false,
  news: false,
};
