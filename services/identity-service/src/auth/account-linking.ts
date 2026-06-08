/**
 * Account-linking compartido (ADR-012 §2). Resuelve el User dueño de un correo YA verificado por
 * CUALQUIER método de auth, para colgar una credencial nueva del MISMO User en vez de duplicarlo.
 *
 * Se extrajo de EmailAuthService (Lote 2) para que GoogleAuthService (Lote 3) lo reúse sin duplicar
 * la lógica. Corre DENTRO de la tx que recibe (consistencia con la mutación que lo invoca).
 */
import type { Prisma } from '../generated/prisma';

/**
 * Devuelve el `userId` al que pertenece `email` si ese correo ya está verificado por algún método
 * (ej. EMAIL_PASSWORD verificado, o un GOOGLE_OAUTH con emailVerified=true), o null si no hay vínculo.
 */
export async function resolveUserForVerifiedEmail(
  tx: Prisma.TransactionClient,
  email: string,
): Promise<string | null> {
  const verified = await tx.authMethod.findFirst({
    where: { email, emailVerified: true },
  });
  return verified?.userId ?? null;
}
