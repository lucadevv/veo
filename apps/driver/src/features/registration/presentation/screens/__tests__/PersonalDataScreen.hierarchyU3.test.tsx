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
 * U3 · jerarquía 1-2-3 y UN solo accent por pantalla (CONDUCTOR). Verifica:
 *  1. DNI y Licencia son CARDS DE PASO NUMERADAS (stepNumber 1 y 2) — paridad, secuencia visible.
 *  2. UN solo accent: el único Button accent es el "Continuar" del footer (el escaneo del DNI ya NO es accent).
 *  3. CTA que dice QUÉ falta: con el gating incumplido, el "Continuar" está disabled y aparece el texto
 *     "Te falta: …" del PRIMER requisito (DNI antes que licencia).
 */

let mockServerDocs: RegistrationDocumentView[] = [];
let mockDriverExistence: DriverExistence = DriverExistence.NotFound;

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

/** Recolecta recursivamente todos los strings de texto renderizados (para buscar el "Te falta: …"). */
function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  renderer.root.findAll((n) => {
    const c = n.props?.children;
    if (typeof c === 'string') {
      out.push(c);
    } else if (Array.isArray(c)) {
      out.push(c.filter((x): x is string => typeof x === 'string').join(''));
    }
    return false;
  });
  return out.join(' | ');
}

/** Los Button (ui-kit) con variant accent renderizados en pantalla. */
function accentButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(Button).filter((b) => b.props.variant === 'accent');
}

describe('PersonalDataScreen · U3 · jerarquía 1-2-3 y un solo accent', () => {
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

  it('DNI y Licencia son cards de paso NUMERADAS (stepNumber 1 y 2)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    const steps = renderer.root
      .findAllByType(DocumentUploadCard)
      .map((c) => c.props.stepNumber)
      .filter((n): n is number => typeof n === 'number')
      .sort();
    expect(steps).toEqual([1, 2]);

    act(() => {
      renderer.unmount();
    });
  });

  it('UN solo accent: el único Button accent es el "Continuar" del footer', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    const accents = accentButtons(renderer);
    expect(accents).toHaveLength(1);
    expect(accents[0]?.props.label).toBe('Continuar');

    act(() => {
      renderer.unmount();
    });
  });

  it('CTA disabled muestra QUÉ falta: "Te falta: escanear tu DNI" (primer requisito) y Continuar deshabilitado', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <PersonalDataScreen navigation={fakeNavigation()} route={{} as never} />,
          queryClient,
        ),
      );
    });

    const cta = accentButtons(renderer).find((b) => b.props.label === 'Continuar');
    expect(cta?.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('escanear tu DNI');

    act(() => {
      renderer.unmount();
    });
  });

  it('con el DNI ya en el servidor, el "Te falta" avanza a la LICENCIA (segundo requisito)', () => {
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

    const text = allText(renderer);
    expect(text).toContain('tu licencia de conducir');
    expect(text).not.toContain('escanear tu DNI');

    act(() => {
      renderer.unmount();
    });
  });
});
