import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import '../../../../../i18n';
import { Button } from '@veo/ui-kit';
import { PersonalDataScreen } from '../PersonalDataScreen';
import { DocumentUploadCard } from '../../components';
import { useRegistrationStore } from '../../state/registrationStore';
import { DriverExistence } from '../../hooks/useDriverExists';
import type { RegistrationDocumentView } from '../../../domain';

/**
 * U2 · dedup (DUP #2): en el estado RESUME (el server YA tiene el DNI en estado aceptable, sin captura local
 * en esta sesión) debe haber UNA SOLA affordance de re-escaneo del DNI: la card "DNI ya enviado" (presionable).
 * El Button suelto "Volver a escanear / Escanear DNI" de arriba — que ejecutaba el MISMO `setScanOpen(true)` —
 * NO se renderiza, para no duplicar el mismo tap. En el estado INICIAL (sin captura ni server) sí manda el
 * Button "Escanear DNI" (la card de resume no existe).
 */

/** Listado del server que devuelve el mock de `useRegistrationDocuments` (cada test lo fija). */
let mockServerDocs: RegistrationDocumentView[] = [];
let mockDriverExistence: DriverExistence = DriverExistence.NotFound;

/** Fabrica un `DriverDocument` del server con tipo/estado dados (resto irrelevante para el gate). */
function serverDoc(type: string, status: string, documentNumber = ''): RegistrationDocumentView {
  return {
    type,
    documentNumber,
    status,
    simpleStatus: 'en_revision',
    expiresAt: null,
    ok: status === FleetDocumentStatus.VALID,
    rejectionReason: null,
    images: [],
  };
}

jest.mock('../../hooks/usePersonalDataContinue', () => {
  const actual = jest.requireActual('../../hooks/usePersonalDataContinue');
  return {
    ...actual,
    usePersonalDataContinue: () => ({ submit: jest.fn(), isPending: false }),
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
    useRegistrationDocuments: () => ({ data: mockServerDocs, isError: false, error: null }),
  };
});

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

/** ¿Hay un Button (ui-kit) con un label de re-escaneo del DNI ("Volver a escanear" / "Escanear DNI")? */
function rescanButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Button)
    .filter(
      (b) =>
        b.props.label === 'Volver a escanear' ||
        b.props.label === 'Escanear mi DNI' ||
        b.props.label === 'Escanear DNI',
    );
}

describe('PersonalDataScreen · U2 dedup (DUP #2): una sola affordance de re-escaneo del DNI', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockServerDocs = [];
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

  it('RESUME (server tiene el DNI, sin captura local): la card es la ÚNICA affordance; el Button suelto NO se renderiza', () => {
    mockDriverExistence = DriverExistence.Exists;
    mockServerDocs = [
      serverDoc(FleetDocumentType.DNI, FleetDocumentStatus.PENDING_REVIEW, '70123456'),
    ];

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    // Una sola affordance de re-escaneo: la card "DNI ya enviado" (presionable) + la card de la licencia.
    // El Button suelto de re-escaneo (mismo `setScanOpen`) NO se renderiza en resume → 0 botones de re-escaneo.
    expect(rescanButtons(renderer)).toHaveLength(0);
    // La card del DNI existe y su `accessibilityLabel` comunica el re-escaneo ("Volver a escanear").
    const dniCard = renderer.root
      .findAllByType(DocumentUploadCard)
      .find((c) => c.props.accessibilityLabel === 'Volver a escanear');
    expect(dniCard).toBeDefined();
    expect(typeof dniCard?.props.onPress).toBe('function');

    act(() => {
      renderer.unmount();
    });
  });

  it('INICIAL (sin captura ni server): la card "1 · DNI" es la entrada de escaneo (Escanear DNI); NO hay Button accent que compita', () => {
    mockDriverExistence = DriverExistence.NotFound;
    mockServerDocs = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    // U3 · jerarquía: el escaneo del DNI YA NO es un Button accent que compite con el CTA del footer — es la
    // card de paso numerada "1 · DNI" (stepNumber=1). En el estado inicial su `accessibilityLabel` comunica
    // "Escanear DNI"; el Button suelto de re-escaneo NO existe (un solo accent por pantalla).
    expect(rescanButtons(renderer)).toHaveLength(0);
    const dniCard = renderer.root
      .findAllByType(DocumentUploadCard)
      .find((c) => c.props.stepNumber === 1);
    expect(dniCard).toBeDefined();
    expect(dniCard?.props.accessibilityLabel).toBe('Escanear DNI');
    expect(typeof dniCard?.props.onPress).toBe('function');
    // La card de re-escaneo (label "Volver a escanear") NO existe en el estado inicial.
    const dniResumeCard = renderer.root
      .findAllByType(DocumentUploadCard)
      .find((c) => c.props.accessibilityLabel === 'Volver a escanear');
    expect(dniResumeCard).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });
});
