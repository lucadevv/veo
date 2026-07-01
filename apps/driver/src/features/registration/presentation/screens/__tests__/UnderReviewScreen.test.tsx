import React, { type ReactElement } from 'react';
import { AccessibilityInfo, Linking } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { Banner, Button, Text } from '@veo/ui-kit';
import type { DriverProfileView } from '@veo/api-client';
import '../../../../../i18n';
import { UnderReviewScreen } from '../UnderReviewScreen';
import { REGISTRATION_GATE_QUERY_KEY } from '../../hooks/useRegistrationGate';
import type { RegistrationGate } from '../../hooks/useRegistrationGate';
import { useRegistrationStore } from '../../state/registrationStore';
import { env } from '../../../../../core/config/env';
import { initSecureStorage } from '../../../../../core/storage/mmkv';

// El almacén seguro se abre ASÍNCRONO con la clave del Keystore (como en el boot real). La pantalla
// arrastra sessionStore/gate, que tocan `secureStore`; sin init lanzaría SecureStoreNotInitializedError.
beforeAll(async () => {
  await initSecureStorage();
});

// Override controlable del gate para el caso de error de refresco: por defecto `null` ⇒ se usa el hook
// REAL (los tests de invariante de seguridad re-consultan el gate de verdad). Cuando un test setea un
// gate fijo, la pantalla lo consume sin tocar la red. Mismo idioma que los mocks parciales del repo.
let mockGateOverride: RegistrationGate | null = null;
jest.mock('../../hooks/useRegistrationGate', () => {
  const actual = jest.requireActual('../../hooks/useRegistrationGate');
  return {
    ...actual,
    useRegistrationGate: () => mockGateOverride ?? actual.useRegistrationGate(),
  };
});

// La unidad bajo test es la PANTALLA, no el navigator: no montamos un `NavigationContainer` real.
// `UnderReviewScreen` es una pantalla RAÍZ del onboarding y usa `useRegistrationExitGuard`, que se
// apoya en `useFocusEffect` de @react-navigation para interceptar el back de hardware solo mientras
// la pantalla está enfocada. Fuera de un `NavigationContainer`, `useFocusEffect` lanza "Couldn't find
// a navigation object". Lo stubeamos para que ejecute el callback (montando/desmontando el guard real,
// que sigue ejercitándose) sin exigir el contenedor de navegación. Mismo idioma que `PanicScreen.test`
// en apps/passenger (stub de hooks de navegación cuando se testea la pantalla aislada).
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => {
      const React = require('react');
      // `useCallback(effect, deps)` ya viene memoizado desde el hook; lo corremos como un efecto normal.
      React.useEffect(() => effect(), [effect]);
    },
  };
});

// La animación de entrada (`Reveal`) consulta `AccessibilityInfo` al montar; en Jest el método nativo
// devuelve `undefined`, así que lo estabilizamos para poder renderizar la pantalla.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockReturnValue({ remove: () => undefined } as ReturnType<
    typeof AccessibilityInfo.addEventListener
  >);

/** Métricas de safe-area fijas para renderizar `SafeScreen` fuera de un dispositivo real. */
const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * Perfil mínimo válido `DriverProfileView` de un conductor EN REVISIÓN: subió TODOS los documentos
 * (`submittedAllRequired`) y enroló su biometría (`biometricEnrolled`), pero aún no está aprobado
 * (`allApproved: false`, KYC/antecedentes pendientes). Es la condición server-truth de `in_review`.
 * Se siembra en el cache del gate para que la pantalla derive su checklist REAL (no hardcodeado).
 */
const IN_REVIEW_PROFILE: DriverProfileView = {
  driverId: 'drv-rev-1',
  userId: 'usr-rev-1',
  phone: '+51987654321',
  kycStatus: 'PENDING',
  currentStatus: 'OFFLINE',
  backgroundCheckStatus: 'PENDING',
  rejectionReason: null,
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
};

/**
 * Envuelve la pantalla con safe-area (requerido por `SafeScreen`) y un `QueryClientProvider`
 * (la pantalla usa `useRegistrationGate`, que lee/invalida la query del gate).
 * Devuelve `React.JSX.Element` (≡ `ReactElement<any, any>`): el `ReactElement` "pelado" de React 19
 * tiene `P = unknown` y no es asignable al `create()` de @types/react-test-renderer@18 (anida
 * @types/react@18). Mismo idioma que las anotaciones `React.JSX.Element` del resto del repo.
 */
function withProviders(node: ReactElement, client: QueryClient): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * Compuerta de seguridad del alta: "Verificar mi estado" NO debe aprobar al conductor localmente.
 * La transición a `approved` viene EXCLUSIVAMENTE del backend (vía `applyBackendStatus` en el
 * gate): el botón solo INVALIDA la query del gate para re-consultar `GET /drivers/me`, y el estado
 * local tiene que quedar en `in_review`.
 */
describe('UnderReviewScreen · "Verificar mi estado" no aprueba localmente', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useRegistrationStore.getState().reset();
    useRegistrationStore.setState({ status: 'in_review', statusResolvedFromBackend: true });
    // La pantalla deriva su checklist REAL del perfil del gate: sembramos un perfil `in_review` válido
    // en el cache para que `useRegistrationGate` lo exponga sin disparar un fetch (no hay sesión auth).
    queryClient.setQueryData(REGISTRATION_GATE_QUERY_KEY, IN_REVIEW_PROFILE);
  });

  afterEach(() => {
    queryClient.clear();
  });

  /** Encuentra el `onPress` del Button cuya etiqueta coincide (busca en el árbol renderizado). */
  function findButtonPress(renderer: TestRenderer.ReactTestRenderer, label: string): () => void {
    const node = renderer.root
      .findAllByType(Button)
      .find((instance) => instance.props.label === label);
    if (!node) {
      throw new Error(`No se encontró el botón con etiqueta "${label}"`);
    }
    return node.props.onPress as () => void;
  }

  it('re-chequea contra el backend y mantiene `in_review` tras pulsar "Verificar mi estado"', () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<UnderReviewScreen />, queryClient));
    });

    const onCheckStatus = findButtonPress(renderer, 'Actualizar estado');
    act(() => {
      onCheckStatus();
    });

    // El botón SOLO dispara la re-consulta del gate (server-authoritative)…
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REGISTRATION_GATE_QUERY_KEY });
    // …e invariante crítica: el alta NUNCA se aprueba desde la UI.
    expect(useRegistrationStore.getState().status).toBe('in_review');

    act(() => {
      renderer.unmount();
    });
  });

  it('resuelve el canal de soporte desde la configuración de entorno (no hardcodeado)', () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<UnderReviewScreen />, queryClient));
    });

    const onContactSupport = findButtonPress(renderer, 'Contactar a soporte');
    act(() => {
      onContactSupport();
    });

    expect(openURL).toHaveBeenCalledWith(`mailto:${env.SUPPORT_EMAIL}`);

    openURL.mockRestore();
    act(() => {
      renderer.unmount();
    });
  });

  it('diseño minimal: muestra el estado de revisión sin inventar progreso por eje', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<UnderReviewScreen />, queryClient));
    });

    // Rediseño Tesla-minimal: se quitó el timeline de checks + el latido (se sentían sobre-diseñados).
    // La pantalla es espartana — título de revisión + tiempo estimado concreto — y NUNCA inventa
    // progreso por eje ni un spinner perpetuo (el bug histórico de la fila de identidad ya no existe
    // porque no hay checklist que pueda mentir).
    const texts = renderer.root.findAllByType(Text).map((n) => n.props.children);
    expect(texts).toContain('Estamos revisando\ntus datos');
    expect(texts).toContain('24 a 48 horas hábiles');
    expect(texts).not.toContain('En revisión');

    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * Estado de error de refresco: cuando una RE-consulta del gate falla pero ya teníamos un perfil
 * resuelto, la pantalla muestra un banner NO bloqueante (no la pantalla de reintento). El botón
 * mantiene su acción única "Actualizar estado" (vocabulario canónico: un término por intención); el
 * error se comunica por el banner, no cambiando el label. Mockeamos el hook para aislar el contrato de
 * UI del error (`refreshError: true`).
 */
describe('UnderReviewScreen · estado de error de refresco', () => {
  beforeEach(() => {
    useRegistrationStore.getState().reset();
    useRegistrationStore.setState({ status: 'in_review', statusResolvedFromBackend: true });
    // Gate fijo en estado de error de refresco: ya resolvió (perfil presente) pero el último refetch
    // falló (`refreshError: true`). La pantalla debe degradar a un banner no bloqueante, no a un dead-end.
    mockGateOverride = {
      resolving: false,
      needsRetry: false,
      retry: jest.fn(),
      profile: IN_REVIEW_PROFILE,
      isRefreshing: false,
      refreshError: true,
      refresh: jest.fn(),
    };
  });

  afterEach(() => {
    mockGateOverride = null;
  });

  it('muestra el banner "No pudimos actualizar" y el botón sigue en "Actualizar estado" cuando `refreshError` es true', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withProviders(<UnderReviewScreen />, client));
    });

    // Banner no bloqueante presente con tono `warn`.
    const banners = renderer.root.findAllByType(Banner);
    expect(banners).toHaveLength(1);
    expect(banners[0]?.props.tone).toBe('warn');
    expect(banners[0]?.props.title).toBe('No pudimos actualizar');

    // El botón primario mantiene su acción única "Actualizar estado" (no muta el label en error).
    const labels = renderer.root.findAllByType(Button).map((n) => n.props.label);
    expect(labels).toContain('Actualizar estado');

    act(() => {
      renderer.unmount();
    });
    client.clear();
  });
});
