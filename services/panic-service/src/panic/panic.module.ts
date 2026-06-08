import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3EvidenceModule } from '../ports/s3-evidence/s3-evidence.module';
import { PanicService } from './panic.service';
import { PanicController } from './panic.controller';
import { PANIC_HMAC_SECRET } from './panic.hmac';
import type { Env } from '../config/env.schema';

const hmacSecretProvider: Provider = {
  provide: PANIC_HMAC_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => config.getOrThrow<string>('PANIC_HMAC_SECRET'),
};

@Module({
  imports: [S3EvidenceModule],
  providers: [PanicService, hmacSecretProvider],
  controllers: [PanicController],
  exports: [PanicService],
})
export class PanicModule {}
