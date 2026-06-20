/**
 * Categorías de la licencia de conducir peruana (Reglamento Nacional de Licencias de Conducir, clase
 * A). Tipadas como UNIÓN canónica para que la extracción del OCR nunca devuelva un string suelto: si el
 * parser reconoce un texto de categoría, lo MAPEA a uno de estos valores o lo descarta. Las clases B
 * (motos) no se manejan en el alta del conductor de auto, por eso no están.
 */
export const LICENSE_CATEGORIES = [
  'A-I',
  'A-IIa',
  'A-IIb',
  'A-IIIa',
  'A-IIIb',
  'A-IIIc',
] as const;

export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];

/**
 * Normaliza un texto de categoría reconocido por el OCR a la forma canónica del catálogo. El OCR
 * escribe la categoría de formas variadas: `A-IIb`, `A IIb`, `AIIB`, `a-2b`, con o sin guion, con los
 * romanos en mayúscula/minúscula. Se reduce a `letra + clase romana + sufijo` y se busca en el set
 * canónico. Si no matchea una categoría conocida, devuelve `null` (no se inventa una categoría).
 */
export function normalizeLicenseCategory(raw: string): LicenseCategory | null {
  // Aísla la parte relevante: una `A` seguida de números romanos (I/V) y un sufijo de letra opcional.
  // Tolera separadores (espacio/guion) y convierte dígitos árabes comunes (2→II, 3→III) que el OCR
  // a veces produce en vez de los romanos.
  const compact = raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_.]/g, '');
  // El orden importa: las alternativas MÁS LARGAS van primero para que `III[ABC]`/`II[AB]` ganen sobre
  // el prefijo `I{1,3}` (si no, `AIIB` capturaría `II` suelto y se descartaría). Igual para los árabes.
  const match = /A(III[ABC]|II[AB]|3[ABC]|2[AB]|I{1,3}|3|2|1)/.exec(compact);
  if (!match?.[1]) {
    return null;
  }
  const tail = match[1]
    // Normaliza los árabes que el OCR pudo dejar (2→II, 3→III) preservando el sufijo de letra.
    .replace(/^2/, 'II')
    .replace(/^3/, 'III');
  return canonicalizeTail(tail);
}

/** Convierte el "cuerpo" romano (`I`, `IIB`, `IIIC`) a la forma con sufijo en minúscula del catálogo. */
function canonicalizeTail(tail: string): LicenseCategory | null {
  const roman = /^(III|II|I)/.exec(tail);
  if (!roman?.[1]) {
    return null;
  }
  const base = roman[1];
  const suffix = tail.slice(base.length).toLowerCase();
  const candidate = `A-${base}${suffix}`;
  return (LICENSE_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as LicenseCategory)
    : null;
}
