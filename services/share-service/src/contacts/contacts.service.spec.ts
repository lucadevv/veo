import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictError } from '@veo/utils';
import { ContactsService } from './contacts.service';
import { PrismaContactsRepository } from './contacts.repository';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  MAX_TRUSTED_CONTACTS: 3,
  CONTACT_MODIFY_COOLDOWN_HOURS: 24,
});

function makePrisma(count: number) {
  const created = {
    id: 'c-new',
    phone: '+51987654321',
    email: null,
    name: 'María',
    relationship: 'madre',
    otpVerifiedAt: null as Date | null,
    createdAt: new Date(),
  };
  return {
    read: { trustedContact: { count: vi.fn(async () => count) } },
    write: { trustedContact: { create: vi.fn(async () => created) } },
  };
}

function makeRedis(lastModMs: number | null) {
  return {
    get: vi.fn(async () => (lastModMs === null ? null : String(lastModMs))),
    set: vi.fn(async () => 'OK'),
  };
}

const otpStub = { issue: vi.fn(async () => '123456'), verify: vi.fn(async () => undefined) };

describe('ContactsService.add · BR-I06', () => {
  it('agrega un contacto cuando hay cupo y no hay cool-down (emite OTP + SMS)', async () => {
    const prisma = makePrisma(1);
    const redis = makeRedis(null);
    const sms = { send: vi.fn(async () => undefined) };
    const svc = new ContactsService(new PrismaContactsRepository(prisma as never), redis as never, otpStub as never, sms, config);

    const res = await svc.add('u1', {
      phone: '+51987654321',
      name: 'María',
      relationship: 'madre',
    });

    expect(res.otpSent).toBe(true);
    expect(prisma.write.trustedContact.create).toHaveBeenCalledOnce();
    expect(otpStub.issue).toHaveBeenCalledWith('c-new');
    expect(sms.send).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledOnce(); // marca el cool-down
  });

  it('rechaza el 4º contacto (máximo 3)', async () => {
    const prisma = makePrisma(3);
    const redis = makeRedis(null);
    const sms = { send: vi.fn(async () => undefined) };
    const svc = new ContactsService(new PrismaContactsRepository(prisma as never), redis as never, otpStub as never, sms, config);

    await expect(
      svc.add('u1', { phone: '+51987654321', name: 'Otro', relationship: 'amigo' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.write.trustedContact.create).not.toHaveBeenCalled();
  });

  it('rechaza el alta dentro del cool-down de 24h', async () => {
    const prisma = makePrisma(1);
    const redis = makeRedis(Date.now() - 1_000); // modificado hace 1s
    const sms = { send: vi.fn(async () => undefined) };
    const svc = new ContactsService(new PrismaContactsRepository(prisma as never), redis as never, otpStub as never, sms, config);

    await expect(
      svc.add('u1', { phone: '+51987654321', name: 'Otro', relationship: 'amigo' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.write.trustedContact.create).not.toHaveBeenCalled();
  });
});
