import React, { type ReactElement } from 'react';
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
  type ImageSource,
  type PickedImage,
  type ScannedDocument,
} from '../../../../documents/domain';
import type { RegistrationDocumentFormType } from '../registrationDocumentForm';

/**
 * El sheet de captura de documentos del alta es el flujo "Capturado ✓" SIN formularios (Lote 1):
 *  - El conductor ESCANEA; el OCR lee número/vencimiento y se ENVÍA AUTOMÁTICAMENTE (sin campos editables).
 *  - El payload lleva `extractedData` (mapeada al contrato) + `ocrEngine` + `ocrAt` para trazabilidad.
 *  - Si el OCR NO leyó el campo CRÍTICO (número), NO se envía: se pide REESCANEAR (fallback honesto).
 *  - VEHICLE_PHOTO (modo foto) se captura con cámara normal (sin OCR) y se envía directo.
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

/** Archivo capturado de mentira (galería/cámara): el flujo lo trata como opaco. */
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

/** Texto OCR de un SOAT legible (GROUND TRUTH: N° Póliza - Certificado combinado + Hasta). */
const SOAT_POLICY_NUMBER = '2012044701 - 1';
const SOAT_LINES = [
  'SOAT',
  'N° Póliza - Certificado: 2012044701 - 1',
  'Vigencia Desde 01/01/2026 Hasta 31/12/2026',
];
/** Texto OCR de una licencia legible (GROUND TRUTH: Nro de Licencia + Fecha de Revalidacion). */
const LICENSE_LINES = ['Nro de Licencia Q12345678', 'Categoría A-I', 'Fecha de Revalidacion 30/06/2028'];

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  onSubmit: jest.Mock<void, [RegistrationDocumentInput]>;
  onScan: jest.Mock<Promise<ScannedDocument>, []>;
  onPick: jest.Mock<Promise<PickedImage | null>, [ImageSource]>;
}

interface RenderOverrides {
  onScan?: () => Promise<ScannedDocument>;
  onPick?: (source: ImageSource) => Promise<PickedImage | null>;
  /** `false` espeja el modo foto de la pantalla (no se inyecta `onScan`). */
  withScan?: boolean;
}

function scanned(lines: string[]): ScannedDocument {
  return { images: [SCANNED_BASE64], textLines: [lines] };
}

function renderSheet(
  documentType: RegistrationDocumentFormType,
  overrides: RenderOverrides = {},
): Harness {
  const onSubmit = jest.fn<void, [RegistrationDocumentInput]>();
  const onScan = jest.fn<Promise<ScannedDocument>, []>(
    overrides.onScan ?? (async () => scanned([])),
  );
  const onPick = jest.fn<Promise<PickedImage | null>, [ImageSource]>(
    overrides.onPick ?? (async () => FILE),
  );
  const withScan = overrides.withScan ?? true;
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
          {...(withScan ? { onScan } : {})}
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

/** Toma una foto con la cámara (acción principal del modo foto) resolviendo el onPick asíncrono. */
async function takePhoto(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressByLabel(renderer, tr('registration.documents.photo.take'));
  });
}

/** ¿Hay un preview/imagen montado con esta URI? */
function hasPreviewWithUri(renderer: TestRenderer.ReactTestRenderer, uri: string): boolean {
  return (
    renderer.root.findAll(
      (node) => node.props.source != null && node.props.source.uri === uri,
    ).length > 0
  );
}

/** ¿Hay algún nodo cuyo texto sea exactamente `text`? */
function hasText(renderer: TestRenderer.ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => node.props.children === text).length > 0;
}

describe('RegistrationDocumentSheet · "Capturado ✓" auto-envío (sin formularios)', () => {
  it('SOAT legible: escanear → auto-envía con extractedData + ocrEngine + ocrAt (sin paso de form)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => scanned(SOAT_LINES),
    });

    await scan(renderer);

    // Auto-envío inmediato tras el escaneo válido (no hay botón "Guardar" intermedio).
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.documentNumber).toBe(SOAT_POLICY_NUMBER);
    // El archivo es el del ESCÁNER, modelado como data: URI jpeg.
    expect(payload?.file.uri).toBe(`data:image/jpeg;base64,${SCANNED_BASE64}`);
    // Lote 1: la data OCR mapeada al contrato (ExtractedSoatData) + trazabilidad del motor.
    expect(payload?.extractedData).toEqual({
      type: FleetDocumentType.SOAT,
      policyNumber: SOAT_POLICY_NUMBER,
      expiresAt: '2026-12-31',
    });
    expect(['ios-visionkit', 'android-mlkit']).toContain(payload?.ocrEngine);
    expect(typeof payload?.ocrAt).toBe('string');
    // El vencimiento (fin de vigencia) viaja como ISO.
    expect(payload?.expiresAtIso?.slice(0, 10)).toBe('2026-12-31');
    // Se muestra la tarjeta "Capturado ✓".
    expect(hasText(renderer, tr('registration.documents.captured.title'))).toBe(true);
  });

  it('licencia legible: escanear → auto-envía con ExtractedLicenseA1Data (number→documentNumber)', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.LICENSE_A1, {
      onScan: async () => scanned(LICENSE_LINES),
    });

    await scan(renderer);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload?.documentNumber).toBe('Q12345678');
    expect(payload?.extractedData).toEqual({
      type: FleetDocumentType.LICENSE_A1,
      documentNumber: 'Q12345678',
      expiresAt: '2028-06-30',
    });
    expect(hasPreviewWithUri(renderer, `data:image/jpeg;base64,${SCANNED_BASE64}`)).toBe(true);
  });

  it('campo CRÍTICO faltante (SOAT sin número): NO envía y pide REESCANEAR (no un form)', async () => {
    // El OCR no ancla el número de póliza (sin la etiqueta "Póliza" no se adivina) → crítico ausente.
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => scanned(['texto', 'sin', 'campos', 'reconocibles']),
    });

    await scan(renderer);

    // No se envía nada (degradación honesta) y aparece el aviso de reescaneo (título del banner).
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasText(renderer, tr('registration.documents.criticalMissing.title'))).toBe(true);
    // NO se muestra la tarjeta "Capturado ✓" (no hubo lectura válida).
    expect(hasText(renderer, tr('registration.documents.captured.title'))).toBe(false);
    // La acción ofrecida es REESCANEAR (no un formulario editable).
    expect(hasText(renderer, tr('registration.documents.rescan'))).toBe(true);
  });

  it('FIX B · SOAT con número pero SIN vencimiento: NO envía y pide REESCANEAR (validez legal)', async () => {
    // El OCR ancla la póliza pero no hay líneas de vigencia → el vencimiento (crítico para un tipo que
    // vence) queda ausente: el gating bloquea el auto-envío en silencio.
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => scanned(['SOAT', 'N° Póliza - Certificado: 2012044701 - 1']),
    });

    await scan(renderer);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hasText(renderer, tr('registration.documents.criticalMissing.title'))).toBe(true);
    expect(hasText(renderer, tr('registration.documents.captured.title'))).toBe(false);
  });
});

describe('RegistrationDocumentSheet · escáner (cancelar / no disponible / falla)', () => {
  it('E_CANCELLED: cancelar no es fallo → ni preview ni banner de error, y no se envió', async () => {
    const { renderer, onSubmit } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => {
        throw new DocumentScannerError('E_CANCELLED');
      },
    });

    await scan(renderer);

    expect(hasPreviewWithUri(renderer, `data:image/jpeg;base64,${SCANNED_BASE64}`)).toBe(false);
    expect(hasText(renderer, tr('registration.documents.scanFailed'))).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('E_UNAVAILABLE: el escáner no está → aviso de fallback de galería', async () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => {
        throw new DocumentScannerError('E_UNAVAILABLE');
      },
    });

    await scan(renderer);

    expect(hasText(renderer, tr('registration.documents.scanUnavailable'))).toBe(true);
  });

  it('E_SCAN_FAILED: el escaneo falla → banner de error de escaneo (reintentable)', async () => {
    const { renderer } = renderSheet(FleetDocumentType.SOAT, {
      onScan: async () => {
        throw new DocumentScannerError('E_SCAN_FAILED');
      },
    });

    await scan(renderer);

    expect(hasText(renderer, tr('registration.documents.scanFailed'))).toBe(true);
  });
});

describe('RegistrationDocumentSheet · modo foto (vehículo, sin OCR)', () => {
  it('VEHICLE_PHOTO: cámara normal → auto-envía sin número, sin OCR, con el file de la cámara', async () => {
    const { renderer, onPick, onScan, onSubmit } = renderSheet(FleetDocumentType.VEHICLE_PHOTO, {
      withScan: false,
    });

    // Acción principal es "Tomar foto" (no "Escanear documento"); copy de foto.
    expect(hasText(renderer, tr('registration.documents.photo.take'))).toBe(true);
    expect(hasText(renderer, tr('registration.documents.scan'))).toBe(false);
    expect(hasText(renderer, tr('registration.documents.photo.reviewNote'))).toBe(true);

    await takePhoto(renderer);

    // La cámara se abrió vía el image-picker con source "camera"; el escáner NUNCA se invocó.
    expect(onPick).toHaveBeenCalledWith('camera');
    expect(onScan).not.toHaveBeenCalled();
    expect(hasPreviewWithUri(renderer, FILE.uri)).toBe(true);
    // Auto-envío directo: sin número, sin expiresAt, sin extractedData (no hay OCR de la foto).
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]?.[0];
    // FIX D-1: para los tipos SIN número (foto del vehículo) el campo `documentNumber` se OMITE del payload
    // (no se manda `''`) — coherente con el contrato `addDocumentRequest` (opcional por tipo).
    expect(payload && 'documentNumber' in payload).toBe(false);
    expect(payload?.documentNumber).toBeUndefined();
    expect(payload && 'expiresAtIso' in payload).toBe(false);
    expect(payload?.extractedData).toBeUndefined();
    expect(payload?.file.uri).toBe(FILE.uri);
  });

  it('LICENSE_A1: modo documento → acción principal es el ESCÁNER (copy de documento)', () => {
    const { renderer } = renderSheet(FleetDocumentType.LICENSE_A1);
    expect(hasText(renderer, tr('registration.documents.scan'))).toBe(true);
    expect(hasText(renderer, tr('registration.documents.photo.take'))).toBe(false);
    expect(hasText(renderer, tr('registration.documents.reviewNote'))).toBe(true);
  });
});
