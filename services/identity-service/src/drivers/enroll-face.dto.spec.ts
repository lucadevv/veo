import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EnrollFaceDto } from './drivers.controller';

/**
 * Endurecimiento del payload del enroll biométrico KYC selfie-only (Lote 1, sin liveness): `photo` un base64
 * VÁLIDO y NO trivial (mín 2000 / máx 1.5M chars). Sin esto cualquier string entraba al puerto (en sandbox un
 * hash de cualquier cosa genera un embedding que pasaría el gate). La detección de 1 rostro la resuelve
 * biometric-service `/v1/embed`; acá validamos el borde.
 */
async function errorsFor(input: unknown): Promise<string[]> {
  const dto = plainToInstance(EnrollFaceDto, input);
  const errors = await validate(dto);
  const collect = (es: Awaited<ReturnType<typeof validate>>): string[] =>
    es.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}),
      ...collect(e.children ?? []),
    ]);
  return collect(errors);
}

// base64 válido de 2400 chars (>2000): decodifica a "ABC" repetido. Una selfie real es órdenes mayor.
const VALID_PHOTO = 'QUJD'.repeat(600);

describe('EnrollFaceDto · validación de la selfie (photo, selfie-only)', () => {
  it('acepta el happy path (1 foto base64 no trivial)', async () => {
    const keys = await errorsFor({ photo: VALID_PHOTO });
    expect(keys).toHaveLength(0);
  });

  it('rechaza photo vacío', async () => {
    const keys = await errorsFor({ photo: '' });
    expect(keys).toContain('isNotEmpty');
  });

  it('rechaza una foto base64 válida pero demasiado corta (debajo del mínimo)', async () => {
    const keys = await errorsFor({ photo: 'QUJD' }); // base64 válido, 4 chars
    expect(keys).toContain('minLength');
  });

  it('rechaza una foto no-base64 aunque sea larga', async () => {
    const keys = await errorsFor({ photo: '@'.repeat(3000) });
    expect(keys).toContain('isBase64');
  });

  it('rechaza una foto que excede el máximo (>1.5M chars)', async () => {
    const keys = await errorsFor({ photo: 'QUJD'.repeat(400_000) }); // 1.6M chars
    expect(keys).toContain('maxLength');
  });
});
