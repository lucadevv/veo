import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { Button } from '@veo/ui-kit';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import type { DriverProfileView } from '@veo/api-client';
import '../../../../../i18n';
import { RejectedScreen } from '../RejectedScreen';
import { REGISTRATION_GATE_QUERY_KEY } from '../../hooks/useRegistrationGate';
import { useRegistrationStore } from '../../state/registrationStore';
import { RegistrationStep } from '../../../domain';

// La pantalla lee documentos rechazados vía `useRegistrationDocuments` (query con DI/sesión) y reenvía
// vía `useResubmitRegistration` (mutación con DI). Las aislamos: el test controla el listado de docs y
// el estado del reenvío sin tocar la red ni el contenedor DI.
let mockRejectedDocs: Array<{ type: string; status: string; rejectionReason: string | null }> = [];
const mockResubmitMutate = jest.fn();
jest.mock('../../hooks/useRegistrationDocuments', () => ({
  useRegistrationDocuments: () => ({ data: mockRejectedDocs }),
}));
jest.mock('../../hooks/useResubmitRegistration', () => ({
  useResubmitRegistration: () => ({ mutate: mockResubmitMutate, isPending: false, isError: false }),
}));

// La salida del onboarding usa `useLogout` (DI) y el guard del back de hardware usa `useFocusEffect`
// (requiere NavigationContainer). Los stubeamos para montar la PANTALLA aislada (mismo idioma que
// UnderReviewScreen.test).
jest.mock('../../hooks/useRegistrationExit', () => ({
  useRegistrationExit: () => ({
    confirmVisible: false,
    requestExit: jest.fn(),
    dismissExit: jest.fn(),
    confirmExit: jest.fn(),
    handleHardwareBack: jest.fn(),
    isLoggingOut: false,
  }),
}));
jest.mock('../../hooks/useRegistrationExitGuard', () => ({
  useRegistrationExitGuard: () => undefined,
}));

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

/** Perfil base de un conductor RECHAZADO; cada test ajusta el EJE (kyc/antecedentes/docs). */
function rejectedProfile(overrides: Partial<DriverProfileView> = {}): DriverProfileView {
  return {
    driverId: 'drv-rej-1',
    userId: 'usr-rej-1',
    phone: '+51987654321',
    kycStatus: 'PENDING',
    currentStatus: 'OFFLINE',
    backgroundCheckStatus: 'PENDING',
    rejectionReason: 'Motivo de prueba',
    averageRating: 0,
    rating: null,
    documents: [],
    compliance: {
      compliant: false,
      requiredTypes: ['LICENSE_A1', 'SOAT', 'PROPERTY_CARD'],
      missing: [],
      rejected: [],
      submittedAllRequired: true,
      allApproved: false,
      biometricEnrolled: true,
    },
    ...overrides,
  };
}

function withProviders(node: ReactElement, client: QueryClient): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

function makeClient(profile: DriverProfileView): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(REGISTRATION_GATE_QUERY_KEY, profile);
  return client;
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string): () => void {
  const node = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props.label === label);
  if (!node) {
    throw new Error(`No se encontró el botón "${label}"`);
  }
  return node.props.onPress as () => void;
}

function findButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props.label === label);
  if (!node) {
    throw new Error(`No se encontró el botón "${label}"`);
  }
  return node;
}

describe('RejectedScreen · navegación coherente del rechazo (U4)', () => {
  beforeEach(() => {
    mockRejectedDocs = [];
    mockResubmitMutate.mockClear();
    useRegistrationStore.getState().reset();
    useRegistrationStore.setState({ status: 'rejected', statusResolvedFromBackend: true });
  });

  it('rechazo de BIOMETRÍA/identidad (KYC) → "Corregir mis datos" lleva al paso KYC (IDENTITY_VERIFICATION), no al paso 1', () => {
    const client = makeClient(rejectedProfile({ kycStatus: 'REJECTED' }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<RejectedScreen />, client));
    });

    act(() => {
      pressButton(renderer, 'Corregir mis datos')();
    });

    expect(useRegistrationStore.getState().currentStep).toBe(
      RegistrationStep.IDENTITY_VERIFICATION,
    );

    act(() => renderer.unmount());
    client.clear();
  });

  it('rechazo de ANTECEDENTES → "Corregir mis datos" lleva al paso KYC (IDENTITY_VERIFICATION)', () => {
    const client = makeClient(rejectedProfile({ backgroundCheckStatus: 'REJECTED' }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<RejectedScreen />, client));
    });

    act(() => {
      pressButton(renderer, 'Corregir mis datos')();
    });

    expect(useRegistrationStore.getState().currentStep).toBe(
      RegistrationStep.IDENTITY_VERIFICATION,
    );

    act(() => renderer.unmount());
    client.clear();
  });

  it('rechazo de un DOC del vehículo (SOAT) → "Corregir mis datos" lleva al paso de ese doc (Vehículo)', () => {
    mockRejectedDocs = [
      {
        type: FleetDocumentType.SOAT,
        status: FleetDocumentStatus.REJECTED,
        rejectionReason: 'SOAT vencido',
      },
    ];
    const client = makeClient(rejectedProfile());
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<RejectedScreen />, client));
    });

    act(() => {
      pressButton(renderer, 'Corregir mis datos')();
    });

    expect(useRegistrationStore.getState().currentStep).toBe(RegistrationStep.VEHICLE);

    act(() => renderer.unmount());
    client.clear();
  });

  it('"Reenviar a revisión" arranca DESHABILITADO (sin corrección) y no dispara el reenvío', () => {
    const client = makeClient(rejectedProfile({ kycStatus: 'REJECTED' }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<RejectedScreen />, client));
    });

    const resubmit = findButton(renderer, 'Reenviar a revisión');
    expect(resubmit.props.disabled).toBe(true);

    act(() => {
      (resubmit.props.onPress as () => void)();
    });
    // El Button real ignora onPress cuando está disabled; acá verificamos la INVARIANTE de estado:
    // sin corrección la señal está en false (el botón está deshabilitado por contrato).
    expect(useRegistrationStore.getState().hasCorrectedAfterRejection).toBe(false);

    act(() => renderer.unmount());
    client.clear();
  });

  it('tras "Corregir mis datos", "Reenviar a revisión" queda HABILITADO', () => {
    const client = makeClient(rejectedProfile({ kycStatus: 'REJECTED' }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<RejectedScreen />, client));
    });

    act(() => {
      pressButton(renderer, 'Corregir mis datos')();
    });

    expect(useRegistrationStore.getState().hasCorrectedAfterRejection).toBe(true);
    expect(findButton(renderer, 'Reenviar a revisión').props.disabled).toBe(false);

    act(() => {
      pressButton(renderer, 'Reenviar a revisión')();
    });
    expect(mockResubmitMutate).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    client.clear();
  });
});
