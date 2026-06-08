import React, {type ReactElement} from 'react';
import {AccessibilityInfo, Linking} from 'react-native';
import {SafeAreaProvider, type Metrics} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import {Button} from '@veo/ui-kit';
import '../../../../../i18n';
import {UnderReviewScreen} from '../UnderReviewScreen';
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

/** Envuelve la pantalla con el proveedor de safe-area (requerido por `SafeScreen`). */
function withSafeArea(node: ReactElement): ReactElement {
  return <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>{node}</SafeAreaProvider>;
}

/**
 * Compuerta de seguridad del alta: "Entendido" NO debe aprobar al conductor localmente. La
 * transición a `approved` viene EXCLUSIVAMENTE del backend (vía `applyBackendStatus` en el gate),
 * así que pulsar "Entendido" tiene que dejar el estado en `in_review`.
 */
describe('UnderReviewScreen · "Entendido" no aprueba localmente', () => {
  beforeEach(() => {
    useRegistrationStore.getState().reset();
    useRegistrationStore.setState({status: 'in_review', statusResolvedFromBackend: true});
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

  it('mantiene el estado en `in_review` (no `approved`) tras pulsar "Entendido"', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<UnderReviewScreen />));
    });

    const onUnderstood = findButtonPress(renderer, 'Entendido');
    act(() => {
      onUnderstood();
    });

    // Invariante crítica: el alta NUNCA se aprueba desde la UI.
    expect(useRegistrationStore.getState().status).toBe('in_review');

    act(() => {
      renderer.unmount();
    });
  });

  it('resuelve el canal de soporte desde la configuración de entorno (no hardcodeado)', () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(withSafeArea(<UnderReviewScreen />));
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
