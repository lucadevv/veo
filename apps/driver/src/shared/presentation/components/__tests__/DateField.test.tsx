import React, { type ReactElement } from 'react';
import { Platform, Text as RNText } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import TestRenderer, { act } from 'react-test-renderer';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import '../../../../i18n';
import { DateField } from '../DateField';

/** Métricas de safe-area fijas: el sheet iOS usa `useSafeAreaInsets` para el padding inferior. */
const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Envuelve con safe-area + el ThemeProvider del driver (DateField usa `useTheme` para los tokens). */
function withProviders(node: ReactElement): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ThemeProvider theme={driverTheme}>{node}</ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Invoca el `onPress` del campo táctil. `Pressable` es un composite que renderiza un host `View`
 * con `accessibilityRole="button"`; lo localizamos por rol + label (más robusto que `findByType`,
 * y evita confundirlo con los botones de Confirmar/Cancelar del sheet).
 */
function pressField(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const button = renderer.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  button.props.onPress();
}

/** Invoca el `onPress` de un botón del sheet por su `accessibilityLabel` (Confirmar/Cancelar). */
function pressAction(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const buttons = renderer.root.findAll(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  // El último con ese label es el del sheet (el campo táctil reusa su propio label distinto).
  const target = buttons[buttons.length - 1];
  if (!target) {
    throw new Error(`No se encontró un botón con accessibilityLabel="${label}"`);
  }
  target.props.onPress();
}

/** Localiza la instancia montada del picker declarativo iOS (mock passthrough con sus props). */
function findIosPicker(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.findByType(DateTimePicker as unknown as React.ComponentType);
}

/** Cuenta instancias del picker iOS (0 = sheet cerrado: el `Modal` oculto no renderiza hijos). */
function countIosPickers(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAllByType(DateTimePicker as unknown as React.ComponentType).length;
}

/** Concatena todo el texto renderizado (label + valor/placeholder + error). */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(RNText)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

describe('DateField · campo de fecha canónico (ISO yyyy-mm-dd ↔ Date nativo)', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  it('muestra el placeholder cuando no hay valor', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={jest.fn()}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });
    expect(renderedText(renderer)).toContain('Selecciona tu fecha');
    act(() => renderer.unmount());
  });

  it('muestra la fecha localizada es-PE cuando hay un valor ISO', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value="1990-08-15"
            onChange={jest.fn()}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });
    const text = renderedText(renderer);
    // formatShortDate(es-PE) → "15 ago 1990" (no muestra el placeholder ni el ISO crudo).
    expect(text).toContain('1990');
    expect(text).not.toContain('Selecciona tu fecha');
    act(() => renderer.unmount());
  });

  it('Android: al tocar abre el picker imperativo y al confirmar emite ISO yyyy-mm-dd (sin desfase de día)', () => {
    Platform.OS = 'android';
    const onChange = jest.fn();
    const openSpy = DateTimePickerAndroid.open as jest.Mock;

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={onChange}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const args = openSpy.mock.calls[0][0];
    expect(args.mode).toBe('date');
    expect(typeof args.onValueChange).toBe('function');

    // Simula que el conductor confirma el 15/08/1990 (hora LOCAL, como entrega el picker nativo).
    act(() => {
      args.onValueChange({ nativeEvent: { timestamp: 0, utcOffset: 0 } }, new Date(1990, 7, 15));
    });
    expect(onChange).toHaveBeenCalledWith('1990-08-15');

    act(() => renderer.unmount());
  });

  it('Android: pasa minimumDate/maximumDate al picker para acotar el rango', () => {
    Platform.OS = 'android';
    const openSpy = DateTimePickerAndroid.open as jest.Mock;
    const min = new Date(2026, 5, 18);
    const max = new Date(2030, 0, 1);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Vencimiento"
            value=""
            onChange={jest.fn()}
            placeholder="Selecciona la fecha"
            minimumDate={min}
            maximumDate={max}
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Vencimiento');
    });
    const args = openSpy.mock.calls[0][0];
    expect(args.minimumDate).toBe(min);
    expect(args.maximumDate).toBe(max);

    act(() => renderer.unmount());
  });

  it('no abre el picker cuando está disabled (Android)', () => {
    Platform.OS = 'android';
    const openSpy = DateTimePickerAndroid.open as jest.Mock;

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Vencimiento"
            value=""
            onChange={jest.fn()}
            placeholder="Selecciona la fecha"
            disabled
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Vencimiento');
    });
    expect(openSpy).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('iOS: al tocar abre el sheet con la rueda (Modal visible); cerrado por defecto', () => {
    Platform.OS = 'ios';
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={jest.fn()}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });

    // El Modal arranca cerrado (no visible): un Modal oculto no monta sus hijos → no hay rueda.
    expect(countIosPickers(renderer)).toBe(0);

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });

    // Tras tocar, el sheet está abierto y la rueda tiene callbacks declarativos listos.
    expect(countIosPickers(renderer)).toBe(1);
    expect(typeof findIosPicker(renderer).props.onValueChange).toBe('function');
    expect(findIosPicker(renderer).props.display).toBe('spinner');
    expect(findIosPicker(renderer).props.mode).toBe('date');

    act(() => renderer.unmount());
  });

  it('iOS: girar la rueda actualiza el borrador pero NO commitea (onChange no se llama)', () => {
    Platform.OS = 'ios';
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={onChange}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });
    act(() => {
      findIosPicker(renderer).props.onValueChange(
        { nativeEvent: { timestamp: 0, utcOffset: 0 } },
        new Date(1990, 7, 15),
      );
    });

    // La rueda solo movió el borrador: nada se commiteó todavía.
    expect(onChange).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('iOS: Confirmar commitea el borrador en ISO yyyy-mm-dd y cierra el sheet', () => {
    Platform.OS = 'ios';
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={onChange}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });
    act(() => {
      findIosPicker(renderer).props.onValueChange(
        { nativeEvent: { timestamp: 0, utcOffset: 0 } },
        new Date(1990, 7, 15),
      );
    });
    act(() => {
      pressAction(renderer, 'Confirmar');
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('1990-08-15');

    act(() => renderer.unmount());
  });

  it('iOS: Cancelar cierra el sheet SIN commitear (onChange nunca se llama)', () => {
    Platform.OS = 'ios';
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={onChange}
            placeholder="Selecciona tu fecha"
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });
    act(() => {
      findIosPicker(renderer).props.onValueChange(
        { nativeEvent: { timestamp: 0, utcOffset: 0 } },
        new Date(1990, 7, 15),
      );
    });
    act(() => {
      pressAction(renderer, 'Cancelar');
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('iOS: pasa minimumDate/maximumDate a la rueda para acotar el rango', () => {
    Platform.OS = 'ios';
    const min = new Date(1920, 0, 1);
    const max = new Date(2008, 0, 1);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Fecha de nacimiento"
            value=""
            onChange={jest.fn()}
            placeholder="Selecciona tu fecha"
            minimumDate={min}
            maximumDate={max}
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Fecha de nacimiento');
    });
    const picker = findIosPicker(renderer);
    expect(picker.props.minimumDate).toBe(min);
    expect(picker.props.maximumDate).toBe(max);

    act(() => renderer.unmount());
  });

  it('no abre el sheet cuando está disabled (iOS): onChange no se invoca al tocar', () => {
    Platform.OS = 'ios';
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <DateField
            label="Vencimiento"
            value=""
            onChange={onChange}
            placeholder="Selecciona la fecha"
            disabled
          />,
        ),
      );
    });

    act(() => {
      pressField(renderer, 'Vencimiento');
    });
    // Sin sheet abierto no hay forma de commitear.
    expect(onChange).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});
