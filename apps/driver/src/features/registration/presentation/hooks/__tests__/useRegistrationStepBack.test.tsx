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
function HookHost({ onReady }: { onReady: (back: ReturnType<typeof useRegistrationStepBack>) => void }) {
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
    // Reanuda en Documentos (paso 3): MMKV persistido. La pila arranca superficial (`[Documents]`).
    useRegistrationStore.setState({ currentStep: RegistrationStep.DOCUMENTS });
    mockNav.canGoBack.mockReturnValue(false);

    act(() => {
      TestRenderer.create(<HookHost onReady={() => undefined} />);
    });

    // Se sembró la pila completa `[PersonalData, Vehicle, Documents]` con índice 2 (Documentos arriba),
    // exactamente lo que produce `CommonActions.reset` con esa forma.
    expect(mockNav.dispatch).toHaveBeenCalledTimes(1);
    expect(mockNav.dispatch).toHaveBeenCalledWith(
      CommonActions.reset({
        index: 2,
        routes: [{ name: 'PersonalData' }, { name: 'Vehicle' }, { name: 'Documents' }],
      }),
    );
  });

  it('NO reconstruye si la pila ya tiene pasos previos (navegación normal, canGoBack=true)', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.DOCUMENTS });
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

  it('onBack desde Documentos con paso previo retrocede (goBack), NUNCA un GO_BACK muerto', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.DOCUMENTS });
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

  it('onBack sin paso previo (caso límite) abre el exit-confirm en vez de morir', () => {
    useRegistrationStore.setState({ currentStep: RegistrationStep.DOCUMENTS });
    // Pila superficial persistente (la reconstrucción no aplicó): el back NO puede morir.
    mockNav.canGoBack.mockReturnValue(false);

    let back!: ReturnType<typeof useRegistrationStepBack>;
    act(() => {
      TestRenderer.create(<HookHost onReady={(b) => (back = b)} />);
    });

    act(() => {
      back.onBack();
    });

    // En vez de un GO_BACK muerto, ofrece la salida del onboarding (Lote 1).
    expect(mockNav.goBack).not.toHaveBeenCalled();
    expect(mockExitStub.requestExit).toHaveBeenCalledTimes(1);
  });
});
