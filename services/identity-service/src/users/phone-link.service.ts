/**
 * PhoneLinkService — vincula un teléfono al perfil del usuario autenticado (ADR-012, phone-link).
 *
 * PROBLEMA: usuarios que entran por correo/Google/Apple quedan SIN teléfono (User.phone null) →
 * SMS de seguridad y contactos de confianza rotos. Este flujo deja que un usuario YA autenticado
 * verifique y enganche un teléfono a SU identidad, REUSANDO la infra OTP existente (OtpService →
 * VerificationCodeService): MISMO TTL, MISMO cooldown de reenvío, MISMOS intentos/lockout que el
 * login por OTP, MISMO canal SMS (sandbox loguea el código en identity.log).
 *
 * Decisiones (boot-real + auditoría):
 * - "PassengerProfile": en este schema el perfil del pasajero ES el `User` (no hay tabla separada);
 *   se devuelve `ProfileView` (idéntico a GET /users/me) reutilizando UsersService.getProfile.
 * - PHONE_TAKEN: si el número pertenece a OTRO usuario → 409 con code `PHONE_TAKEN`. Se chequea en
 *   request Y en verify, con shape uniforme (anti-enumeración: nunca revela de quién es el número).
 *   Si el número ya es del PROPIO usuario, el flujo es idempotente (no es conflicto).
 * - REEMPLAZO: si el usuario ya tenía OTRO teléfono, al verificar se REEMPLAZA `User.phone`. El
 *   AuthMethod{PHONE_OTP} cuelga de la identidad (no almacena el número; el número vive en User.phone),
 *   así que se hace upsert idempotente del método. El teléfono viejo queda libre (sin método ni dueño).
 */
import { Injectable, Logger } from '@nestjs/common';
import { parseOrThrow, peruPhoneSchema } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { OtpService } from '../auth/otp.service';
import { UsersService, type ProfileView } from './users.service';
import { PhoneTakenError, maskPhone } from './phone-link.errors';

@Injectable()
export class PhoneLinkService {
  private readonly logger = new Logger(PhoneLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly users: UsersService,
  ) {}

  /**
   * Solicita un OTP para vincular `rawPhone` al usuario `userId`. Valida formato, rechaza con
   * PHONE_TAKEN si el número es de otro usuario, y emite el OTP por el canal existente (sandbox:
   * se loguea en identity.log). El rate-limit/cooldown lo aplica OtpService (RateLimitError → 429),
   * idéntico al OTP de login.
   */
  async request(userId: string, rawPhone: string): Promise<{ sent: true }> {
    const phone = parseOrThrow(peruPhoneSchema, rawPhone, 'phone');
    await this.assertNotTakenByOther(userId, phone);

    const code = await this.otp.issue(phone);
    // Canal SMS existente (sandbox loguea el código). Reusa exactamente el copy del login OTP.
    this.logger.warn(`[SANDBOX SMS] → ${phone}: Tu código VEO es ${code}. Válido 5 minutos. No lo compartas.`);
    return { sent: true };
  }

  /**
   * Verifica el OTP y vincula el teléfono al perfil. Mismos intentos/lockout que el login OTP
   * (OtpService.verify → ConflictError al tope). Re-chequea PHONE_TAKEN dentro de la tx (anti-carrera).
   * Setea User.phone (reemplazando el anterior si lo había) y upserta AuthMethod{PHONE_OTP}.
   * Devuelve el perfil actualizado (ProfileView).
   */
  async verify(userId: string, rawPhone: string, code: string): Promise<ProfileView> {
    const phone = parseOrThrow(peruPhoneSchema, rawPhone, 'phone');
    await this.assertNotTakenByOther(userId, phone);

    // Mismo mecanismo que el OTP de login: consume el código si acierta; cuenta intentos y bloquea al tope.
    await this.otp.verify(phone, code);

    await this.prisma.write.$transaction(async (tx) => {
      // Re-chequeo anti-carrera: que nadie haya tomado el número entre request y verify.
      const owner = await tx.user.findUnique({ where: { phone } });
      if (owner && owner.id !== userId) throw new PhoneTakenError();

      await tx.user.update({ where: { id: userId }, data: { phone } });
      // AuthMethod{PHONE_OTP} idempotente: si el usuario ya lo tenía (de otro número), se conserva
      // la fila (el número no vive aquí); si no, se crea. El método queda `verified`.
      await tx.authMethod.upsert({
        where: { userId_type: { userId, type: 'PHONE_OTP' } },
        create: { userId, type: 'PHONE_OTP', verified: true },
        update: { verified: true },
      });
    });

    // AUDIT (Ley 29733): teléfono enmascarado, nunca el número completo.
    this.logger.log(`audit profile.phone_linked userId=${userId} phone=${maskPhone(phone)}`);

    return this.users.getProfile(userId);
  }

  /**
   * Lanza PHONE_TAKEN si `phone` pertenece a un usuario distinto de `userId`. Si es del propio
   * usuario o de nadie, no hace nada (el flujo es idempotente / disponible).
   */
  private async assertNotTakenByOther(userId: string, phone: string): Promise<void> {
    const owner = await this.prisma.read.user.findUnique({ where: { phone } });
    if (owner && owner.id !== userId) throw new PhoneTakenError();
  }
}
