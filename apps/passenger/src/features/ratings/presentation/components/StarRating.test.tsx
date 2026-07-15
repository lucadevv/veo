import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import Svg from 'react-native-svg';
import TestRenderer, {act} from 'react-test-renderer';
import type {ReactTestInstance} from 'react-test-renderer';

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

import {StarRating} from './StarRating';

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

/**
 * Los 5 controles-estrella, en orden 1→5. El preset de RN reemplaza el tipo de `Pressable`, así que
 * los ubicamos por su contrato: un nodo con `accessibilityLabel` numérico + handler `onPress`.
 */
function stars(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    n =>
      n.props?.accessibilityRole === 'button' &&
      typeof n.props?.onPress === 'function' &&
      typeof n.props?.accessibilityLabel === 'string',
  );
}

describe('StarRating', () => {
  it('dispara onChange con la estrella tocada (interactivo por defecto)', () => {
    const onChange = jest.fn();
    const renderer = render(<StarRating value={0} onChange={onChange} />);

    const pressables = stars(renderer);
    expect(pressables).toHaveLength(5);
    // Ninguna deshabilitada cuando es interactivo.
    pressables.forEach(p => expect(p.props.disabled).toBe(false));

    const thirdStar = pressables[2];
    if (!thirdStar) {
      throw new Error('esperaba 5 estrellas');
    }
    act(() => thirdStar.props.onPress());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('en readOnly no responde al toque (Pressables deshabilitados)', () => {
    const onChange = jest.fn();
    const renderer = render(
      <StarRating value={4} onChange={onChange} readOnly />,
    );

    // El mecanismo que impide el onChange ante un tap real es `disabled` en cada estrella.
    stars(renderer).forEach(p => expect(p.props.disabled).toBe(true));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('propaga `size` al ícono de cada estrella', () => {
    const renderer = render(
      <StarRating value={2} onChange={jest.fn()} size={48} />,
    );

    const glyphs = renderer.root.findAllByType(Svg);
    expect(glyphs).toHaveLength(5);
    glyphs.forEach(g => {
      expect(g.props.width).toBe(48);
      expect(g.props.height).toBe(48);
    });
  });
});
