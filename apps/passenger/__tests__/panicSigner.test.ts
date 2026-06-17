import {hmacSha256Hex} from '../src/shared/crypto/hmacSha256';
import {KeychainPanicSigner} from '../src/features/panic/data/keychainPanicSigner';
import {
  buildPanicSignatureMessage,
  PANIC_SIGNATURE_VERSION,
} from '../src/features/panic/domain/panicSignature';
import {
  PanicSecretUnavailableError,
  type PanicSecretStore,
} from '../src/features/panic/domain/panicSecretStore';

describe('buildPanicSignatureMessage', () => {
  it('produce el mensaje canónico con 6 decimales fijos y saltos de línea', () => {
    const message = buildPanicSignatureMessage({
      tripId: 'trip-1',
      dedupKey: 'dedup-1',
      geo: {lat: -12.0464, lon: -77.0428},
    });
    expect(message).toBe(
      [
        PANIC_SIGNATURE_VERSION,
        'trip-1',
        'dedup-1',
        '-12.046400',
        '-77.042800',
      ].join('\n'),
    );
  });
});

class FakeSecretStore implements PanicSecretStore {
  constructor(private secret: string | null) {}
  getSecret = jest.fn(async () => this.secret);
  setSecret = jest.fn(async (s: string) => {
    this.secret = s;
  });
  clearSecret = jest.fn(async () => {
    this.secret = null;
  });
}

describe('KeychainPanicSigner', () => {
  const payload = {
    tripId: 'trip-1',
    dedupKey: 'dedup-1',
    geo: {lat: -12.0464, lon: -77.0428},
  };

  it('firma el mensaje canónico con HMAC-SHA256 usando el secreto del store', async () => {
    const secret = 'super-secreto-del-backend';
    const signer = new KeychainPanicSigner(new FakeSecretStore(secret));

    const signature = await signer.sign(payload);

    const expected = hmacSha256Hex(buildPanicSignatureMessage(payload), secret);
    expect(signature).toBe(expected);
  });

  it('lanza PanicSecretUnavailableError si no hay clave provisionada (hueco de backend)', async () => {
    const signer = new KeychainPanicSigner(new FakeSecretStore(null));
    await expect(signer.sign(payload)).rejects.toBeInstanceOf(
      PanicSecretUnavailableError,
    );
  });
});
