import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { VehicleType } from '@veo/shared-types';
import '../../../../../i18n';
import { Button } from '@veo/ui-kit';
import { VehicleScreen } from '../VehicleScreen';
import { DocumentUploadCard, ScanPropertyCardSheet } from '../../components';
import { useRegistrationStore } from '../../state/registrationStore';
import type {
  PropertyCardAutofillResult,
  PropertyCardScanOutcome,
} from '../../hooks/useScanPropertyCard';
import type { PickedImage } from '../../../../documents/domain';

/**
 * U3 · jerarquía 1-2-3 y UN solo accent por pantalla (VEHÍCULO). Verifica:
 *  1. Tarjeta, Foto y SOAT son CARDS DE PASO NUMERADAS (stepNumber 1, 2, 3) — un solo patrón visual, no tres
 *     tratamientos distintos (antes: Button para la tarjeta vs cards para foto/SOAT).
 *  2. UN solo accent: el único Button accent es el "Registrar vehículo" del footer.
 *  3. CTA que dice QUÉ falta: con el gating incumplido, el botón está disabled y aparece "Te falta: …" del
 *     primer requisito (tarjeta → foto → SOAT).
 */

const NOOP_AUTOFILL: PropertyCardAutofillResult = {
  plate: true,
  year: true,
  make: true,
  model: true,
  color: false,
  vehicleType: false,
};

const FAKE_CARD: PickedImage = {
  uri: 'file:///tmp/property-card.jpg',
  mimeType: 'image/jpeg',
  fileName: 'property-card.jpg',
  width: null,
  height: null,
  fileSize: null,
} as PickedImage;

jest.mock('../../hooks/useScanPropertyCard', () => ({
  useScanPropertyCard: () => ({
    state: 'idle',
    unavailable: false,
    message: null,
    front: null,
    autofilled: {
      plate: false,
      year: false,
      make: false,
      model: false,
      color: false,
      vehicleType: false,
    },
    derivedType: null,
    mtcUnsupported: false,
    vehicle: {
      type: null,
      plate: '',
      year: '',
      modelSpecId: '',
      brand: '',
      model: '',
      mtcCategory: '',
      color: '',
    },
    scan: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock('../../hooks/useRegistrationDocuments', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationDocuments');
  return {
    ...actual,
    useRegistrationDocuments: () => ({ data: [] }),
    useUploadAndRegisterDocument: () => ({ mutateAsync: jest.fn(), isPending: false }),
  };
});

jest.mock('../../hooks/useRegistrationWizard', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationWizard');
  return {
    ...actual,
    useDriverVehicles: () => ({ data: [] }),
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

function accentButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(Button).filter((b) => b.props.variant === 'accent');
}

/** Siembra el store con una captura del scan y dispara `onCaptured` del sheet (mismo idioma que scanType.test). */
function emitScan(renderer: TestRenderer.ReactTestRenderer, derivedType: VehicleType | null) {
  const store = useRegistrationStore.getState();
  act(() => {
    store.setVehicle({ plate: '7351-NB', brand: 'KTM', model: 'RC 200', year: '2021' });
    store.setPendingPropertyCard({ front: FAKE_CARD, extractedData: null });
    if (derivedType !== null) {
      store.setVehicleType(derivedType);
    }
  });
  const sheet = renderer.root.findByType(ScanPropertyCardSheet);
  const outcome: PropertyCardScanOutcome = {
    front: FAKE_CARD,
    autofilled: NOOP_AUTOFILL,
    derivedType,
    mtcUnsupported: false,
  };
  act(() => {
    (sheet.props.onCaptured as (o: PropertyCardScanOutcome) => void)(outcome);
  });
}

describe('VehicleScreen · U3 · jerarquía 1-2-3 y un solo accent', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
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

  it('Tarjeta, Foto y SOAT son cards de paso NUMERADAS (stepNumber 1, 2, 3)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    const steps = renderer.root
      .findAllByType(DocumentUploadCard)
      .map((c) => c.props.stepNumber)
      .filter((n): n is number => typeof n === 'number')
      .sort();
    expect(steps).toEqual([1, 2, 3]);

    act(() => {
      renderer.unmount();
    });
  });

  it('UN solo accent: el único Button accent es "Registrar vehículo" (el escaneo de la tarjeta ya NO es accent)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    const accents = accentButtons(renderer);
    expect(accents).toHaveLength(1);
    expect(accents[0]?.props.label).toBe('Registrar vehículo');

    act(() => {
      renderer.unmount();
    });
  });

  it('CTA disabled muestra QUÉ falta: "Te falta: escanear tu tarjeta de propiedad" (primer requisito)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    const cta = accentButtons(renderer).find((b) => b.props.label === 'Registrar vehículo');
    expect(cta?.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('escanear tu tarjeta de propiedad');

    act(() => {
      renderer.unmount();
    });
  });

  it('con la tarjeta escaneada (datos OK) el "Te falta" avanza a la FOTO (segundo requisito)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    // Scan con tipo derivado (placa+año+modelo+tipo) → datos del vehículo completos; falta foto + SOAT.
    emitScan(renderer, VehicleType.MOTO);

    const text = allText(renderer);
    expect(text).toContain('la foto de tu vehículo');
    expect(text).not.toContain('escanear tu tarjeta de propiedad');

    act(() => {
      renderer.unmount();
    });
  });
});
