/**
 * Matemática PURA de la cámara consciente del chrome (sheet abajo + banner de maniobras arriba).
 *
 * El mapa ocupa la pantalla completa, pero el ÁREA VISIBLE es lo que queda entre el chrome superior
 * (banner de maniobras / header flotante) y el inferior (sheet/dock). La Camera de Mapbox centra su
 * `centerCoordinate` respecto del viewport COMPLETO; estas funciones derivan el `padding` que corre
 * ese centro para que el foco (puck / encuadre de ruta) viva dentro del área visible.
 *
 * Derivación pura y testeada (jest); los componentes solo la consumen.
 */

/** Padding vertical (px) a aplicar a la Camera de Mapbox. Horizontal lo decide el llamador. */
export interface VerticalPadding {
  top: number;
  bottom: number;
}

/** Área visible mínima (px) que el encuadre fit conserva: evita paddings que degeneren el zoom. */
export const MIN_FIT_VISIBLE_PX = 120;

/**
 * Padding vertical para que el `centerCoordinate` quede a la FRACCIÓN dada (0=arriba, 1=abajo) del
 * área visible `[topInset, viewportHeight - bottomInset]`. La Camera coloca el centro en el punto
 * medio del viewport DESCONTADO el padding: `y = paddingTop + (H - paddingTop - paddingBottom) / 2`;
 * resolvemos para `y = focusY` con UNO de los dos paddings en 0 (existen infinitas soluciones; la de
 * padding mínimo no recorta tiles de más).
 */
export function focusPadding(
  viewportHeight: number,
  topInset: number,
  bottomInset: number,
  fraction: number,
): VerticalPadding {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { top: 0, bottom: 0 };
  }
  const top = Math.max(0, topInset);
  const bottom = Math.max(0, bottomInset);
  const visible = viewportHeight - top - bottom;
  if (visible <= 0) {
    // Insets degenerados (se comen la pantalla completa): no compensar antes que compensar mal.
    return { top: 0, bottom: 0 };
  }
  const f = Math.min(Math.max(fraction, 0), 1);
  const focusY = top + visible * f;
  const delta = Math.round(2 * focusY - viewportHeight);
  return delta >= 0 ? { top: delta, bottom: 0 } : { top: 0, bottom: -delta };
}

/**
 * Padding vertical del ENCUADRE fit (bounds): el base fijo + lo que ocupa el chrome. Si la suma no
 * dejara ni `MIN_FIT_VISIBLE_PX` de área visible, ambos lados se reducen proporcionalmente (mejor un
 * encuadre apretado que un zoom degenerado/negativo en el runtime nativo).
 */
export function fitVerticalPadding(
  viewportHeight: number,
  basePadding: number,
  topInset: number,
  bottomInset: number,
): VerticalPadding {
  let top = basePadding + Math.max(0, topInset);
  let bottom = basePadding + Math.max(0, bottomInset);
  const maxTotal = Math.max(0, viewportHeight - MIN_FIT_VISIBLE_PX);
  const total = top + bottom;
  if (total > maxTotal && total > 0) {
    const scale = maxTotal / total;
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  return { top, bottom };
}

/**
 * Cuantiza un alto medido a múltiplos de `quantum`: el jitter de layout de ±1-2 px NO debe re-animar
 * la cámara (cada cambio de padding dispara un `easeTo`).
 */
export function quantizePx(px: number, quantum: number): number {
  if (!Number.isFinite(px) || px <= 0) {
    return 0;
  }
  if (quantum <= 1) {
    return Math.round(px);
  }
  return Math.round(px / quantum) * quantum;
}

/* ── Espejo del modelo de altura del DraggableSheet (@veo/ui-kit) ────────────────────────────────
 * El sheet NO expone su altura visible por snap (solo `onSnap` con el índice); estas constantes y la
 * derivación replican su math de content-hugging para calcular cuánto tapa cada anclaje.
 * CONSTRAINT: deben mantenerse en sincronía con `packages/ui-kit/src/components/DraggableSheet.tsx`
 * (GRABBER_CHROME, MIN_CONTENT_FRACTION y el cap del anclaje 'header'). */

/** Alto de la fila del grabber (paddingTop 8 + grabber 4 + paddingBottom 6) — espejo de ui-kit. */
export const SHEET_GRABBER_CHROME_PX = 18;

/** Piso del anclaje 'content' sin medir (fracción del alto útil) — espejo de ui-kit. */
export const SHEET_MIN_CONTENT_FRACTION = 0.16;

/** Tope del anclaje 'header' (fracción del alto útil) — espejo de ui-kit (fraction 0.5). */
export const SHEET_HEADER_CAP_FRACTION = 0.5;

/**
 * Especificación de un snap del sheet, espejo 1:1 de los `snapPoints` que la pantalla le pasa al
 * `DraggableSheet`: `'header'` colapsa al header; `'content'` abraza el contenido hasta `capFraction`.
 */
export type SheetSnapSpec =
  | { readonly kind: 'header' }
  | { readonly kind: 'content'; readonly capFraction: number };

/**
 * Alto VISIBLE (px) del sheet asentado en `spec`, dado lo medido del header y del contenido y el alto
 * útil (`window - inset superior`). Misma derivación que el hilo de UI del DraggableSheet:
 * grabber + medido, con piso y tope según el tipo de anclaje.
 */
export function sheetVisibleHeight(
  spec: SheetSnapSpec,
  headerPx: number,
  contentPx: number,
  availablePx: number,
): number {
  const available = Math.max(availablePx, 1);
  const chrome = SHEET_GRABBER_CHROME_PX;
  if (spec.kind === 'header') {
    const full = headerPx > 0 ? chrome + headerPx : chrome;
    const cap = Math.round(available * SHEET_HEADER_CAP_FRACTION);
    return Math.round(Math.min(Math.max(full, chrome), cap));
  }
  const minContent = Math.round(available * SHEET_MIN_CONTENT_FRACTION);
  const measured = headerPx + contentPx;
  const full = measured > 0 ? chrome + measured : minContent;
  const cap = Math.round(available * clampSheetFraction(spec.capFraction));
  return Math.round(Math.min(Math.max(full, minContent), cap));
}

/** Acota la fracción de un anclaje al rango sano de ui-kit (espejo de `clampFraction`). */
function clampSheetFraction(fraction: number): number {
  if (Number.isNaN(fraction)) {
    return 0.5;
  }
  return Math.min(Math.max(fraction, 0.05), 0.98);
}
