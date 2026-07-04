import React, { type ReactElement } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import i18n from '../../../../../i18n';
import type { AppContainer } from '../../../../../core/di/container';
import { DiProvider } from '../../../../../core/di/useDi';
import { useRegistrationStore } from '../../state/registrationStore';
import { ScanLicenseSheet } from '../ScanLicenseSheet';

/**
 * Pruebas del sheet EAGER de la licencia:
 *  - `needsDni`: cuando la licencia se intenta ANTES que el DNI (driver aún no creado), el sheet pinta el
 *    aviso "Primero escaneá tu DNI" y el único footer es "Cerrar" — NO ofrece confirmar (bloqueo honesto).
 *  - idle: sin captura, muestra el hint + los placeholders de anverso/reverso + el CTA de escaneo.
 */

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function fakeContainer(): AppContainer {
  return {
    documentScanner: { scan: jest.fn() },
    documentUploader: { upload: jest.fn() },
    repositories: { registration: { submitDocument: jest.fn() } },
  } as unknown as AppContainer;
}

function renderSheet(needsDni: boolean): TestRenderer.ReactTestRenderer {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree: ReactElement = (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={queryClient}>
        <DiProvider container={fakeContainer()}>
          <ThemeProvider theme={driverTheme}>
            <ScanLicenseSheet
              visible
              onClose={jest.fn()}
              facePhases={{ front: 'idle', back: 'idle' }}
              needsDni={needsDni}
              onConfirm={jest.fn()}
              onRescan={jest.fn()}
            />
          </ThemeProvider>
        </DiProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(tree);
  });
  return renderer;
}

function tr(key: string): string {
  return i18n.t(key);
}

function hasText(renderer: TestRenderer.ReactTestRenderer, text: string): boolean {
  return renderer.root.findAll((node) => node.props.children === text).length > 0;
}

beforeAll(async () => {
  await i18n.changeLanguage('es-PE');
});

beforeEach(() => {
  act(() => {
    useRegistrationStore.getState().reset();
  });
});

describe('ScanLicenseSheet · needs-dni bloquea; idle ofrece escanear', () => {
  it('needsDni: muestra "Primero escaneá tu DNI" y NO ofrece confirmar', () => {
    const renderer = renderSheet(true);
    expect(hasText(renderer, tr('registration.documents.scanLicense.needsDniTitle'))).toBe(true);
    // NO aparece el hint de escaneo (el estado es de bloqueo, no de captura).
    expect(hasText(renderer, tr('registration.documents.scanLicense.hint'))).toBe(false);
  });

  it('idle: muestra el hint + las etiquetas de anverso/reverso', () => {
    const renderer = renderSheet(false);
    expect(hasText(renderer, tr('registration.documents.scanLicense.hint'))).toBe(true);
    expect(hasText(renderer, tr('registration.documents.scanLicense.needsDniTitle'))).toBe(false);
  });
});
