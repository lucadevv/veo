import { NativeModules } from 'react-native';

/**
 * El escáner de documentos se apoya en el módulo nativo `VeoDocumentScanner` (iOS VisionKit / Android
 * MLKit), que NO existe en Jest. Igual que el resto de módulos nativos del repo, lo MOCKEAMOS sobre
 * `NativeModules` antes de importar el servicio (que captura el módulo al cargar). Cada test usa
 * `jest.isolateModules` para releer el servicio con el mock vigente.
 */

/** Carga el servicio con el `VeoDocumentScanner` actualmente puesto en `NativeModules` (o ausente). */
function loadScanner(): typeof import('../services/native-document-scanner') {
  let mod!: typeof import('../services/native-document-scanner');
  jest.isolateModules(() => {
    mod = require('../services/native-document-scanner');
  });
  return mod;
}

describe('NativeDocumentScanner', () => {
  const original = (NativeModules as Record<string, unknown>).VeoDocumentScanner;

  afterEach(() => {
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = original;
  });

  it('devuelve las imágenes base64 y el texto OCR que entrega el módulo nativo (en orden, alineados)', async () => {
    const scan = jest.fn().mockResolvedValue({
      images: ['/9j/aaa', '/9j/bbb'],
      textLines: [['DNI', '12345678'], ['SOAT', 'Hasta 31/12/2027']],
    });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner, nativeDocumentScannerLinked } = loadScanner();
    const result = await nativeDocumentScanner.scan({ maxPages: 2 });

    expect(result.images).toEqual(['/9j/aaa', '/9j/bbb']);
    expect(result.textLines).toEqual([['DNI', '12345678'], ['SOAT', 'Hasta 31/12/2027']]);
    expect(scan).toHaveBeenCalledWith({ maxPages: 2 });
    expect(nativeDocumentScannerLinked).toBe(true);
  });

  it('aplica maxPages=1 por defecto (1 imagen por documento por ahora)', async () => {
    const scan = jest.fn().mockResolvedValue({ images: ['/9j/aaa'], textLines: [['x']] });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    await nativeDocumentScanner.scan();

    expect(scan).toHaveBeenCalledWith({ maxPages: 1 });
  });

  it('alinea textLines con images: build nativo SIN OCR (sin textLines) → un [] por imagen', async () => {
    // Un build viejo del nativo puede no traer `textLines`. El wrapper rellena con [] por imagen para no
    // romper la alineación: la captura sigue válida, solo no hay texto para auto-llenar (degradación honesta).
    const scan = jest.fn().mockResolvedValue({ images: ['/9j/aaa', '/9j/bbb'] });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    const result = await nativeDocumentScanner.scan({ maxPages: 2 });

    expect(result.textLines).toEqual([[], []]);
  });

  it('sanea textLines: entradas no-array o no-string se normalizan a [] / se filtran (default seguro)', async () => {
    const scan = jest.fn().mockResolvedValue({
      images: ['/9j/aaa', '/9j/bbb'],
      // Primera página: mezcla de string y basura (se filtra). Segunda: no es un array (→ []).
      textLines: [['válida', 123, null, 'otra'], 'no-es-array'],
    });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    const result = await nativeDocumentScanner.scan({ maxPages: 2 });

    expect(result.textLines).toEqual([['válida', 'otra'], []]);
  });

  it('mapea un rechazo nativo con code a un DocumentScannerError tipado', async () => {
    const scan = jest.fn().mockRejectedValue({ code: 'E_CANCELLED', message: 'user dismissed' });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    await expect(nativeDocumentScanner.scan()).rejects.toMatchObject({
      name: 'DocumentScannerError',
      code: 'E_CANCELLED',
    });
  });

  it('un rechazo con code desconocido cae en E_SCAN_FAILED (default seguro, sin código inventado)', async () => {
    const scan = jest.fn().mockRejectedValue({ code: 'E_WEIRD', message: 'boom' });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    await expect(nativeDocumentScanner.scan()).rejects.toMatchObject({ code: 'E_SCAN_FAILED' });
  });

  it('si el nativo resuelve sin imágenes, es un fallo de captura (E_SCAN_FAILED), no un éxito vacío', async () => {
    const scan = jest.fn().mockResolvedValue({ images: [] });
    (NativeModules as Record<string, unknown>).VeoDocumentScanner = { scan };

    const { nativeDocumentScanner } = loadScanner();
    await expect(nativeDocumentScanner.scan()).rejects.toMatchObject({ code: 'E_SCAN_FAILED' });
  });

  it('si el módulo nativo no está enlazado, lanza E_UNAVAILABLE (habilita el fallback a galería)', async () => {
    delete (NativeModules as Record<string, unknown>).VeoDocumentScanner;

    const { nativeDocumentScanner, nativeDocumentScannerLinked } = loadScanner();
    expect(nativeDocumentScannerLinked).toBe(false);
    // Assert estructural (name + code): `jest.isolateModules` recarga el módulo, así que la clase de
    // error es una instancia DISTINTA de la importada al tope; comparar por forma evita ese falso negativo.
    await expect(nativeDocumentScanner.scan()).rejects.toMatchObject({
      name: 'DocumentScannerError',
      code: 'E_UNAVAILABLE',
    });
  });
});
