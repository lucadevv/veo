import React, { type ReactElement } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { VehicleType } from '@veo/shared-types';
import '../../../../../i18n';
import { Button } from '@veo/ui-kit';
import { VehicleScreen } from '../VehicleScreen';
import {
  RegistrationField,
  ScanPropertyCardSheet,
  VehicleTypeSelector,
} from '../../components';
import { useRegistrationStore } from '../../state/registrationStore';
import type {
  PropertyCardAutofillResult,
  PropertyCardScanOutcome,
} from '../../hooks/useScanPropertyCard';
import type { PickedImage } from '../../../../documents/domain';

/**
 * LOTE 1 · El tipo de vehículo se DERIVA de la categoría MTC de la tarjeta (la tarjeta es la fuente de
 * verdad), SIN "Auto" por omisión:
 *  - Tipo DERIVADO (Moto si L*, Auto si M1): se muestra como FILA READ-ONLY ("Tipo de vehículo: Moto") en la
 *    tarjeta capturada — NO hay selector (la tarjeta manda). Registrar se habilita (con foto + datos).
 *  - Tipo NO derivado (categoría no leída/no soportada): el store queda en `type: null` y cae al
 *    VehicleTypeSelector de FALLBACK (ambos tipos CAR|MOTO). Registrar queda DESHABILITADO hasta que el
 *    conductor elija el tipo a mano (sin registrar un "Auto" silencioso). Al elegir, el gating se recomputa
 *    reactivo (Zustand) y el botón se habilita.
 *
 * Estrategia: aislamos la PANTALLA. Mockeamos `useScanPropertyCard` (el sheet lo consume internamente) a
 * un stub sin escáner nativo, y disparamos el resultado del scan invocando el prop `onCaptured` del
 * `ScanPropertyCardSheet` con un `PropertyCardScanOutcome` fabricado, tras sembrar el store con lo que el
 * hook habría prellenado (placa/marca/modelo/año + tipo derivado). Los hooks de datos se mockean a estados
 * vacíos (alta nueva, sin docs) igual que `VehicleScreen.photo409.test`.
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

// El sheet consume `useScanPropertyCard` (que necesita el escáner nativo por DI). Lo stubeamos: la prueba
// dispara el resultado del scan llamando directamente al prop `onCaptured` del sheet (ver helper). El tipo
// `PropertyCardScanOutcome` se mantiene (los tipos se borran en runtime; el import es solo para tipar).
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
    // El sheet solo lee estos campos para su preview; la pantalla lee el store directamente. Stub estático
    // (no referenciar el store acá: la fábrica de jest.mock se hoistea y no puede usar variables externas).
    // LOTE 1: sin seed "Auto" → `type: null`.
    vehicle: { type: null, plate: '', year: '', modelSpecId: '', brand: '', model: '', mtcCategory: '', color: '' },
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

/** El botón "Registrar vehículo" del footer (el único con la etiqueta de registro). */
function registerButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Button)
    .find((b) => b.props.label === 'Registrar vehículo');
}

/**
 * Simula un escaneo CAPTURADO: siembra el store con lo que el hook habría prellenado (placa/marca/modelo/
 * año + tipo derivado si lo hay) e invoca el `onCaptured` del sheet con el outcome fabricado.
 */
function emitScan(
  renderer: TestRenderer.ReactTestRenderer,
  derivedType: VehicleType | null,
  mtcUnsupported: boolean,
) {
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
    mtcUnsupported,
  };
  act(() => {
    (sheet.props.onCaptured as (o: PropertyCardScanOutcome) => void)(outcome);
  });
}

describe('VehicleScreen · LOTE 1 · tipo derivado de la tarjeta (read-only) / fallback (sin "Auto" por omisión)', () => {
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

  it('scan deriva Moto (L3) → el tipo es FILA READ-ONLY (sin selector) y Registrar se habilita', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    // Foto Y SOAT subidos (requisitos ORTOGONALES · LOTE B): así el gating que probamos es el del tipo, no
    // el de la documentación del vehículo.
    act(() => {
      useRegistrationStore.getState().setDocumentStatus('VEHICLE_PHOTO', 'uploaded');
      useRegistrationStore.getState().setDocumentStatus('SOAT', 'uploaded');
      // LOTE A: la tarjeta sube AL ESCANEAR (efecto), no diferida. Para aislar el gating del TIPO la
      // pre-marcamos subida igual que foto/SOAT → el efecto la ve lista y no dispara subida en el test.
      useRegistrationStore.getState().setDocumentStatus('VEHICLE_REGISTRATION', 'uploaded');
    });

    emitScan(renderer, VehicleType.MOTO, false);

    // La tarjeta DERIVÓ el tipo → es READ-ONLY: NO hay VehicleTypeSelector (la tarjeta es la fuente de verdad).
    expect(renderer.root.findAllByType(VehicleTypeSelector)).toHaveLength(0);
    // El tipo derivado quedó en el store y Registrar se habilita (placa+año+modelo+tipo+foto presentes).
    expect(useRegistrationStore.getState().vehicle.type).toBe(VehicleType.MOTO);
    expect(registerButton(renderer)?.props.disabled).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('scan SIN categoría (derivedType null) → selector FALLBACK; Registrar DESHABILITADO hasta elegir; al elegir HABILITA', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    // Marcamos la foto Y el SOAT como subidos (requisitos ORTOGONALES · LOTE B para habilitar Registrar):
    // así el gating que probamos es EXCLUSIVAMENTE el del tipo, no el de la documentación del vehículo.
    act(() => {
      useRegistrationStore.getState().setDocumentStatus('VEHICLE_PHOTO', 'uploaded');
      useRegistrationStore.getState().setDocumentStatus('SOAT', 'uploaded');
      // LOTE A: la tarjeta sube AL ESCANEAR (efecto), no diferida. Para aislar el gating del TIPO la
      // pre-marcamos subida igual que foto/SOAT → el efecto la ve lista y no dispara subida en el test.
      useRegistrationStore.getState().setDocumentStatus('VEHICLE_REGISTRATION', 'uploaded');
    });

    // Scan capturado pero sin tipo derivado (categoría no leída): el store queda en `type: null`.
    emitScan(renderer, null, false);

    // El selector de FALLBACK aparece (ambos tipos) SIN selección (null) — el botón está BLOQUEADO: no se
    // registra "Auto" por omisión, falta la elección explícita del tipo.
    const selector = renderer.root.findByType(VehicleTypeSelector);
    expect(selector.props.value).toBeNull();
    expect(useRegistrationStore.getState().vehicle.type).toBeNull();
    expect(registerButton(renderer)?.props.disabled).toBe(true);

    // El conductor elige el tipo (Moto) → el gating reactivo (Zustand) habilita Registrar.
    act(() => {
      (selector.props.onChange as (t: VehicleType) => void)(VehicleType.MOTO);
    });
    expect(useRegistrationStore.getState().vehicle.type).toBe(VehicleType.MOTO);
    expect(registerButton(renderer)?.props.disabled).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  // ── U2 · dedup (DUP #4): UN solo camino de ingreso (scan primario, manual subordinado) ─────────────
  //
  // El toggle "cargar a mano" es un FALLBACK SUBORDINADO: se OCULTA cuando el scan ya rindió una captura
  // válida (placa+año+tipo leídos), y los dos sets de inputs (parche del scan vs formulario manual) NUNCA
  // coexisten — solo uno visible a la vez.

  /** El toggle manual (ahora link de texto): Pressable con accessibilityLabel "Prefiero cargarlo a mano". */
  function manualToggles(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.findAll(
      (node) =>
        typeof node.props?.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel === 'Prefiero cargarlo a mano' &&
        typeof node.props.onPress === 'function',
    );
  }

  it('captura VÁLIDA del scan (placa+año+tipo) → el toggle "cargar a mano" NO aparece (fallback subordinado oculto)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    // emitScan siembra placa '7351-NB' + año '2021'; con derivedType=MOTO el tipo queda definido → captura VÁLIDA.
    emitScan(renderer, VehicleType.MOTO, false);

    // El toggle manual está OCULTO: con la captura completa, el camino es escanear/reescanear, no cargar a mano.
    expect(manualToggles(renderer)).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('captura INCOMPLETA (sin tipo) → el toggle aparece; al abrir manual NUNCA coexisten los dos sets de inputs', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(<VehicleScreen navigation={fakeNavigation()} route={{} as never} />, queryClient),
      );
    });

    // Scan capturado con placa+año pero SIN tipo derivado → captura incompleta: el toggle subordinado aparece.
    emitScan(renderer, null, false);
    const toggles = manualToggles(renderer);
    expect(toggles).toHaveLength(1);

    // Con la captura del scan, el selector de tipo de FALLBACK del camino scan está visible (un set).
    const scanSelectors = renderer.root.findAllByType(VehicleTypeSelector);
    expect(scanSelectors).toHaveLength(1);

    // El conductor abre el modo manual.
    act(() => {
      (toggles[0]!.props.onPress as () => void)();
    });

    // En modo manual NUNCA coexisten los dos sets: hay EXACTAMENTE un VehicleTypeSelector (el del form manual,
    // el del camino scan se ocultó por `!manualMode`). Antes podían renderizarse los dos a la vez.
    expect(renderer.root.findAllByType(VehicleTypeSelector)).toHaveLength(1);
    // Y el formulario manual rinde su propio set de campos (placa/año/marca/modelo) → varios RegistrationField.
    expect(renderer.root.findAllByType(RegistrationField).length).toBeGreaterThanOrEqual(4);

    act(() => {
      renderer.unmount();
    });
  });
});
