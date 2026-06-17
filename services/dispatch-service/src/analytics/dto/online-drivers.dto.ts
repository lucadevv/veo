import { ApiProperty } from '@nestjs/swagger';

/** Respuesta del KPI "conductores en línea" del dashboard admin. */
export class OnlineDriversDto {
  @ApiProperty({
    example: 42,
    description: 'Cantidad de conductores EN LÍNEA ahora (ubicación viva en el hot index: disponibles u ocupados).',
  })
  onlineDrivers!: number;
}
