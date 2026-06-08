import { common } from './common';

/**
 * GUARDIÁN ANTI-VOSEO (es-PE · español de Lima).
 *
 * La app le habla a peruanos: español de Lima usa TUTEO (cuéntanos, agrega, elige, prueba, pagas,
 * escaneas, quieres, puedes, tienes), NO voseo rioplatense (contanos, agregá, elegí, probá, pagás,
 * escaneás, querés, podés, tenés, sos, vos).
 *
 * Este test recorre TODOS los strings de `common` (recursivo) y FALLA si detecta una forma voseante.
 * Si alguien reintroduce un "Agregá" o un "querés", el build se cae acá antes que el dueño lo vea.
 *
 * Diseño para CERO falsos positivos:
 *  - Los imperativos voseantes son un conjunto CERRADO de raíces verbales conocidas + sufijo `á`/`é`
 *    (agregá, probá, elegí, ofrecé…). No usamos un `\wá$` genérico porque chocaría con FUTUROS
 *    legítimos de 3ª persona (estará, verás, podrás, deberá) y sustantivos (mamá, más, después).
 *  - El presente voseante irregular es otro conjunto cerrado (querés, podés, tenés, sabés, hacés…).
 *  - `sos` / `vos` como palabra suelta.
 */

/** Raíces verbales cuyo imperativo voseante (raíz + á/é/í) NO debe aparecer en copy es-PE. */
const IMPERATIVE_STEMS = [
  // -ar → imperativo voseo termina en -á
  'agreg', 'prob', 'confirm', 'complet', 'vincul', 'toc', 'cerr', 'busc',
  'llen', 'carg', 'avis', 'mir', 'dej', 'par', 'olvid', 'activ', 'desactiv',
  'permit', 'cont', 'empez', 'us', 'revis', 'intent', 'termin', 'escane',
  'ingres', 'apret', 'pag', 'cancel', 'guard', 'esper', 'cont', 'fij',
  'tap', 'marc', 'sigu', 'qued', 'arm',
];

/** Raíces -er/-ir cuyo imperativo voseo termina en -é. */
const IMPERATIVE_STEMS_E = [
  'ofrec', 'elig', 'eleg', 'volv', 'corr', 'recib', 'escrib', 'sub', 'compart',
];

/** Presente indicativo voseante irregular (2ª persona voseo): raíz + és / ís. */
const PRESENT_VOSEO = [
  'quer', 'pod', 'ten', 'sab', 'hac', 'dec', 'ven', 'pon', 'sal', 've',
];

/**
 * Construye un regex global, case-insensitive, que captura:
 *  - imperativos -ar voseantes:  (agreg|prob|…)á
 *  - imperativos -er/-ir voseantes: (ofrec|elig|…)é
 *  - imperativo -ir voseante:    (escrib|…)í  → cubierto en stems con sufijo í aparte
 *  - presente voseante:          (quer|pod|…)és / ís
 *  - pronombre/cópula:           sos / vos (palabra suelta)
 *
 * Usamos límites de palabra (\b) y exigimos que el acento sea el ÚLTIMO carácter de la palabra
 * (lookahead a frontera no-alfabética) para no enganchar "está", "verás", "después", etc.
 */
const VOSEO_REGEX = new RegExp(
  [
    // imperativos -ar (raíz + á final de palabra)
    `\\b(?:${IMPERATIVE_STEMS.join('|')})á(?![a-záéíóúñ])`,
    // presente voseante -ar (raíz + ás final de palabra): pagás, tocás, escaneás, desactivás…
    // No choca con futuros legítimos (estarás/verás) porque esos terminan en -rás y ninguna raíz
    // de la lista acaba en "r"; tampoco con "estás" porque "est" no es una raíz vigilada.
    `\\b(?:${IMPERATIVE_STEMS.join('|')})ás(?![a-záéíóúñ])`,
    // imperativos -er/-ir (raíz + é final de palabra)
    `\\b(?:${IMPERATIVE_STEMS_E.join('|')})é(?![a-záéíóúñ])`,
    // imperativos -ir (raíz + í final de palabra)
    `\\b(?:${IMPERATIVE_STEMS_E.join('|')})í(?![a-záéíóúñ])`,
    // presente voseante (raíz + és / ís final de palabra)
    `\\b(?:${PRESENT_VOSEO.join('|')})(?:és|ís)(?![a-záéíóúñ])`,
    // cópula / pronombre voseo
    `\\bsos(?![a-záéíóúñ])`,
    `\\bvos(?![a-záéíóúñ])`,
  ].join('|'),
  'i',
);

/** Aplana `common` a una lista de [ruta, valor] con todos los strings hoja. */
function flattenStrings(
  obj: unknown,
  path: string[] = [],
): Array<[string, string]> {
  if (typeof obj === 'string') {
    return [[path.join('.'), obj]];
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      flattenStrings(v, [...path, k]),
    );
  }
  return [];
}

describe('Guardián anti-voseo · copy es-PE (español de Lima, tuteo)', () => {
  const entries = flattenStrings(common);

  it('hay strings que auditar (sanity: el aplanado encontró copy)', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('NINGÚN string de common usa voseo rioplatense (agregá, querés, sos, vos…)', () => {
    const offenders = entries
      .filter(([, value]) => VOSEO_REGEX.test(value))
      .map(([key, value]) => `${key}: "${value}"`);

    expect(offenders).toEqual([]);
  });

  // Cada clave por separado para que el reporte de jest señale la ofensora exacta.
  it.each(entries)('"%s" está en tuteo peruano (sin voseo)', (key, value) => {
    expect(value).not.toMatch(VOSEO_REGEX);
  });

  /* ── Auto-test del guardián: confirma que SÍ detecta voseo (anti-falso-negativo) ── */
  describe('el regex detecta voseo (no es un guardián dormido)', () => {
    it.each([
      'Agregá tu nombre',
      'Probá de nuevo',
      'Elegí una opción',
      'Confirmá que sos vos',
      'Vinculá tu Yape',
      'Ofrecé un poco más',
      '¿Querés continuar?',
      'No podés hacerlo',
      'Ya tenés un viaje',
      'Contanos quién sos',
      'Ingresá el código',
      'Activá el GPS',
      'escaneás el QR',
    ])('marca como voseo: "%s"', (sample) => {
      expect(sample).toMatch(VOSEO_REGEX);
    });

    it.each([
      'El código expirará en 5 minutos.',
      'Verás la tarifa antes de confirmar.',
      'El servicio está ocupado.',
      'Tu conductor sabrá a quién recoger.',
      'Casa de mamá',
      'Programar para después',
      'Tu crédito se aplicará a tu próximo viaje.',
      'No pudimos completar la operación.',
      'Cuéntanos quién eres',
      'Agrega tu nombre',
      'Elige por precio o llegada.',
      'Confirma que eres tú',
    ])('NO marca como voseo (tuteo / futuro / sustantivo legítimo): "%s"', (sample) => {
      expect(sample).not.toMatch(VOSEO_REGEX);
    });
  });
});
