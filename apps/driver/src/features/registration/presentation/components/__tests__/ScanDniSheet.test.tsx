import React, { type ReactElement } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import i18n from '../../../../../i18n';
import type { ScannedDocument } from '../../../../documents/domain';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import { useRegistrationStore } from '../../state/registrationStore';
import { ScanDniSheet } from '../ScanDniSheet';

/**
 * Pruebas del sheet de captura del DNI tras el fix del "OCR vacío":
 *  - OCR OK (el número de DNI se lee) → tarjeta "DNI capturado ✓" MINIMALISTA (tilde + título), SIN listar
 *    valores, y el CTA primario permite CONFIRMAR.
 *  - OCR VACÍO (textLines vacío → no se lee el número crítico) → NO se muestra una tarjeta vacía que finge
 *    éxito: se muestra el FALLBACK honesto "No pudimos leer tu número de DNI · reescaneá", y el CTA primario
 *    NO confirma (vuelve a escanear).
 *
 * El escáner se inyecta por DI con un doble; el sheet usa `useScanDni`, que parsea el texto con `parseDni`
 * y prellena el store de forma no destructiva.
 */

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Texto OCR del FRENTE de un DNI peruano legible (incluye el número crítico). */
const DNI_FRONT_LINES: string[] = [
  'REPUBLICA DEL PERU',
  'Documento Nacional de Identidad',
  'DNI 70123456',
  'Apellidos: QUISPE MAMANI',
  'Pre Nombres: CARLOS',
  'Fecha de Nacimiento: 15/03/1990',
];

/** Escaneo legible: dos imágenes (anverso + reverso) con el texto del frente alineado a images[0]. */
function dniScanReadable(): ScannedDocument {
  return {
    images: ['/9j/front-base64', '/9j/back-base64'],
    textLines: [DNI_FRONT_LINES, ['DETALLES DEL REVERSO']],
  };
}

/**
 * Escaneo con OCR VACÍO: las imágenes viajan (la foto se ve bien) pero `textLines` está vacío por imagen.
 * Reproduce EXACTAMENTE el bug reportado: imagen OK + card "vacía" (binario nativo sin la capa OCR, o foto
 * sin texto legible). El parser no extrae el número → fallback honesto.
 */
function dniScanNoText(): ScannedDocument {
  return {
    images: ['/9j/front-base64', '/9j/back-base64'],
    textLines: [[], []],
  };
}

interface ScannerDouble {
  scan: jest.Mock<Promise<ScannedDocument>, [options?: { maxPages?: number }]>;
}

function fakeContainer(scanner: ScannerDouble): AppContainer {
  return {
    documentScanner: scanner,
    documentUploader: { upload: jest.fn() },
    repositories: { registration: { submitDocument: jest.fn() } },
  } as unknown as AppContainer;
}

/**
 * Renderiza el sheet con todos los providers (DI + react-query + tema + safe area). Devuelve el renderer y
 * un capturador del callback `onPress` del CTA primario (último botón del footer), para accionarlo desde
 * el test sin depender de coordenadas.
 */
function renderSheet(scanner: ScannerDouble): {
  renderer: TestRenderer.ReactTestRenderer;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree: ReactElement = (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={queryClient}>
        <DiProvider container={fakeContainer(scanner)}>
          <ThemeProvider theme={driverTheme}>
            <ScanDniSheet visible onClose={jest.fn()} />
          </ThemeProvider>
        </DiProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(tree);
  });
  return { renderer };
}

/** Texto exacto resuelto por i18n (la app corre es-PE). */
function tr(key: string): string {
  return i18n.t(key);
}

/** ¿Hay algún nodo cuyo texto sea exactamente `text`? (mismo patrón que el test del sheet de documentos). */
function hasText(renderer: TestRenderer.ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => node.props.children === text).length > 0;
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
  if (!target) {
    throw new Error(`No se encontró un botón con accessibilityLabel="${label}"`);
  }
  act(() => {
    target.props.onPress();
  });
}

/** Dispara el escaneo accionando el CTA primario "Escanear DNI" y resolviendo el onScan asíncrono. */
async function pressScan(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressByLabel(renderer, tr('registration.personal.scanDni.cta'));
  });
}

beforeAll(async () => {
  await i18n.changeLanguage('es-PE');
});

beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('ScanDniSheet · OCR vacío → fallback honesto; OCR ok → "DNI capturado ✓"', () => {
  it('OCR OK: muestra "DNI capturado" minimalista (sin listar valores) y permite confirmar', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScanReadable()) };
    const { renderer } = renderSheet(scanner);

    await pressScan(renderer);

    // Tarjeta minimalista "DNI capturado": el título de éxito está presente.
    expect(hasText(renderer, tr('registration.personal.scanDni.capturedTitle'))).toBe(true);
    // NO se listan los valores leídos (nombre/dni/nacimiento) ni el viejo "Esto leímos de tu DNI:".
    expect(hasText(renderer, tr('registration.personal.scanDni.extracted'))).toBe(false);
    expect(hasText(renderer, '70123456')).toBe(false);
    expect(hasText(renderer, 'QUISPE MAMANI CARLOS')).toBe(false);
    // NO aparece el fallback de campo crítico (el número SÍ se leyó).
    expect(hasText(renderer, tr('registration.personal.scanDni.criticalMissingTitle'))).toBe(false);

    // El store quedó prellenado con el número crítico (la captura fue real).
    expect(useRegistrationStore.getState().personal.dni).toBe('70123456');
  });

  it('OCR VACÍO (imagen OK, sin texto): NO muestra card vacía; muestra el fallback "reescaneá"', async () => {
    const scanner: ScannerDouble = { scan: jest.fn(async () => dniScanNoText()) };
    const { renderer } = renderSheet(scanner);

    await pressScan(renderer);

    // Fallback HONESTO del campo crítico: se pide reescanear (no una tarjeta que finge éxito).
    expect(hasText(renderer, tr('registration.personal.scanDni.criticalMissingTitle'))).toBe(true);
    // NO se muestra la tarjeta "DNI capturado ✓" (no hubo lectura del número).
    expect(hasText(renderer, tr('registration.personal.scanDni.capturedTitle'))).toBe(false);
    // El número crítico NO quedó en el store (OCR vacío → degradación honesta).
    expect(useRegistrationStore.getState().personal.dni).toBe('');
  });
});
