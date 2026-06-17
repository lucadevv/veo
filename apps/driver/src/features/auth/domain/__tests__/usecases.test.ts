import type { AuthRepository, AuthTokens, OtpRequestOutcome } from '../index';
import {
  InvalidOtpCodeError,
  InvalidPhoneError,
  RequestOtpUseCase,
  VerifyOtpUseCase,
} from '../index';

/** Doble de prueba del repositorio de auth (no es un mock de producción). */
class FakeAuthRepository implements AuthRepository {
  requestCalls: Array<{ phone: string; type: string }> = [];
  verifyCalls: Array<{ phone: string; code: string; type: string }> = [];

  requestOtp(input: { phone: string; type: 'PASSENGER' | 'DRIVER' }): Promise<OtpRequestOutcome> {
    this.requestCalls.push(input);
    return Promise.resolve({ sent: true });
  }
  verifyOtp(input: {
    phone: string;
    code: string;
    type: 'PASSENGER' | 'DRIVER';
  }): Promise<AuthTokens> {
    this.verifyCalls.push(input);
    return Promise.resolve({ accessToken: 'a', refreshToken: 'r' });
  }
  refresh(): Promise<AuthTokens> {
    return Promise.resolve({ accessToken: 'a', refreshToken: 'r' });
  }
  logout(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }
}

describe('RequestOtpUseCase', () => {
  it('rechaza teléfonos inválidos sin tocar el repositorio', async () => {
    const repo = new FakeAuthRepository();
    await expect(() => new RequestOtpUseCase(repo).execute('123')).toThrow(InvalidPhoneError);
    expect(repo.requestCalls).toHaveLength(0);
  });

  it('normaliza el teléfono y fuerza type DRIVER', async () => {
    const repo = new FakeAuthRepository();
    await new RequestOtpUseCase(repo).execute('987654321');
    expect(repo.requestCalls[0]).toEqual({ phone: '+51987654321', type: 'DRIVER' });
  });
});

describe('VerifyOtpUseCase', () => {
  it('rechaza códigos que no son de 6 dígitos', async () => {
    const repo = new FakeAuthRepository();
    await expect(() => new VerifyOtpUseCase(repo).execute('987654321', '123')).toThrow(
      InvalidOtpCodeError,
    );
    expect(repo.verifyCalls).toHaveLength(0);
  });

  it('envía teléfono normalizado + código + type DRIVER', async () => {
    const repo = new FakeAuthRepository();
    const tokens = await new VerifyOtpUseCase(repo).execute('987654321', '123456');
    expect(repo.verifyCalls[0]).toEqual({ phone: '+51987654321', code: '123456', type: 'DRIVER' });
    expect(tokens).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });
});
