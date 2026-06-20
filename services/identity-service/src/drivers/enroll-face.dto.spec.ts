import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EnrollFaceDto } from './drivers.controller';

/**
 * Endurecimiento del payload del enroll biométrico CON LIVENESS: `challengeId` no vacío y `frames` un array
 * (1..30) de base64 VÁLIDOS y NO triviales. Sin esto cualquier string entraba al puerto (en sandbox un hash
 * de cualquier cosa genera un embedding que pasaría el gate). El liveness REAL lo resuelve biometric-service;
 * acá validamos el borde.
 */
async function errorsFor(input: unknown): Promise<string[]> {
  const dto = plainToInstance(EnrollFaceDto, input);
  const errors = await validate(dto);
  // Recoge constraints del nivel raíz y de los items del array (frames each:true).
  const collect = (es: Awaited<ReturnType<typeof validate>>): string[] =>
    es.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}),
      ...collect(e.children ?? []),
    ]);
  return collect(errors);
}

// base64 válido de 2400 chars (>2000): decodifica a "ABC" repetido. Un frame real es órdenes mayor.
const VALID_FRAME = 'QUJD'.repeat(600);

describe('EnrollFaceDto · validación de challengeId + frames con liveness', () => {
  it('acepta el happy path (challengeId + 1 frame base64 no trivial)', async () => {
    const keys = await errorsFor({ challengeId: 'c1', frames: [VALID_FRAME] });
    expect(keys).toHaveLength(0);
  });

  it('rechaza challengeId vacío', async () => {
    const keys = await errorsFor({ challengeId: '', frames: [VALID_FRAME] });
    expect(keys).toContain('isNotEmpty');
  });

  it('rechaza frames vacío (array sin elementos)', async () => {
    const keys = await errorsFor({ challengeId: 'c1', frames: [] });
    expect(keys).toContain('arrayNotEmpty');
  });

  it('rechaza más de 30 frames', async () => {
    const keys = await errorsFor({ challengeId: 'c1', frames: Array(31).fill(VALID_FRAME) });
    expect(keys).toContain('arrayMaxSize');
  });

  it('rechaza un frame base64 válido pero demasiado corto (debajo del mínimo)', async () => {
    const keys = await errorsFor({ challengeId: 'c1', frames: ['QUJD'] }); // base64 válido, 4 chars
    expect(keys).toContain('minLength');
  });

  it('rechaza un frame no-base64 aunque sea largo', async () => {
    const keys = await errorsFor({ challengeId: 'c1', frames: ['@'.repeat(3000)] });
    expect(keys).toContain('isBase64');
  });
});
