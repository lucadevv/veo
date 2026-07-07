import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { CommonActions } from '@react-navigation/native';
import { RegistrationStep } from '../../../domain';
import { useRegistrationStore } from '../../state/registrationStore';
import { useRegistrationStepBack } from '../useRegistrationStepBack';

/**
 * Navegación mockeable de la pila de registro. `canGoBack` es controlable por test para simular una
 * pila SUPERFICIAL (reanudar = `[pasoN]`) vs. una pila ya formada por navegación normal.
 */
const mockNav = {
  canGoBack: jest.fn(() => false),
  goBack: jest.fn(),
  dispatch: jest.fn(),
};

// `useNavigation` devuelve la nav mockeada; `useFocusEffect` corre el callback como efecto normal
// (mismo idioma que `UnderReviewScreen.test`: ejercita el guard real sin un `NavigationContainer`).
jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNav,
    useFocusEffect: (effect: () => void | (() => void)) => {
      const React = require('react');
      React.useEffect(() => effect(), [effect]);
    },
  };
});

// El exit-confirm (Lote 1) se apoya en `useLogout` (DI + react-query). El back/resume bajo test NO
// depende de la implementación real del logout, solo del CONTRATO `RegistrationExit`: lo stubeamos
// para aislar la reconstrucción de la pila y el back seguro de la maquinaria de sesión.
const mockExitStub = {
  confirmVisible: false,
  requestExit: jest.fn(),
  dismissExit: jest.fn(),
  confirmExit: jest.fn(),
  handleHardwareBack: jest.fn(),
  isLoggingOut: false,
};
jest.mock('../useRegistrationExit', () => ({
  useRegistrationExit: () => mockExitStub,
}));

/** Host mínimo que expone el resultado del hook para inspeccionarlo en el test. */
function HookHost({
  onReady,
}: {
  onReady: (back: ReturnType<typeof useRegistrationStepBack>) => void;
}) {
  const back = useRegistrationStepBack();
  onReady(back);
  return null;
}

describe('useRegistrationStepBack · reconstrucción + back seguro (fix del GO_BACK muerto)', () => {
  beforeEach(() => {
    mockNav.canGoBack.mockReset();
    mockNav.goBack.mockReset();
    mockNav.dispatch.mockReset();
    mockExitStub.confirmVisible = false;
    mockExitStub.requestExit.mockReset();
    useRegistrationStore.getState().reset();
  });

  it('reanudar en el paso 3 con pila superficial reconstruye [1,2,3] vía CommonActions.reset', () => {
    // LOTE B: el paso 3 es KYC (IdentityVerification); el viejo paso Documentos desapareció. Reanuda en
    // KYC (paso 3): MMKV persistido. La pila arranca superficial (`[IdentityVerification]`).
    useRegistrationStore.setState({ currentStep: RegistrationStep.IDENTITY_VERIFICATION });
    mockNav.canGoBack.mockReturnValue(false);

    act(() => {
      TestRenderer.create(<HookHost onReady={() => undefined} />);
    });

    // Se sembró la pila completa `[PersonalData, Vehicle, IdentityVerification]` con índice 2 (KYC arriba),
    // exactamente lo que produce `CommonActions.reset` con esa forma.
    expect(mockNav.dispatch).toHaveBeenCalledTimes(1);
    expect(mockNav.dispatch).toHaveBeenCalledWith(
      CommonActions.reset({
        index: 2,
        routes: [{ name: 'PersonalData' }, { name: 'Vehicle' }, { name: 'IdentityVerification' }],
      }),
    );
  });

  it('NO reconstruye si la pila ya tiene pasos previos (navegación normal, canGoBack=true)', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.IDENTITY_VERIFICATION });
    mockNav.canGoBack.mockReturnValue(true);

    act(() => {
      TestRenderer.create(<HookHost onReady={() => undefined} />);
    });

    // Ya hay pila debajo: no pisarla con un reset.
    expect(mockNav.dispatch).not.toHaveBeenCalled();
  });

  it('NO reconstruye al reanudar en el paso 1 (no hay nada debajo que sembrar)', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.PERSONAL_DATA });
    mockNav.canGoBack.mockReturnValue(false);

    act(() => {
      TestRenderer.create(<HookHost onReady={() => undefined} />);
    });

    expect(mockNav.dispatch).not.toHaveBeenCalled();
  });

  it('onBack desde KYC con paso previo retrocede (goBack), NUNCA un GO_BACK muerto', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.IDENTITY_VERIFICATION });
    // Tras la reconstrucción hay pasos debajo → `canGoBack()` true: el back camina al paso anterior.
    mockNav.canGoBack.mockReturnValue(true);

    let back!: ReturnType<typeof useRegistrationStepBack>;
    act(() => {
      TestRenderer.create(<HookHost onReady={(b) => (back = b)} />);
    });

    act(() => {
      back.onBack();
    });

    // El back retrocede de verdad (sin tirar un GO_BACK al vacío) y no abre el exit-confirm.
    expect(mockNav.goBack).toHaveBeenCalledTimes(1);
    expect(mockExitStub.requestExit).not.toHaveBeenCalled();
  });

  it('onBack con pila SUPERFICIAL en KYC reconstruye al paso ANTERIOR (Vehículo), NO claudica al exit', () => {
    // Bug que cazó el dueño: la pila quedó superficial (re-mount del navigator por un cambio de
    // `registrationStatus` en el root) y `canGoBack()` es false PERSISTENTE — la reconstrucción de mount no
    // la rescató. El back NO debe ofrecer "salir" en un paso > 1: debe caminar al paso anterior (fuente de
    // verdad = `currentStep`, no la pila frágil).
    useRegistrationStore.setState({ currentStep: RegistrationStep.IDENTITY_VERIFICATION });
    mockNav.canGoBack.mockReturnValue(false);

    let back!: ReturnType<typeof useRegistrationStepBack>;
    act(() => {
      TestRenderer.create(<HookHost onReady={(b) => (back = b)} />);
    });
    // La reconstrucción de mount ya disparó un reset; aislamos el dispatch del onBack.
    mockNav.dispatch.mockClear();

    act(() => {
      back.onBack();
    });

    // Reconstruye `[PersonalData, Vehicle]` posicionando en Vehículo (paso anterior) — NO el exit-confirm.
    expect(mockExitStub.requestExit).not.toHaveBeenCalled();
    expect(mockNav.dispatch).toHaveBeenCalledTimes(1);
    expect(mockNav.dispatch).toHaveBeenCalledWith(
      CommonActions.reset({
        index: 1,
        routes: [{ name: 'PersonalData' }, { name: 'Vehicle' }],
      }),
    );
    // El wizard sigue a la pila: `currentStep` retrocede a Vehículo (resume coherente con lo visible).
    expect(useRegistrationStore.getState().currentStep).toBe(RegistrationStep.VEHICLE);
  });

  it('onBack SIN paso anterior (paso 1) abre el exit-confirm (no hay a dónde retroceder)', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.PERSONAL_DATA });
    mockNav.canGoBack.mockReturnValue(false);

    let back!: ReturnType<typeof useRegistrationStepBack>;
    act(() => {
      TestRenderer.create(<HookHost onReady={(b) => (back = b)} />);
    });
    mockNav.dispatch.mockClear();

    act(() => {
      back.onBack();
    });

    // Paso 1: sin paso anterior → exit-confirm, sin reconstruir.
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(mockExitStub.requestExit).toHaveBeenCalledTimes(1);
  });
});
