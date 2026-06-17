import type {MobilePaymentMethod} from '@veo/api-client';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';

// `useReducedMotion` (ui-kit) usa AccessibilityInfo; el preset de RN no lo implementa. Stubs seguros.
{
  const {AccessibilityInfo} = jest.requireActual('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({remove: jest.fn()});
}

import {PaymentMethodPicker} from './PaymentMethodPicker';
import {
  DIGITAL_PAYMENT_METHODS,
  PAYMENT_METHODS,
} from '../stores/paymentPrefsStore';

const INITIAL_METRICS = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <ThemeProvider>{node}</ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

/** Texto plano de todos los <Text> del árbol (para asertar nombres es-PE sin depender del layout). */
function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(n =>
      Array.isArray(n.props.children) ? n.props.children : [n.props.children],
    )
    .filter((c): c is string => typeof c === 'string');
}

describe('PaymentMethodPicker · variante full (selector al pedir)', () => {
  it('renderiza una fila radio por método de la fuente canónica', () => {
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="CASH"
        defaultMethod="YAPE"
        onSelect={() => {}}
      />,
    );
    const rows = renderer.root.findAllByProps({accessibilityRole: 'radio'});
    const labels = new Set(rows.map(r => r.props.accessibilityLabel));
    expect(labels).toEqual(
      new Set(['Yape', 'Plin', 'Efectivo', 'Tarjeta', 'PagoEfectivo']),
    );
  });

  it('marca como seleccionada SOLO la fila del método actual', () => {
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="PLIN"
        defaultMethod="YAPE"
        onSelect={() => {}}
      />,
    );
    const rows = renderer.root.findAllByProps({accessibilityRole: 'radio'});
    const selected = new Set(
      rows
        .filter(r => r.props.accessibilityState?.selected === true)
        .map(r => r.props.accessibilityLabel),
    );
    expect([...selected]).toEqual(['Plin']);
  });

  it('al elegir sin marcar "recordar", onSelect viaja con remember=false', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="CASH"
        defaultMethod="YAPE"
        rememberToggle
        onSelect={onSelect}
      />,
    );
    const plin = renderer.root
      .findAllByProps({accessibilityRole: 'radio'})
      .find(r => r.props.accessibilityLabel === 'Plin');
    act(() => plin?.props.onPress());
    expect(onSelect).toHaveBeenCalledWith('PLIN', false);
  });

  it('con "recordar" marcado, onSelect viaja con remember=true', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="CASH"
        defaultMethod="YAPE"
        rememberToggle
        onSelect={onSelect}
      />,
    );
    const remember = renderer.root.findByProps({accessibilityRole: 'checkbox'});
    act(() => remember.props.onPress());
    const plin = renderer.root
      .findAllByProps({accessibilityRole: 'radio'})
      .find(r => r.props.accessibilityLabel === 'Plin');
    act(() => plin?.props.onPress());
    expect(onSelect).toHaveBeenCalledWith('PLIN', true);
  });

  it('marca con "Tu predeterminado" la fila del método predeterminado', () => {
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="CASH"
        defaultMethod="PLIN"
        onSelect={() => {}}
      />,
    );
    expect(texts(renderer)).toContain('Tu predeterminado');
  });

  it('YAPE con afiliación activa se rotula "Yape · automático" + badge; sin afiliación, "Yape" a secas', () => {
    const withAuto = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="YAPE"
        defaultMethod="YAPE"
        yapeAutoActive
        onSelect={() => {}}
      />,
    );
    const autoTexts = texts(withAuto);
    expect(autoTexts).toContain('Yape · automático');
    expect(autoTexts).toContain('Automático');

    const oneShot = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="YAPE"
        defaultMethod="YAPE"
        onSelect={() => {}}
      />,
    );
    expect(texts(oneShot)).not.toContain('Yape · automático');
  });

  it('sin rememberToggle NO renderiza el checkbox', () => {
    const renderer = render(
      <PaymentMethodPicker
        variant="full"
        methods={PAYMENT_METHODS}
        selected="CASH"
        defaultMethod="YAPE"
        onSelect={() => {}}
      />,
    );
    expect(
      renderer.root.findAllByProps({accessibilityRole: 'checkbox'}),
    ).toHaveLength(0);
  });
});

describe('PaymentMethodPicker · variante compact (cambiar método de un cobro)', () => {
  it('filas de ACCIÓN (button), SOLO digitales (sin Efectivo), sin radio ni default-pill ni remember', () => {
    const renderer = render(
      <PaymentMethodPicker
        variant="compact"
        methods={DIGITAL_PAYMENT_METHODS}
        currentMethod="YAPE"
        onSelect={() => {}}
      />,
    );
    const out = texts(renderer);
    expect(out).toEqual(
      expect.arrayContaining(['Yape', 'Plin', 'Tarjeta', 'PagoEfectivo']),
    );
    // Efectivo NUNCA en el set digital.
    expect(out).not.toContain('Efectivo');
    // Sin radio (filas de acción), sin checkbox de recordar, sin pill de predeterminado.
    expect(
      renderer.root.findAllByProps({accessibilityRole: 'radio'}),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({accessibilityRole: 'checkbox'}),
    ).toHaveLength(0);
    expect(out).not.toContain('Tu predeterminado');
  });

  it('la fila del método ACTUAL queda deshabilitada (no se "cambia" al mismo)', () => {
    const onSelect = jest.fn();
    const renderer = render(
      <PaymentMethodPicker
        variant="compact"
        methods={DIGITAL_PAYMENT_METHODS}
        currentMethod="YAPE"
        onSelect={onSelect}
      />,
    );
    const yape = renderer.root
      .findAllByProps({accessibilityRole: 'button'})
      .find(r => r.props.accessibilityLabel === 'Yape');
    expect(yape?.props.accessibilityState?.disabled).toBe(true);
  });

  it('elegir un método digital distinto dispara onSelect con remember=false', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodPicker
        variant="compact"
        methods={DIGITAL_PAYMENT_METHODS}
        currentMethod="YAPE"
        onSelect={onSelect}
      />,
    );
    const plin = renderer.root
      .findAllByProps({accessibilityRole: 'button'})
      .find(r => r.props.accessibilityLabel === 'Plin');
    act(() => plin?.props.onPress());
    expect(onSelect).toHaveBeenCalledWith('PLIN', false);
  });
});
