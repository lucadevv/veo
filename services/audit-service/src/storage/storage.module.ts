/**
 * StorageModule — provee el almacén WORM (S3 Object Lock) vía DI.
 * Si AUDIT_S3_ENABLED=false el token resuelve a `null` (la réplica queda desactivada,
 * útil solo para tests aislados de la cadena en DB).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ObjectLockStore, type ImmutableObjectStore } from './object-lock.store';
import type { Env } from '../config/env.schema';

export const AUDIT_OBJECT_STORE = Symbol('AUDIT_OBJECT_STORE');

const storeProvider: Provider = {
  provide: AUDIT_OBJECT_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): ImmutableObjectStore | null => {
    if (!config.getOrThrow<boolean>('AUDIT_S3_ENABLED')) return null;
    return new S3ObjectLockStore({
      endpoint: config.getOrThrow<string>('AUDIT_S3_ENDPOINT'),
      region: config.getOrThrow<string>('AUDIT_S3_REGION'),
      bucket: config.getOrThrow<string>('AUDIT_S3_BUCKET'),
      accessKey: config.getOrThrow<string>('AUDIT_S3_ACCESS_KEY'),
      secretKey: config.getOrThrow<string>('AUDIT_S3_SECRET_KEY'),
      forcePathStyle: config.getOrThrow<boolean>('AUDIT_S3_FORCE_PATH_STYLE'),
      retentionDays: config.getOrThrow<number>('AUDIT_S3_RETENTION_DAYS'),
    });
  },
};

@Global()
@Module({
  providers: [storeProvider],
  exports: [AUDIT_OBJECT_STORE],
})
export class StorageModule {}
