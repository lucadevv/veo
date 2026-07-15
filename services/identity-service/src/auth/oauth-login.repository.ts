/**
 * OAuthLoginRepository — ÚNICO punto de acceso Prisma del login OAuth compartido (Google/Apple, schema
 * 'identity'). Espeja el mold de payment/rating: read/write split y métodos con NOMBRES DE DOMINIO — nunca
 * filtra `PrismaClient` crudo al service.
 *
 * SEAM con OAuthLoginService: la LÓGICA DE DOMINIO (resolución de identidad por `sub` → linking por correo
 * verificado → alta nueva, y la decisión de seguridad email_verified) vive ENTERA en el service. Este repo
 * solo hace acceso a datos; los helpers transaccionales (`resolveUserForVerifiedEmail`/`registerUser`) reciben
 * el `tx` OPACO forwardeado por el service — no lo dereferencia.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type AuthMethodType, type User } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type OAuthLoginTx = Prisma.TransactionClient;

/** AuthMethod OAuth con su User embebido (re-login idempotente por `sub`). */
export type OAuthMethodWithUser = Prisma.AuthMethodGetPayload<{ include: { user: true } }>;

@Injectable()
export class OAuthLoginRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Dueño del `$transaction` (write). El service ORQUESTA la resolución de identidad de 3 pasos. */
  runInTransaction<T>(work: (tx: OAuthLoginTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** El vínculo OAuth (por `type` + `sub`) + su User, DENTRO de la tx (re-login idempotente). */
  findOAuthMethodWithUserTx(
    tx: OAuthLoginTx,
    methodType: Extract<AuthMethodType, 'GOOGLE_OAUTH' | 'APPLE_OAUTH'>,
    sub: string,
  ): Promise<OAuthMethodWithUser | null> {
    return tx.authMethod.findUnique({
      where: { type_oauthSubject: { type: methodType, oauthSubject: sub } },
      include: { user: true },
    });
  }

  /** Cuelga la credencial OAuth de un User existente (account-linking), DENTRO de la tx. */
  async createOAuthMethodTx(
    tx: OAuthLoginTx,
    data: Prisma.AuthMethodUncheckedCreateInput,
  ): Promise<void> {
    await tx.authMethod.create({ data });
  }

  /** Usuario por id, DENTRO de la tx (resolución del User vinculado). */
  findUserByIdTx(tx: OAuthLoginTx, id: string): Promise<User | null> {
    return tx.user.findUnique({ where: { id } });
  }
}
