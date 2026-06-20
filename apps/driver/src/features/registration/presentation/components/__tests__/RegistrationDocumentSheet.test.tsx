import React, { type ReactElement } from 'react';
import { TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import { FleetDocumentType } from '@veo/shared-types';
import i18n from '../../../../../i18n';
import {
  RegistrationDocumentSheet,
  type RegistrationDocumentInput,
} from '../RegistrationDocumentSheet';
import {
  DocumentScannerError,
  type PickedImage,
  type ScannedDocument,
} from '../../../../documents/domain';
import type { RegistrationDocumentFormType } from '../registrationDocumentForm';

/**
 * El sheet de captura de documentos del alta es CONTEXTUAL por tipo:
 *  - LICENSE_A1 / SOAT: muestran y EXIGEN el campo de vencimiento, y el número usa su etiqueta propia.
 *  - PROPERTY_CARD: NO muestra vencimiento (la tarjeta de propiedad no vence en Perú) y se envía SIN
 *    `expiresAt` (el contrato `addDocumentRequest.expiresAt` es opcional — sin cambio de backend).
 */

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function withProviders(node: ReactElement): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ThemeProvider theme={driverTheme}>{node}</ThemeProvider>
    </SafeAreaProvider>
  );
}

/** Archivo capturado de mentira: el flujo lo trata como opaco (la foto es la fuente de verdad). */
const FILE: PickedImage = {
  uri: 'file:///tmp/doc.jpg',
  mimeType: 'image/jpeg',
  fileName: 'doc.jpg',
  width: 1080,
  height: 1920,
  fileSize: 1024,
};

/** Imagen base64 (sin prefijo data:) que devuelve el escáner nativo (croppeada + corregida). */
const SCANNED_BASE64 = '/9j/scanned-doc-base64';

/** Resultado del escáner por defecto: una imagen y SIN texto OCR (página sin texto reconocible). */
const SCANNED_NO_TEXT: ScannedDocument = { images: [SCANNED_BASE64], textLines: [[]] };

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  onSubmit: jest.Mock<void, [RegistrationDocumentInput]>;
  onScan: jest.Mock<Promise<ScannedDocument>, []>;
  onPick: jest.Mock<Promise<PickedImage | null>, []>;
}

interface RenderOverrides {
  /** Comportamiento del escáner nativo (por defecto: una imagen escaneada, sin texto OCR). */
  onScan?: () => Promise<ScannedDocument>;
  /** Comportamiento de la galería (por defecto: devuelve un archivo). */
  onPick?: () => Promise<PickedImage | null>;
}

function renderSheet(
  documentType: RegistrationDocumentFormType,
  overrides: RenderOverrides = {},
): Harness {
  const onSubmit = jest.fn<void, [RegistrationDocumentInput]>();
  // Por defecto el escáner devuelve una imagen real SIN texto OCR (el conductor escaneó OK; el
  // auto-llenado se prueba aparte con líneas explícitas).
  const onScan = jest.fn<Promise<ScannedDocument>, []>(
    overrides.onScan ?? (async () => SCANNED_NO_TEXT),
  );
  // Por defecto la galería devuelve un archivo (fallback feliz).
  const onPick = jest.fn<Promise<PickedImage | null>, []>(
    overrides.onPick ?? (async () => FILE),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      withProviders(
        <RegistrationDocumentSheet
          visible
          documentLabel="Documento"
          documentType={documentType}
          uploadState="idle"
          onClose={jest.fn()}
          onPick={onPick}
          onScan={onScan}
          onSubmit={onSubmit}
        />,
      ),
    );
  });
  return { renderer, onSubmit, onScan, onPick };
}

/** Texto exacto resuelto por i18n (la app corre es-PE). */
function tr(key: string): string {
  return i18n.t(key);
}

/** ¿Existe un nodo con este accessibilityLabel? (el DateField expone su label así). */
function hasAccessibilityLabel(renderer: TestRenderer.ReactTestRenderer, label: string): boolean {
  return (
    renderer.root.findAll((node) => node.props.accessibilityLabel === label).length > 0
  );
}

/** Encuentra todos los TextInput montados (el campo de número es el único). */
function findInputs(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByType(TextInput);
}

/** Invoca el onPress del botón con este accessibilityLabel (el último si hay varios). */
function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const buttons = renderer.root.findAll(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error(`No se encontró un botón con accessibilityLabel="${label}"`);
  act(() => {
    target.props.onPress();
  });
}

/** Escanea el documento (acción principal) resolviendo las microtareas del onScan asíncrono. */
async function scan(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressByLabel(renderer, tr('registration.documents.scan'));
  });
}

/** Elige una imagen de la galería (fallback) resolviendo las microtareas del onPick asíncrono. */
async function pickFromGallery(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressByLabel(renderer, tr('registration.documents.fromGallery'));
  });
}

/** Escanea el documento (habilita el envío) y dispara el CTA "Guardar". */
async function captureAndSubmit(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await scan(renderer);
  pressByLabel(renderer, tr('registration.documents.save'));
}

/** ¿Hay un preview de imagen montado con esta URI? (el preview usa <Image source={{ uri }}>). */
function hasPreviewWithUri(renderer: TestRenderer.ReactTestRenderer, uri: string): boolean {
  return (
    renderer.root.findAll(
      (node) => node.props.source != null && node.props.source.uri === uri,
    ).length > 0
  );
}

/** ¿Hay algún nodo cuyo texto sea exactamente `text`? (para verificar banners/avisos por su título). */
function hasText(renderer: TestRenderer.ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => node.props.children === text).length > 0;
}

describe('RegistrationDocumentSheet · formulario contextual por tipo de documento', () => {
  it('LICENSE_A1: usa la etiqueta de número de la licencia y MUESTRA el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.LICENSE_A1);
    const numberLabel = tr('registration.documents.number.LICENSE_A1.label');
    const expiryLabel = tr('registration.documents.expiryLabel');

    // El campo de número expone su etiqueta propia (el TextField pasa el label como accessibilityLabel/placeholder).
    const numberPlaceholder = tr('registration.documents.number.LICENSE_A1.placeholder');
    const input = findInputs(renderer)[0];
    expect(input?.props.placeholder).toBe(numberPlaceholder);
    expect(numberLabel).toBe('N° de licencia');

    // El DateField de vencimiento está presente (la licencia vence).
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(true);
  });

  it('SOAT: usa la etiqueta de número del SOAT y MUESTRA el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT);
    const numberPlaceholder = tr('registration.documents.number.SOAT.placeholder');
    const expiryLabel = tr('registration.documents.expiryLabel');

    expect(tr('registration.documents.number.SOAT.label')).toBe('N° de póliza (SOAT)');
    expect(findInputs(renderer)[0]?.props.placeholder).toBe(numberPlaceholder);
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(true);
  });

  it('PROPERTY_CARD: usa su etiqueta de número y NO muestra el campo de vencimiento', () => {
    const { renderer } = renderSheet(FleetDocumentType.PROPERTY_CARD);
    const expiryLabel = tr('registration.documents.expiryLabel');

    expect(tr('registration.documents.number.PROPERTY_CARD.label')).toBe(
      'N° de tarjeta de propiedad',
    );
    // La tarjeta de propiedad no vence: el DateField NO se monta.
    expect(hasAccessibilityLabel(renderer, expiryLabel)).toBe(false);
  });

  it('PROPERTY_CARD: envía el documento SIN expiresAtIso (expiresAt opcional en el contrato)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.PROPERTY_CARD);

    // Llena el número (PROPERTY_CARD no exige vencimiento, así que con número + foto basta).
    const input = findInputs(renderer)[0];
    act(() => {
      input?.props.onChangeText('TP-12345');
    });

    await captureAndSubmit(renderer);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.documentNumber).toBe('TP-12345');
    // El sheet NO incluye `expiresAtIso` para un documento que no vence.
    expect(payload && 'expiresAtIso' in payload).toBe(false);
    // El archivo enviado es el del ESCÁNER (acción principal), modelado como data: URI jpeg.
    expect(payload?.file.uri).toBe(`data:image/jpeg;base64,${SCANNED_BASE64}`);
    expect(payload?.file.mimeType).toBe('image/jpeg');
  });

  it('LICENSE_A1: NO envía mientras falte el vencimiento (requerido para documentos que vencen)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.LICENSE_A1);

    const input = findInputs(renderer)[0];
    act(() => {
      input?.props.onChangeText('Q-99887766');
    });

    // Escanea + intenta enviar SIN fecha de vencimiento → el sheet bloquea el envío.
    await captureAndSubmit(renderer);

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('RegistrationDocumentSheet · escáner de documentos (escanear / cancelar / no disponible)', () => {
  it('escaneo OK: convierte la imagen base64 en un data: URI y la muestra en el preview', async () => {
    const { renderer, onScan } = renderSheet(FleetDocumentType.PROPERTY_CARD);

    await scan(renderer);

    expect(onScan).toHaveBeenCalledTimes(1);
    // El sheet toma images[0] y la modela como data: URI para reusar el pipeline de subida tal cual.
    expect(hasPreviewWithUri(renderer, `data:image/jpeg;base64,${SCANNED_BASE64}`)).toBe(true);
  });

  it('escaneo OK → permite enviar: onSubmit recibe el file escaneado (data: URI, mime jpeg)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.PROPERTY_CARD);

    const input = findInputs(renderer)[0];
    act(() => {
      input?.props.onChangeText('TP-55555');
    });

    await captureAndSubmit(renderer);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.file.uri).toBe(`data:image/jpeg;base64,${SCANNED_BASE64}`);
    expect(payload?.file.mimeType).toBe('image/jpeg');
  });

  it('E_CANCELLED: el conductor cancela → NO hay preview ni error de fallo (cancelar no es fallo)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.PROPERTY_CARD, {
      onScan: async () => {
        throw new DocumentScannerError('E_CANCELLED');
      },
    });

    await scan(renderer);

    // No quedó imagen capturada y el sheet NO muestra el banner de fallo de escaneo.
    expect(hasPreviewWithUri(renderer, `data:image/jpeg;base64,${SCANNED_BASE64}`)).toBe(false);
    expect(hasText(renderer, tr('registration.documents.scanFailed'))).toBe(false);
    // El aviso de cancelación es informativo (no bloquea): intentar enviar sin archivo no llama a onSubmit.
    pressByLabel(renderer, tr('registration.documents.save'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('E_UNAVAILABLE: el escáner no está → muestra el aviso de fallback y la galería sí captura', async () => {
    const { renderer, onPick } = renderSheet(FleetDocumentType.PROPERTY_CARD, {
      onScan: async () => {
        throw new DocumentScannerError('E_UNAVAILABLE');
      },
    });

    await scan(renderer);

    // Degradación honesta: aparece el aviso de "escáner no disponible" (título del banner de fallback).
    expect(hasText(renderer, tr('registration.documents.scanUnavailable'))).toBe(true);

    // La galería (fallback) sigue capturando: tras elegir, hay preview con el archivo de la galería.
    await pickFromGallery(renderer);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(hasPreviewWithUri(renderer, FILE.uri)).toBe(true);
  });

  it('E_SCAN_FAILED: el escaneo falla → muestra el banner de error de escaneo (reintentable)', async () => {
    const { renderer } = renderSheet(FleetDocumentType.PROPERTY_CARD, {
      onScan: async () => {
        throw new DocumentScannerError('E_SCAN_FAILED');
      },
    });

    await scan(renderer);

    expect(hasText(renderer, tr('registration.documents.scanFailed'))).toBe(true);
  });
});

describe('RegistrationDocumentSheet · auto-llenado desde el OCR del escaneo', () => {
  it('SOAT: pre-llena número de póliza + vencimiento desde textLines y avisa "extraído del documento"', async () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async (): Promise<ScannedDocument> => ({
        images: [SCANNED_BASE64],
        textLines: [['SOAT', 'N° de Póliza: POL-2024-99887', 'Vigencia Desde 01/01/2026 Hasta 31/12/2026']],
      }),
    });

    await scan(renderer);

    // El número de póliza quedó pre-llenado en el campo (el TextField refleja el value extraído).
    expect(findInputs(renderer)[0]?.props.value).toBe('POL-2024-99887');
    // El aviso de degradación honesta aparece (campo auto-extraído → confirmá).
    expect(hasText(renderer, tr('registration.documents.autofill.extracted'))).toBe(true);
  });

  it('SOAT: el envío usa el vencimiento extraído (fin de vigencia 31/12/2026, no el inicio)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async (): Promise<ScannedDocument> => ({
        images: [SCANNED_BASE64],
        textLines: [['Póliza: POL-77', 'Vigencia Desde 01/01/2026 Hasta 31/12/2026']],
      }),
    });

    await scan(renderer);
    pressByLabel(renderer, tr('registration.documents.save'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.documentNumber).toBe('POL-77');
    // El sheet normaliza AAAA-MM-DD a ISO; el día (UTC) es el 31/12/2026 (fin de vigencia).
    expect(payload?.expiresAtIso?.slice(0, 10)).toBe('2026-12-31');
  });

  it('OCR sin texto útil: NO pre-llena nada (no inventa) y el aviso de extraído no aparece', async () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async (): Promise<ScannedDocument> => ({
        images: [SCANNED_BASE64],
        textLines: [['texto', 'sin', 'campos', 'reconocibles']],
      }),
    });

    await scan(renderer);

    // El campo de número sigue vacío (degradación honesta: tipeo manual).
    expect(findInputs(renderer)[0]?.props.value).toBe('');
    expect(hasText(renderer, tr('registration.documents.autofill.extracted'))).toBe(false);
  });
});
