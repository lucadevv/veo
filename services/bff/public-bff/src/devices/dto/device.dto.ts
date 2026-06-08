import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

/** POST /devices → body (pasajero). El userId se toma del JWT, nunca del cuerpo. */
export class RegisterDeviceDto {
  @ApiProperty({ description: 'Token del dispositivo (FCM/APNs)' })
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ enum: ['ios', 'android'], description: 'Plataforma del dispositivo' })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}
