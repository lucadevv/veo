import {
  fitVerticalPadding,
  focusPadding,
  MIN_FIT_VISIBLE_PX,
  quantizePx,
  SHEET_GRABBER_CHROME_PX,
  sheetVisibleHeight,
  type SheetSnapSpec,
} from '../mapCamera';

describe('focusPadding', () => {
  it('sin chrome y foco al centro → sin padding (comportamiento previo intacto)', () => {
    expect(focusPadding(800, 0, 0, 0.5)).toEqual({ top: 0, bottom: 0 });
  });

  it('coloca el foco en la fracción pedida del área visible (verificado con la fórmula de la Camera)', () => {
    // Viewport 800, sheet 400 abajo, banner 100 arriba, foco al 70% del área visible (tercio inferior).
    const { top, bottom } = focusPadding(800, 100, 400, 0.7);
    // La Camera centra en y = top + (H - top - bottom) / 2 → debe caer en focusY = 100 + 300·0.7 = 310.
    expect(top + (800 - top - bottom) / 2).toBe(310);
    // Uno de los dos paddings queda en 0 (solución de padding mínimo).
    expect(Math.min(top, bottom)).toBe(0);
  });

  it('foco al centro del área visible con sheet abajo → padding solo abajo', () => {
    const { top, bottom } = focusPadding(800, 0, 400, 0.5);
    expect(top).toBe(0);
    // focusY = 200 → bottom = H - 2·focusY = 400 (el centro del viewport padded cae en 200).
    expect(bottom).toBe(400);
  });

  it('foco en la mitad inferior de la pantalla → padding solo arriba', () => {
    // Sin sheet, banner 0, fracción 0.75 → focusY = 600 (> H/2) → top = 2·600 - 800 = 400.
    expect(focusPadding(800, 0, 0, 0.75)).toEqual({ top: 400, bottom: 0 });
  });

  it('degenerado (insets se comen la pantalla) → no compensa antes que compensar mal', () => {
    expect(focusPadding(800, 500, 400, 0.7)).toEqual({ top: 0, bottom: 0 });
    expect(focusPadding(0, 0, 0, 0.5)).toEqual({ top: 0, bottom: 0 });
    expect(focusPadding(Number.NaN, 0, 0, 0.5)).toEqual({ top: 0, bottom: 0 });
  });

  it('insets negativos se tratan como 0 y la fracción se acota a [0, 1]', () => {
    expect(focusPadding(800, -50, -10, 2)).toEqual({ top: 800, bottom: 0 });
  });
});

describe('fitVerticalPadding', () => {
  it('suma el chrome al padding base por cada lado', () => {
    expect(fitVerticalPadding(800, 64, 100, 300)).toEqual({ top: 164, bottom: 364 });
  });

  it('sin chrome conserva el padding base fijo (comportamiento previo intacto)', () => {
    expect(fitVerticalPadding(800, 64, 0, 0)).toEqual({ top: 64, bottom: 64 });
  });

  it('reduce proporcional si no queda el área visible mínima (zoom nunca degenera)', () => {
    const { top, bottom } = fitVerticalPadding(800, 64, 300, 500);
    expect(top + bottom).toBeLessThanOrEqual(800 - MIN_FIT_VISIBLE_PX);
    // La proporción entre lados se conserva (aprox por el floor).
    expect(bottom).toBeGreaterThan(top);
  });
});

describe('quantizePx', () => {
  it('redondea al múltiplo del quantum (jitter de layout no re-anima la cámara)', () => {
    expect(quantizePx(413, 8)).toBe(416);
    expect(quantizePx(410, 8)).toBe(408);
  });

  it('quantum ≤ 1 solo redondea; medidas no finitas o ≤ 0 → 0', () => {
    expect(quantizePx(413.4, 1)).toBe(413);
    expect(quantizePx(-5, 8)).toBe(0);
    expect(quantizePx(Number.NaN, 8)).toBe(0);
  });
});

describe('sheetVisibleHeight (espejo del DraggableSheet de ui-kit)', () => {
  const header: SheetSnapSpec = { kind: 'header' };
  const peek: SheetSnapSpec = { kind: 'content', capFraction: 0.74 };
  const max: SheetSnapSpec = { kind: 'content', capFraction: 0.94 };

  it("snap 'header' abraza solo el grabber + header medido", () => {
    expect(sheetVisibleHeight(header, 48, 900, 800)).toBe(SHEET_GRABBER_CHROME_PX + 48);
  });

  it("snap 'header' sin medir cae al chrome (nunca 0) y respeta su tope de 0.5", () => {
    expect(sheetVisibleHeight(header, 0, 0, 800)).toBe(SHEET_GRABBER_CHROME_PX);
    expect(sheetVisibleHeight(header, 900, 0, 800)).toBe(400);
  });

  it("snap 'content' abraza header + contenido cuando entra bajo el tope", () => {
    expect(sheetVisibleHeight(peek, 48, 300, 800)).toBe(SHEET_GRABBER_CHROME_PX + 348);
  });

  it("snap 'content' se capa a su fracción cuando el contenido la supera (scrollea adentro)", () => {
    expect(sheetVisibleHeight(peek, 48, 2000, 800)).toBe(Math.round(800 * 0.74));
    expect(sheetVisibleHeight(max, 48, 2000, 800)).toBe(Math.round(800 * 0.94));
  });

  it("snap 'content' sin medir cae a la cota mínima (0.16 del alto útil)", () => {
    expect(sheetVisibleHeight(peek, 0, 0, 800)).toBe(Math.round(800 * 0.16));
  });
});
