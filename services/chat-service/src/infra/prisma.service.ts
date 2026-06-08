/**
 * PrismaService — envuelve el cliente Prisma generado con ReadWriteClient (read/write split).
 */
import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReadWriteClient, type PrismaClientCtor } from '@veo/database';
import { PrismaClient } from '../generated/prisma';
import type { Env } from '../config/env.schema';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly rw: ReadWriteClient<PrismaClient>;

  constructor(config: ConfigService<Env, true>) {
    const Ctor = PrismaClient as unknown as PrismaClientCtor<PrismaClient>;
    this.rw = new ReadWriteClient(Ctor, {
      writeUrl: config.getOrThrow<string>('DATABASE_URL'),
      readUrl: config.get<string>('DATABASE_URL_REPLICA'),
    });
  }

  get write(): PrismaClient {
    return this.rw.write;
  }
  get read(): PrismaClient {
    return this.rw.read;
  }

  async onModuleInit(): Promise<void> {
    await this.rw.connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.rw.disconnect();
  }
}
