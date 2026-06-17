import {existsSync, readdirSync, readFileSync, statSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '..', 'src');

/** Recoge recursivamente todos los archivos .ts/.tsx bajo `dir`. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Limpieza de código muerto del Modo Niño: el stub `verifyCode` (que lanzaba NotImplementedError
 * sin llamadores) y su `ChildModeRepository` fueron eliminados. Este test BLINDA la limpieza:
 * garantiza que nadie reintroduce el stub ni lo invoca desde ninguna pantalla.
 */
describe('limpieza · Modo Niño verifyCode (código muerto eliminado)', () => {
  it('eliminó los archivos del repositorio de Modo Niño', () => {
    expect(
      existsSync(
        join(SRC, 'features/childMode/data/httpChildModeRepository.ts'),
      ),
    ).toBe(false);
    expect(
      existsSync(join(SRC, 'features/childMode/domain/childModeRepository.ts')),
    ).toBe(false);
  });

  it('ninguna fuente referencia `verifyCode` ni el token `childModeRepository`', () => {
    const offenders = collectSources(SRC).filter(file => {
      const content = readFileSync(file, 'utf8');
      return (
        content.includes('verifyCode') ||
        content.includes('ChildModeRepository')
      );
    });

    expect(offenders).toEqual([]);
  });
});
