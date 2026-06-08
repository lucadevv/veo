import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityAuthClient } from './identity-auth.client';

@Module({
  controllers: [AuthController],
  providers: [AuthService, IdentityAuthClient],
  exports: [AuthService],
})
export class AuthModule {}
