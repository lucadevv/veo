import {
  emailForgotResult,
  emailLogin,
  emailRegister,
  emailReset,
  emailResetResult,
  emailVerify,
  mobileAuthTokens,
} from '@veo/api-client';

/**
 * Contrato de auth por correo (ADR-012). El schema es la fuente de verdad: el cliente debe
 * enviar/parsear EXACTAMENTE estas formas contra el public-bff.
 */
describe('Contrato auth por correo (@veo/api-client)', () => {
  it('emailRegister exige password ≥ 12 y type válido; name es opcional', () => {
    expect(
      emailRegister.safeParse({
        email: 'ana@veo.pe',
        password: 'x'.repeat(12),
        type: 'PASSENGER',
      }).success,
    ).toBe(true);
    expect(
      emailRegister.safeParse({
        email: 'ana@veo.pe',
        password: 'corta',
        type: 'PASSENGER',
      }).success,
    ).toBe(false);
    expect(
      emailRegister.safeParse({
        email: 'no-es-correo',
        password: 'x'.repeat(12),
        type: 'PASSENGER',
      }).success,
    ).toBe(false);
  });

  it('emailVerify y emailReset exigen código de 6 caracteres', () => {
    expect(
      emailVerify.safeParse({email: 'ana@veo.pe', code: '123456'}).success,
    ).toBe(true);
    expect(
      emailVerify.safeParse({email: 'ana@veo.pe', code: '123'}).success,
    ).toBe(false);
    expect(
      emailReset.safeParse({
        email: 'ana@veo.pe',
        code: '123456',
        newPassword: 'x'.repeat(12),
      }).success,
    ).toBe(true);
    expect(
      emailReset.safeParse({
        email: 'ana@veo.pe',
        code: '123456',
        newPassword: 'corta',
      }).success,
    ).toBe(false);
  });

  it('emailLogin exige correo válido y password no vacío', () => {
    expect(
      emailLogin.safeParse({email: 'ana@veo.pe', password: 'algo'}).success,
    ).toBe(true);
    expect(
      emailLogin.safeParse({email: 'ana@veo.pe', password: ''}).success,
    ).toBe(false);
  });

  it('los results de éxito son literales estrictos ({sent:true}/{ok:true})', () => {
    expect(emailForgotResult.safeParse({sent: true}).success).toBe(true);
    expect(emailForgotResult.safeParse({sent: false}).success).toBe(false);
    expect(emailResetResult.safeParse({ok: true}).success).toBe(true);
  });

  it('mobileAuthTokens acepta usuario de correo (phone null + email) — alta sin teléfono', () => {
    const parsed = mobileAuthTokens.safeParse({
      accessToken: 'a',
      refreshToken: 'r',
      user: {
        id: 'u-1',
        phone: null,
        type: 'passenger',
        kycStatus: 'PENDING',
        email: 'ana@veo.pe',
      },
    });
    expect(parsed.success).toBe(true);
  });
});
