import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import '../../../../../i18n';
import { PersonalDataScreen } from '../PersonalDataScreen';
import { DocumentUploadStatus } from '../../../domain';
import { useRegistrationStore } from '../../state/registrationStore';
import { DriverExistence } from '../../hooks/useDriverExists';
import type {
  PersonalDataContinueParams,
  PersonalDataContinueResult,
} from '../../hooks/usePersonalDataContinue';

/**
 * LOTE A · El "Continuar" del paso CONDUCTOR unifica la FUENTE DE VERDAD con `driverExists`. Tres ramas:
 *  (a) RESUME (driver existe, `personal` vacío): NAVEGA sin re-PATCHear → sin field-errors ni "datos no
 *      válidos" (mata el dead-end). Se verifica que el `driverExists` que recibe el continue es `true`.
 *  (b) FRESCO (driver no existe, `personal` poblado por escaneo): pasa `driverExists=false` al continue
 *      (el PATCH crea el driver). Espejo del alta nueva.
 *  (c) #F (chip que miente): un `document-upload-failed` de la LICENCIA REVIERTE su flag local UPLOADED
 *      (marcado optimista en el escaneo) a PENDING, para que el chip refleje la verdad del servidor.
 *
 * Estrategia: aislamos la PANTALLA. Mockeamos `usePersonalDataContinue` (capturamos el `submit` y
 * controlamos su resultado), `useDriverExists` (la señal server) y `useRegistrationDocuments` (listado del
 * server vacío). El navigation se stubea. No se re-testea el pipeline del continue (ya cubierto en su hook).
 */

/** Resultado que devuelve el `submit` mockeado (cada test lo fija). */
let mockSubmitResult: PersonalDataContinueResult = { status: 'ok' };
/** Captura el último `params` con que la pantalla llamó al continue (para verificar `driverExists`). */
const mockSubmit = jest.fn(
  async (_params: PersonalDataContinueParams): Promise<PersonalDataContinueResult> => mockSubmitResult,
);
/** Señal de existencia del driver que el mock de `useDriverExists` devuelve (cada test la fija). */
let mockDriverExistence: DriverExistence = DriverExistence.NotFound;

jest.mock('../../hooks/usePersonalDataContinue', () => {
  const actual = jest.requireActual('../../hooks/usePersonalDataContinue');
  return {
    ...actual,
    usePersonalDataContinue: () => ({ submit: mockSubmit, isPending: false }),
  };
});

jest.mock('../../hooks/useDriverExists', () => {
  const actual = jest.requireActual('../../hooks/useDriverExists');
  return {
    ...actual,
    useDriverExists: () => mockDriverExistence,
  };
});

jest.mock('../../hooks/useRegistrationDocuments', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationDocuments');
  return {
    ...actual,
    // Listado del servidor vacío: aislamos el screen (la existencia del driver la da `useDriverExists`).
    useRegistrationDocuments: () => ({ data: [], isError: false, error: null }),
  };
});

// `useRegistrationExitGuard` engancha el botón físico de Android vía @react-navigation; stub mínimo.
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => ({
      navigate: jest.fn(),
      goBack: jest.fn(),
      dispatch: jest.fn(),
      addListener: () => () => undefined,
      canGoBack: () => false,
      reset: jest.fn(),
      getState: () => ({ routes: [], index: 0 }),
    }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      const ReactLib = require('react');
      ReactLib.useEffect(() => effect(), [effect]);
    },
  };
});

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockReturnValue({ remove: () => undefined } as ReturnType<
    typeof AccessibilityInfo.addEventListener
  >);

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** `navigation` mínima que el screen consume (`navigate` para avanzar a Vehicle). */
function fakeNavigation() {
  return { navigate: jest.fn() } as never;
}

function withProviders(node: ReactElement, client: QueryClient): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Encuentra el botón "Continuar" del footer por su label y dispara su `onPress`. */
function pressContinue(renderer: TestRenderer.ReactTestRenderer): void {
  const button = renderer.root
    .findAll((node) => typeof node.props?.label === 'string' && node.props.label === 'Continuar')
    .find((node) => typeof node.props.onPress === 'function');
  if (!button) {
    throw new Error('No se encontró el botón Continuar');
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
}

describe('PersonalDataScreen · Continuar unifica la fuente de verdad (driverExists)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockSubmit.mockClear();
    mockSubmitResult = { status: 'ok' };
    mockDriverExistence = DriverExistence.NotFound;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    act(() => {
      useRegistrationStore.getState().reset();
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('(a) RESUME (driverExists): Continuar llama al submit con driverExists=true → navega (sin re-PATCH)', async () => {
    mockDriverExistence = DriverExistence.Exists;
    // Estado de RESUME: el server tiene al conductor; el avance local marca el DNI y la licencia UPLOADED
    // (lo hace la hidratación) para que el gating habilite el botón sin captura local en esta sesión.
    act(() => {
      useRegistrationStore.getState().setPersonal({ dni: '70123456' });
      useRegistrationStore.getState().setDocumentStatus('LICENSE', DocumentUploadStatus.UPLOADED);
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    await act(async () => {
      pressContinue(renderer);
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const params = mockSubmit.mock.calls[0]?.[0];
    // La pantalla derivó `driverExists=true` del `DriverExistence.Exists` → el continue salta el PATCH.
    expect(params?.driverExists).toBe(true);

    act(() => {
      renderer.unmount();
    });
  });

  it('(b) FRESCO (driver no existe): Continuar llama al submit con driverExists=false (PATCH crea el driver)', async () => {
    mockDriverExistence = DriverExistence.NotFound;
    // Alta fresca: el escaneo pobló el DNI y dejó la licencia capturada (pendiente) → gating habilitado.
    act(() => {
      useRegistrationStore.getState().setPersonal({
        fullName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthdate: '1990-03-15',
      });
      useRegistrationStore.getState().setPendingLicense({
        file: {
          uri: 'data:image/jpeg;base64,/9j/license',
          mimeType: 'image/jpeg',
          fileName: 'lic.jpg',
          width: null,
          height: null,
          fileSize: null,
        },
        documentNumber: 'Q12345678',
        expiresAt: '2030-12-31',
        extractedData: null,
      });
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    await act(async () => {
      pressContinue(renderer);
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const params = mockSubmit.mock.calls[0]?.[0];
    // Alta fresca → `driverExists=false`: el continue ejecuta el PATCH que crea el driver.
    expect(params?.driverExists).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('(c) #F: document-upload-failed de la LICENCIA revierte su flag local UPLOADED a PENDING (el chip no miente)', async () => {
    mockDriverExistence = DriverExistence.NotFound;
    // El escaneo marcó la licencia UPLOADED optimistamente (markLicenseCaptured) y dejó la captura pendiente.
    act(() => {
      useRegistrationStore.getState().setPersonal({
        fullName: 'QUISPE MAMANI CARLOS',
        dni: '70123456',
        birthdate: '1990-03-15',
      });
      useRegistrationStore.getState().setDocumentStatus('LICENSE', DocumentUploadStatus.UPLOADED);
      useRegistrationStore.getState().setPendingLicense({
        file: {
          uri: 'data:image/jpeg;base64,/9j/license',
          mimeType: 'image/jpeg',
          fileName: 'lic.jpg',
          width: null,
          height: null,
          fileSize: null,
        },
        documentNumber: 'Q12345678',
        expiresAt: '2030-12-31',
        extractedData: null,
      });
    });
    // La subida diferida de la licencia falla tras el PATCH.
    mockSubmitResult = { status: 'document-upload-failed', document: 'license' };

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    await act(async () => {
      pressContinue(renderer);
    });

    // El flag local de la LICENCIA se revirtió a PENDING: el chip ya no dice "Subido" cuando el server no lo tiene.
    const licenseDoc = useRegistrationStore
      .getState()
      .documents.find((d) => d.type === 'LICENSE');
    expect(licenseDoc?.status).toBe(DocumentUploadStatus.PENDING);

    act(() => {
      renderer.unmount();
    });
  });
});
