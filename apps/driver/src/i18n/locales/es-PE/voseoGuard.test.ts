import common from './common.json';

/**
 * GUARDIÁN ANTI-VOSEO (es-PE · español de Lima) — espejo del guard del passenger
 * (`apps/passenger/src/i18n/locales/es-PE/voseoGuard.test.ts`), adaptado al i18n del driver
 * (JSON plano en vez de módulo TS).
 *
 * La app le habla a peruanos: español de Lima usa TUTEO (cuéntanos, agrega, elige, prueba, pagas,
 * escaneas, quieres, puedes, tienes), NO voseo rioplatense (contanos, agregá, elegí, probá, pagás,
 * escaneás, querés, podés, tenés, sos, vos).
 *
 * Este test recorre TODOS los strings de `common.json` (recursivo) y FALLA si detecta una forma voseante.
 * Si alguien reintroduce un "Agregá" o un "querés", el build se cae acá antes que el dueño lo vea.
 *
 * Diseño para CERO falsos positivos:
 *  - Los imperativos voseantes son un conjunto CERRADO de raíces verbales conocidas + sufijo `á`/`é`/`í`
 *    (agregá, probá, elegí, ofrecé…). No usamos un `\wá$` genérico porque chocaría con FUTUROS
 *    legítimos de 3ª persona (estará, verás, podrás, deberá) y sustantivos (mamá, más, después).
 *  - El presente voseante irregular es otro conjunto cerrado (querés, podés, tenés, sabés, hacés…).
 *  - Los imperativos voseantes CON CLÍTICO no llevan tilde (comunicate, ponete, sacate, abrilo…):
 *    conjunto cerrado de palabras literales — sus equivalentes tuteo llevan tilde (comunícate, ponte).
 *  - `sos` / `vos` como palabra suelta.
 */

/** Raíces verbales cuyo imperativo voseante (raíz + á) / presente (raíz + ás) NO debe aparecer en es-PE. */
const IMPERATIVE_STEMS = [
  // -ar → imperativo voseo termina en -á / presente en -ás
  'agreg',
  'prob',
  'aprob',
  'confirm',
  'complet',
  'vincul',
  'toc',
  'cerr',
  'busc',
  'llen',
  'lleg',
  'carg',
  'avis',
  'mir',
  'dej',
  'olvid',
  'activ',
  'desactiv',
  'cont',
  'contact',
  'empez',
  'us',
  'revis',
  'intent',
  'reintent',
  'termin',
  'escane',
  'ingres',
  'apret',
  'apunt',
  'pag',
  'cancel',
  'guard',
  'esper',
  'fij',
  'tap',
  'marc',
  'qued',
  'arm',
  'public',
  'gir',
  'regulariz',
  'sald',
  'verific',
  'registr',
  'renov',
  'acept',
  'ofert',
  'contraofert',
  'copi',
  'gener',
  'gan',
];

/** Raíces -er/-ir cuyo imperativo voseo termina en -é o -í. */
const IMPERATIVE_STEMS_E = [
  'ofrec',
  'elig',
  'eleg',
  'volv',
  'corr',
  'correg',
  // 'recib' NO se vigila: el copy del conductor usa "Sí, recibí" (1ª persona del pretérito, tuteo
  // legítimo — "yo recibí") y chocaría. El imperativo voseante "recibí" queda sin cobertura a propósito.
  'escrib',
  'sub',
  'compart',
  'segu',
  'hac',
  'asent',
  'sonre',
  'propon',
  'manten',
];

/** Presente indicativo voseante irregular (2ª persona voseo): raíz + és / ís. */
const PRESENT_VOSEO = [
  'quer',
  'pod',
  'ten',
  'sab',
  'hac',
  'dec',
  'deb',
  'ven',
  'pon',
  'sal',
  've',
];

/**
 * Imperativos voseantes con clítico: sin tilde (voseo) vs con tilde (tuteo: comunícate, ponte, quítate,
 * sáldala, actualízalo, ábrelo, cuéntanos). Palabras literales — ninguna es una palabra tuteo legítima.
 */
const CLITIC_VOSEO_WORDS = [
  'comunicate',
  'ponete',
  'sacate',
  'saldala',
  'actualizalo',
  'abrilo',
  'contanos',
  'contame',
  'fijate',
  'quedate',
  'acordate',
  'registrate',
  'animate',
];

/**
 * Regex global case-insensitive que captura:
 *  - imperativos -ar voseantes:      (agreg|prob|…)á
 *  - presente voseante -ar:          (agreg|prob|…)ás   (pagás, tocás, escaneás…)
 *  - imperativos -er/-ir voseantes:  (ofrec|elig|…)é / í
 *  - presente voseante irregular:    (quer|pod|…)és / ís
 *  - clíticos voseantes sin tilde:   comunicate, ponete, abrilo…
 *  - pronombre/cópula:               sos / vos (palabra suelta)
 *
 * Límites de palabra (\b) + el acento como ÚLTIMO carácter (lookahead a frontera no-alfabética)
 * para no enganchar "está", "verás", "después", etc.
 */
const VOSEO_REGEX = new RegExp(
  [
    // imperativos -ar (raíz + á final de palabra)
    `\\b(?:${IMPERATIVE_STEMS.join('|')})á(?![a-záéíóúñ])`,
    // presente voseante -ar (raíz + ás final de palabra). No choca con futuros legítimos
    // (estarás/verás/llegarás) porque exige el sufijo INMEDIATO tras la raíz vigilada.
    `\\b(?:${IMPERATIVE_STEMS.join('|')})ás(?![a-záéíóúñ])`,
    // imperativos -er/-ir (raíz + é / í final de palabra)
    `\\b(?:${IMPERATIVE_STEMS_E.join('|')})é(?![a-záéíóúñ])`,
    `\\b(?:${IMPERATIVE_STEMS_E.join('|')})í(?![a-záéíóúñ])`,
    // presente voseante irregular (raíz + és / ís final de palabra)
    `\\b(?:${PRESENT_VOSEO.join('|')})(?:és|ís)(?![a-záéíóúñ])`,
    // clíticos voseantes sin tilde (palabra completa)
    `\\b(?:${CLITIC_VOSEO_WORDS.join('|')})(?![a-záéíóúñ])`,
    // cópula / pronombre voseo
    `\\bsos(?![a-záéíóúñ])`,
    `\\bvos(?![a-záéíóúñ])`,
  ].join('|'),
  'i',
);

/** Aplana el JSON a una lista de [ruta, valor] con todos los strings hoja. */
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

describe('Guardián anti-voseo · copy es-PE del conductor (español de Lima, tuteo)', () => {
  const entries = flattenStrings(common);

  it('hay strings que auditar (sanity: el aplanado encontró copy)', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('NINGÚN string de common.json usa voseo rioplatense (agregá, querés, sos, vos…)', () => {
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
      'Publicá un viaje',
      'Aprobás vos a cada pasajero',
      '¿Desde dónde salís?',
      'Ofrecé un poco más',
      '¿Querés continuar?',
      'No podés hacerlo',
      'Ya tenés un viaje',
      'Contanos quién sos',
      'Ingresá el código',
      'Activá el GPS',
      'escaneás el QR',
      'Debés S/12 en comisiones',
      'Saldá tu deuda',
      'Comunicate con soporte',
      'Ponete en turno',
      'Actualizalo para operar',
      'copiá el enlace y abrilo',
      'Girá la cabeza',
      'Asentí con la cabeza',
      'Sonreí a la cámara',
      'Seguí la indicación',
      'Hacé el movimiento',
      'Proponé tu precio',
      'Mantené tus documentos al día',
      'Ganá S/50 extra',
      'Llegás al punto de recojo',
      'Reintentá; si sigue, contactá a soporte',
      'Regularizá tus documentos',
      'Verificá tu rostro',
      'Registrá uno o renová los documentos',
      'Aceptá la tarifa o contraofertá tu precio',
      'Generá uno nuevo',
      'corregí lo observado y volvé a enviar',
      'Buscá buena luz y sacate lentes',
      'Apuntá la cámara e intentá de nuevo',
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
      'Publica un viaje y comparte gastos.',
      'Tú apruebas a cada pasajero',
      '¿Desde dónde sales?',
      'Debes S/12 en comisiones',
      'Sáldala con un medio digital',
      'Escribe a soporte para más detalle.',
      'Ponte en turno para ofertar.',
      'Actualízalo para volver a operar.',
      'Cópialo y ábrelo en la app.',
      'Gira la cabeza hacia la izquierda',
      'Asiente con la cabeza',
      'Sonríe a la cámara',
      'Sigue la indicación en pantalla.',
      'Haz el movimiento con buena luz.',
      'Propón tu precio.',
      'Mantén tus documentos al día.',
      'Gana S/50 extra esta semana',
      'Llegas al punto de recojo',
      'Llegarás en 5 minutos',
      'Quítate lentes o gorra.',
      'Se generó un código nuevo.',
      'La verificación se completó.',
    ])(
      'NO marca como voseo (tuteo / futuro / sustantivo legítimo): "%s"',
      (sample) => {
        expect(sample).not.toMatch(VOSEO_REGEX);
      },
    );
  });
});
