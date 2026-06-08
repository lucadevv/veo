import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

/** POST /internal/devices → body. El userId llega por la identidad interna firmada. */
export class RegisterDeviceDto {
  @ApiProperty({ description: 'Token del dispositivo (FCM registration token o APNs device token)' })
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ enum: ['ios', 'android'], description: 'Plataforma del dispositivo' })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';
}
