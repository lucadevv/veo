import { Module } from '@nestjs/common';
import { SmsModule } from '../ports/sms/sms.module';
import { EmailModule } from '../ports/email/email.module';
import { OAuthModule } from '../ports/oauth/oauth.module';
import { VerificationCodeService } from './verification-code.service';
import { OtpService } from './otp.service';
import { EmailCodeService } from './email-code.service';
import { TokenIssuerService } from './token-issuer.service';
import { OAuthLoginService } from './oauth-login.service';
import { OAuthLoginRepository } from './oauth-login.repository';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { EmailAuthService } from './email-auth.service';
import { EmailAuthRepository } from './email-auth.repository';
import { GoogleAuthService } from './google-auth.service';
import { AppleAuthService } from './apple-auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [SmsModule, EmailModule, OAuthModule],
  providers: [
    VerificationCodeService,
    OtpService,
    EmailCodeService,
    TokenIssuerService,
    OAuthLoginService,
    OAuthLoginRepository,
    AuthService,
    AuthRepository,
    EmailAuthService,
    EmailAuthRepository,
    GoogleAuthService,
    AppleAuthService,
  ],
  controllers: [AuthController],
  // OtpService se exporta para que UsersModule (phone-link) REUSE la misma infra OTP del login.
  exports: [AuthService, EmailAuthService, GoogleAuthService, AppleAuthService, OtpService],
})
export class AuthModule {}
