import React, {type ReactElement} from 'react';
import {AccessibilityInfo, Linking} from 'react-native';
import {SafeAreaProvider, type Metrics} from 'react-native-safe-area-context';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import TestRenderer, {act} from 'react-test-renderer';
import {Button} from '@veo/ui-kit';
import '../../../../../i18n';
import {UnderReviewScreen} from '../UnderReviewScreen';
import {REGISTRATION_GATE_QUERY_KEY} from '../../hooks/useRegistrationGate';
import {useRegistrationStore} from '../../state/registrationStore';
import {env} from '../../../../../core/config/env';

// La animación de entrada (`Reveal`) consulta `AccessibilityInfo` al montar; en Jest el método nativo
// devuelve `undefined`, así que lo estabilizamos para poder renderizar la pantalla.
jest
  .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
  .mockResolvedValue(true);
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockReturnValue({remove: () => undefined} as ReturnType<typeof AccessibilityInfo.addEventListener>);

/** Métricas de safe-area fijas para renderizar `SafeScreen` fuera de un dispositivo real. */
const SAFE_AREA_METRICS: Metrics = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

/**
 * Envuelve la pantalla con safe-area (requerido por `SafeScreen`) y un `QueryClientProvider`
 * (la pantalla usa `useQueryClient` para re-chequear el gate contra el backend).
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
    queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}});
    useRegistrationStore.getState().reset();
    useRegistrationStore.setState({status: 'in_review', statusResolvedFromBackend: true});
  });

  afterEach(() => {
    queryClient.clear();
  });

  /** Encuentra el `onPress` del Button cuya etiqueta coincide (busca en el árbol renderizado). */
  function findButtonPress(
    renderer: TestRenderer.ReactTestRenderer,
    label: string,
  ): () => void {
    const node = renderer.root
      .findAllByType(Button)
      .find(instance => instance.props.label === label);
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

    const onCheckStatus = findButtonPress(renderer, 'Verificar mi estado');
    act(() => {
      onCheckStatus();
    });

    // El botón SOLO dispara la re-consulta del gate (server-authoritative)…
    expect(invalidate).toHaveBeenCalledWith({queryKey: REGISTRATION_GATE_QUERY_KEY});
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
});
