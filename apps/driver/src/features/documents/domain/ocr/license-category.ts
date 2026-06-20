/**
 * Categorías de la licencia de conducir peruana (Reglamento Nacional de Licencias de Conducir). Tipadas
 * como UNIÓN canónica para que la extracción del OCR nunca devuelva un string suelto: si el parser
 * reconoce un texto de categoría, lo MAPEA a uno de estos valores o lo descarta.
 *
 * Cubre CLASE A (autos/profesionales) y CLASE B (motos). VEO ahora acepta MOTOS, cuya licencia es clase
 * B (`B-IIa`/`B-IIb`/`B-IIc`); por eso el catálogo y el lookup ya NO están anclados a la letra `A`.
 *
 * GROUND TRUTH (documento real): la categoría viene PARTIDA en dos rótulos:
 *  - `Clase` → UNA letra: `A` o `B`.
 *  - `Categoría` → la PALABRA ordinal en español (`Uno`/`Dos`/`Tres`), con sub-letra opcional (`Dos B`),
 *    NO el romano pegado. Combinando ambos se arma la canónica (`Clase A` + `Uno` = `A-I`;
 *    `Clase B` + `Dos B` = `B-IIb`).
 */
export const LICENSE_CATEGORIES = [
  'A-I',
  'A-IIa',
  'A-IIb',
  'A-IIIa',
  'A-IIIb',
  'A-IIIc',
  'B-I',
  'B-IIa',
  'B-IIb',
  'B-IIc',
] as const;

export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];

/** Clases de licencia que VEO reconoce (auto = A, moto = B). Catálogo tipado, sin letras mágicas sueltas. */
export const LICENSE_CLASSES = ['A', 'B'] as const;
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/**
 * Mapa de PALABRA ordinal española → número romano canónico. El documento real imprime la categoría como
 * palabra (`Uno`/`Dos`/`Tres`), NO como romano. Tabla tipada (sin strings mágicos en el regex).
 */
const ORDINAL_WORD_TO_ROMAN: Readonly<Record<string, string>> = {
  UNO: 'I',
  DOS: 'II',
  TRES: 'III',
};

/** Sub-letra opcional de la categoría (`a`/`b`/`c`), en minúscula como la imprime el catálogo canónico. */
const SUBLETTERS = ['A', 'B', 'C'] as const;

/** ¿Es un texto una clase válida (`A`/`B`)? Type guard para estrechar al catálogo tipado. */
export function isLicenseClass(value: string): value is LicenseClass {
  return (LICENSE_CLASSES as readonly string[]).includes(value.toUpperCase());
}

/**
 * ¿La línea ENTERA es EXACTAMENTE una clase de licencia (`A`/`B`)? Tolerante a espacios/mayúsculas, pero
 * EXACTA: descarta `Clase A` (rótulo) o `CLASE` (palabra que contiene `A`). Esto es lo que permite el
 * escaneo GLOBAL order-independent del layout en columnas (el OCR agrupa valores `Uno`/`A` lejos de sus
 * rótulos): se busca la línea que sea SOLO la letra de clase, esté donde esté.
 */
export function lineIsLicenseClass(line: string): LicenseClass | null {
  const compact = line.trim().toUpperCase();
  return isLicenseClass(compact) && /^[AB]$/.test(compact) ? (compact as LicenseClass) : null;
}

/**
 * ¿La línea ENTERA es EXACTAMENTE un valor de categoría (palabra ordinal `Uno`/`Dos`/`Tres` con sub-letra
 * opcional, o el romano `I`/`II`/`III` con sub-letra)? Devuelve el cuerpo romano + sufijo o `null`. Como
 * `lineIsLicenseClass`, es para el escaneo GLOBAL: encuentra el ordinal suelto en la columna de valores
 * sin depender de que esté pegado a su rótulo. EXACTA: descarta líneas que solo CONTENGAN el ordinal
 * (p. ej. `Fecha de Revalidación` contiene… nada ordinal, pero un rótulo largo no debe colar).
 */
export function lineIsCategoryOrdinal(line: string): { roman: string; suffix: string } | null {
  const compact = line.trim().toUpperCase().replace(/[-_.]/g, ' ').replace(/\s+/g, ' ');
  // Palabra ordinal exacta: `UNO`, `DOS B`, `TRES C` (sub-letra opcional separada por espacio).
  const wordMatch = /^(UNO|DOS|TRES)(?:\s([ABC]))?$/.exec(compact);
  if (wordMatch?.[1]) {
    const roman = ORDINAL_WORD_TO_ROMAN[wordMatch[1]];
    if (roman) {
      return { roman, suffix: subletterOf(wordMatch[2]) };
    }
  }
  // Romano exacto: `I`, `IIB`, `III C` (sub-letra opcional pegada o separada).
  const romanMatch = /^(III|II|I)\s?([ABC])?$/.exec(compact);
  if (romanMatch?.[1]) {
    return { roman: romanMatch[1], suffix: subletterOf(romanMatch[2]) };
  }
  return null;
}

/**
 * Combina una CLASE (`A`/`B`) con un cuerpo de categoría YA parseado (`{ roman, suffix }`, lo que devuelve
 * `lineIsCategoryOrdinal`) en la canónica del catálogo, o `null` si la combinación no existe. Comparte la
 * validación con `combineClassAndCategory` (catálogo tipado, sin inventar).
 */
export function combineClassAndBody(
  licenseClass: LicenseClass,
  body: { roman: string; suffix: string },
): LicenseCategory | null {
  const candidate = `${licenseClass}-${body.roman}${body.suffix}`;
  return (LICENSE_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as LicenseCategory)
    : null;
}

/**
 * Normaliza un texto de CLASE (`A`/`B`, con ruido) a la clase canónica. Reconoce el rótulo `Clase` con su
 * valor en la misma porción (`Clase: A`) o el valor suelto (`A`). Devuelve `null` si no hay una clase
 * reconocible (no inventa).
 */
export function normalizeLicenseClass(raw: string): LicenseClass | null {
  // Busca la primera A o B aislada (ej. `Clase A`, `A`, `B-`). El `\b` evita capturar la `A` de "PLACA".
  const match = /\b([AB])\b/.exec(raw.toUpperCase());
  return match?.[1] && isLicenseClass(match[1]) ? (match[1] as LicenseClass) : null;
}

/**
 * Cuerpo romano de la categoría (`I`/`II`/`III`) + sub-letra opcional, a partir del valor del rótulo
 * `Categoría`. Acepta DOS formatos del OCR:
 *  - PALABRA ordinal + sub-letra opcional: `Uno`, `Dos B`, `Tres C` (lo que imprime el documento real).
 *  - Romano + sub-letra opcional: `I`, `IIb`, `IIIc` (por si el OCR lo entrega ya en romano).
 * Devuelve `{ roman, suffix }` o `null` si no reconoce una categoría.
 */
function parseCategoryBody(raw: string): { roman: string; suffix: string } | null {
  const compact = raw.toUpperCase().replace(/[-_.]/g, ' ');
  // (1) PALABRA ordinal: `UNO`/`DOS`/`TRES`, opcionalmente seguida de la sub-letra (`DOS B`, `DOSB`).
  const wordMatch = /\b(UNO|DOS|TRES)\b\s*([ABC])?/.exec(compact);
  if (wordMatch?.[1]) {
    const roman = ORDINAL_WORD_TO_ROMAN[wordMatch[1]];
    if (roman) {
      return { roman, suffix: subletterOf(wordMatch[2]) };
    }
  }
  // (2) Romano pegado/separado: `III[ABC]`/`II[AB]`/`I` con sub-letra opcional. Las alternativas MÁS
  // LARGAS van primero para que `III`/`II` ganen sobre el prefijo `I`.
  const romanMatch = /\b(III|II|I)\s*([ABC])?\b/.exec(compact);
  if (romanMatch?.[1]) {
    return { roman: romanMatch[1], suffix: subletterOf(romanMatch[2]) };
  }
  return null;
}

/** Normaliza la sub-letra capturada (`A`/`B`/`C`) a minúscula del catálogo, o `''` si no hay. */
function subletterOf(value: string | undefined): string {
  if (value && (SUBLETTERS as readonly string[]).includes(value.toUpperCase())) {
    return value.toLowerCase();
  }
  return '';
}

/**
 * Combina una CLASE (`A`/`B`) y el valor del rótulo `Categoría` (palabra ordinal o romano) en la categoría
 * canónica del catálogo. Ej.: `combineClassAndCategory('A', 'Uno')` → `A-I`;
 * `combineClassAndCategory('B', 'Dos B')` → `B-IIb`. Devuelve `null` si la combinación no existe en el
 * catálogo (no inventa una categoría inválida).
 */
export function combineClassAndCategory(
  licenseClass: LicenseClass,
  categoryRaw: string,
): LicenseCategory | null {
  const body = parseCategoryBody(categoryRaw);
  if (!body) {
    return null;
  }
  const candidate = `${licenseClass}-${body.roman}${body.suffix}`;
  return (LICENSE_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as LicenseCategory)
    : null;
}

/**
 * Normaliza un texto de categoría YA COMBINADO (clase + romano pegado) a la forma canónica del catálogo.
 * El OCR a veces entrega la categoría junta (`A-IIb`, `A IIB`, `B-IIc`, `a-2b`); esta función la reduce a
 * `letra + romano + sufijo` y la busca en el set canónico. Para el formato PARTIDO (`Clase` + `Categoría`
 * palabra) se usa `combineClassAndCategory`. Si no matchea una categoría conocida, devuelve `null`.
 */
export function normalizeLicenseCategory(raw: string): LicenseCategory | null {
  const compact = raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_.]/g, '');
  // Letra de clase (A/B) seguida del cuerpo romano (I/V) con sub-letra opcional. Convierte los árabes que
  // el OCR a veces produce (2→II, 3→III). El orden importa: alternativas MÁS LARGAS primero. Se admite la
  // sub-letra C en el cuerpo `II` (`B-IIc` existe en clase B; el filtro final por catálogo descarta lo inválido).
  const match = /([AB])(III[ABC]|II[ABC]|3[ABC]|2[ABC]|I{1,3}|3|2|1)/.exec(compact);
  if (!match?.[1] || !match[2] || !isLicenseClass(match[1])) {
    return null;
  }
  const tail = match[2].replace(/^2/, 'II').replace(/^3/, 'III');
  return canonicalizeTail(match[1] as LicenseClass, tail);
}

/** Convierte la clase + el "cuerpo" romano (`I`, `IIB`, `IIIC`) a la forma con sufijo en minúscula. */
function canonicalizeTail(licenseClass: LicenseClass, tail: string): LicenseCategory | null {
  const roman = /^(III|II|I)/.exec(tail);
  if (!roman?.[1]) {
    return null;
  }
  const base = roman[1];
  const suffix = tail.slice(base.length).toLowerCase();
  const candidate = `${licenseClass}-${base}${suffix}`;
  return (LICENSE_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as LicenseCategory)
    : null;
}
