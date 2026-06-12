/**
 * Registro transaccional ÚNICO de usuarios (Lote A2). Antes este bloque (create User + create
 * AuthMethod inicial + outbox user.registered) vivía COPIADO en 4 services (phone-OTP, email,
 * Google, Apple): cambiar el payload del evento exigía acordarse de 4 lugares. Ahora el evento
 * sale de UN solo punto.
 *
 * Corre DENTRO de la tx que recibe (mismo patrón que account-linking.ts): o se persiste
 * User + credencial + evento, o nada (atomicidad outbox, FOUNDATION §6 — OutboxRelay lo drena).
 */
import { createEnvelope, type EventPayload, type EventType } from '@veo/events';
import { type Prisma, type User } from '../generated/prisma';

/** Tipado contra el registro de @veo/events: si el evento se renombra allá, esto no compila. */
const USER_REGISTERED = 'user.registered' satisfies EventType;
const PRODUCER = 'identity-service';

export interface RegisterUserInput {
  /** Datos del User nuevo (phone/email/name/type según el método de auth que registra). */
  user: Pick<Prisma.UserUncheckedCreateInput, 'phone' | 'email' | 'name' | 'type'>;
  /** Credencial inicial que cuelga del User (sin userId: lo asigna esta función). */
  authMethod: Omit<Prisma.AuthMethodUncheckedCreateInput, 'userId'>;
}

/**
 * Crea el User + su AuthMethod inicial + escribe `user.registered` al outbox, todo sobre la
 * MISMA tx del caller. Única fuente del payload del evento.
 */
export async function registerUser(
  tx: Prisma.TransactionClient,
  input: RegisterUserInput,
): Promise<User> {
  const created = await tx.user.create({ data: input.user });
  await tx.authMethod.create({ data: { userId: created.id, ...input.authMethod } });
  const payload: EventPayload<typeof USER_REGISTERED> = {
    userId: created.id,
    phone: created.phone ?? '',
    kycStatus: created.kycStatus,
  };
  const envelope = createEnvelope({ eventType: USER_REGISTERED, producer: PRODUCER, payload });
  await tx.outboxEvent.create({
    data: {
      aggregateId: created.id,
      eventType: envelope.eventType,
      envelope: envelope as unknown as Prisma.InputJsonValue,
    },
  });
  return created;
}
