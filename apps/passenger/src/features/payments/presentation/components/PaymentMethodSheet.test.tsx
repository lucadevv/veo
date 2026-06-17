import type {MobilePaymentMethod} from '@veo/api-client';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';

// `useReducedMotion` (ui-kit) usa AccessibilityInfo.isReduceMotionEnabled()/addEventListener; el
// preset de RN no los implementa (devuelven undefined → `.then`/`.remove` revientan). Stub seguros.
{
  const {AccessibilityInfo} = jest.requireActual('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({remove: jest.fn()});
}

import {PaymentMethodRow} from './PaymentMethodRow';
import {PaymentMethodSheet} from './PaymentMethodSheet';

/** Métricas de SafeArea fijas (sin capa nativa en Jest) para que `BottomSheet` use insets reales. */
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

describe('PaymentMethodRow', () => {
  it('muestra el nombre es-PE del método elegido y la etiqueta de la fila', () => {
    const renderer = render(
      <PaymentMethodRow method="CASH" onPress={() => {}} />,
    );
    const all = texts(renderer);
    expect(all).toContain('Efectivo');
    expect(all).toContain('Método de pago');
    expect(all).toContain('Cambiar');
  });

  it('dispara onPress al tocar la fila', () => {
    const onPress = jest.fn();
    const renderer = render(
      <PaymentMethodRow method="YAPE" onPress={onPress} />,
    );
    const pressable = renderer.root.findByProps({accessibilityRole: 'button'});
    act(() => {
      pressable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('muestra la señal "Automático" solo cuando el método es YAPE y autoActive', () => {
    const renderer = render(
      <PaymentMethodRow method="YAPE" autoActive onPress={() => {}} />,
    );
    expect(texts(renderer)).toContain('Automático');
  });

  it('NO muestra la señal "Automático" si el método no es YAPE (aunque autoActive)', () => {
    const renderer = render(
      <PaymentMethodRow method="CASH" autoActive onPress={() => {}} />,
    );
    expect(texts(renderer)).not.toContain('Automático');
  });

  it('NO muestra la señal "Automático" en YAPE si la afiliación no está activa', () => {
    const renderer = render(
      <PaymentMethodRow method="YAPE" onPress={() => {}} />,
    );
    expect(texts(renderer)).not.toContain('Automático');
  });
});

describe('PaymentMethodSheet', () => {
  it('lista los 5 métodos en es-PE (incluye PagoEfectivo) cuando está visible', () => {
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="CASH"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    const all = texts(renderer);
    expect(all).toEqual(
      expect.arrayContaining([
        'Yape',
        'Plin',
        'Efectivo',
        'Tarjeta',
        'PagoEfectivo',
      ]),
    );
  });

  it('PagoEfectivo trae el subtítulo (el leadcircle ya no usa glifo textual sino el logo oficial)', () => {
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="PAGOEFECTIVO"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    const all = texts(renderer);
    expect(all).toContain('Código para pagar en bancos y agentes');
    // El glifo textual 'PE' fue reemplazado por el logo oficial (asset PNG) → ya no hay texto de glifo.
    expect(all).not.toContain('PE');
  });

  it('al tocar PagoEfectivo llama onSelect con PAGOEFECTIVO (sin recordar por defecto)', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="CASH"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );
    const pe = renderer.root
      .findAllByProps({accessibilityRole: 'radio'})
      .find(r => r.props.accessibilityLabel === 'PagoEfectivo');
    act(() => {
      pe?.props.onPress();
    });
    // El toggle "recordar" arranca apagado: la elección aplica SOLO a este viaje (remember=false).
    expect(onSelect).toHaveBeenCalledWith('PAGOEFECTIVO', false);
  });

  it('marca como seleccionada (radio) solo la fila del método actual', () => {
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="PLIN"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    // El rol/estado se propaga a nodos host hijos: deduplicamos por el accessibilityLabel (nombre
    // del método, único por fila) para contar filas reales y cuáles quedan marcadas como seleccionadas.
    const rows = renderer.root.findAllByProps({accessibilityRole: 'radio'});
    const labels = new Set(rows.map(r => r.props.accessibilityLabel));
    const selectedLabels = new Set(
      rows
        .filter(r => r.props.accessibilityState?.selected === true)
        .map(r => r.props.accessibilityLabel),
    );
    expect(labels).toEqual(
      new Set(['Yape', 'Plin', 'Efectivo', 'Tarjeta', 'PagoEfectivo']),
    );
    expect([...selectedLabels]).toEqual(['Plin']);
  });

  it('al tocar otro método llama onSelect con ESE método (no toca el predeterminado del perfil)', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="CASH"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );
    const yape = renderer.root
      .findAllByProps({accessibilityRole: 'radio'})
      .find(r => r.props.accessibilityLabel === 'Yape');
    act(() => {
      yape?.props.onPress();
    });
    // Sin marcar "recordar": aplica solo a este viaje (remember=false), no pisa el predeterminado.
    expect(onSelect).toHaveBeenCalledWith('YAPE', false);
  });

  it('TASK 2 · marca con "Tu predeterminado" la fila del método predeterminado', () => {
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="CASH"
        defaultMethod="PLIN"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(texts(renderer)).toContain('Tu predeterminado');
  });

  it('TASK 2 · con "Recordar" marcado, onSelect viaja con remember=true', () => {
    const onSelect = jest.fn<void, [MobilePaymentMethod, boolean]>();
    const renderer = render(
      <PaymentMethodSheet
        visible
        selected="CASH"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );
    // Marca el toggle "Recordar como mi método predeterminado"…
    const remember = renderer.root.findByProps({accessibilityRole: 'checkbox'});
    act(() => {
      remember.props.onPress();
    });
    // …y al elegir Plin, la elección viaja con remember=true (el llamador hará setDefault).
    const plin = renderer.root
      .findAllByProps({accessibilityRole: 'radio'})
      .find(r => r.props.accessibilityLabel === 'Plin');
    act(() => {
      plin?.props.onPress();
    });
    expect(onSelect).toHaveBeenCalledWith('PLIN', true);
  });

  it('TASK 4 · YAPE con afiliación activa se rotula "Yape · automático"; sin afiliación, "Yape" a secas', () => {
    const withAuto = render(
      <PaymentMethodSheet
        visible
        selected="YAPE"
        defaultMethod="YAPE"
        yapeAutoActive
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(texts(withAuto)).toContain('Yape · automático');

    const oneShot = render(
      <PaymentMethodSheet
        visible
        selected="YAPE"
        defaultMethod="YAPE"
        onClose={() => {}}
        onSelect={() => {}}
      />,
    );
    // One-shot: el nombre es "Yape" a secas y NUNCA "Yape · automático".
    expect(texts(oneShot)).toContain('Yape');
    expect(texts(oneShot)).not.toContain('Yape · automático');
  });
});
