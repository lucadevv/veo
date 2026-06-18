import React, { type ReactElement } from 'react';
import { FlatList, TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import '../../../../../i18n';
import { VehicleModelSelector } from '../VehicleModelSelector';
import type { VehicleModelOption } from '../../../domain';

// El selector consulta el catálogo vía `useVehicleModels`; lo mockeamos para controlar el estado de la
// query (loading/data) sin red ni react-query real. Cada test reconfigura el valor de retorno.
const mockUseVehicleModels = jest.fn();
jest.mock('../../hooks/useRegistrationWizard', () => ({
  useVehicleModels: (...args: unknown[]) => mockUseVehicleModels(...args),
  // El modo "solicitar" monta VehicleModelRequestForm, que usa este hook; lo stubbeamos inerte.
  useRequestVehicleModel: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const SAFE_AREA_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function withProviders(node: ReactElement): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ThemeProvider theme={driverTheme}>{node}</ThemeProvider>
    </SafeAreaProvider>
  );
}

const MODELS: VehicleModelOption[] = [
  { id: 'm1', make: 'Toyota', model: 'Yaris', yearFrom: 2018, yearTo: 2022, seats: 5, vehicleType: 'CAR' },
  { id: 'm2', make: 'Kia', model: 'Rio', yearFrom: 2019, yearTo: 2023, seats: 5, vehicleType: 'CAR' },
  { id: 'm3', make: 'Hyundai', model: 'Accent', yearFrom: 2017, yearTo: 2021, seats: 5, vehicleType: 'CAR' },
];

/** Resultado mínimo de useVehicleModels que el componente lee (data/isLoading/isError/refetch). */
function queryResult(over: Partial<{ data: VehicleModelOption[]; isLoading: boolean; isError: boolean }>) {
  return {
    data: over.data,
    isLoading: over.isLoading ?? false,
    isError: over.isError ?? false,
    refetch: jest.fn(),
  };
}

const EMPTY_VALUE = { modelSpecId: '', brand: '', model: '' };

/** Invoca el onPress de un host button por su accessibilityLabel (el último si hay varios). */
function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const buttons = renderer.root.findAll(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  const target = buttons[buttons.length - 1];
  if (!target) throw new Error(`No se encontró un botón con accessibilityLabel="${label}"`);
  target.props.onPress();
}

/** La única FlatList montada (la del catálogo dentro del sheet). */
function findList(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return renderer.root.findByType(FlatList);
}

function countLists(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAllByType(FlatList).length;
}

describe('VehicleModelSelector · selector de modelo en BottomSheet (FlatList fuera del ScrollView)', () => {
  afterEach(() => jest.clearAllMocks());

  it('cerrado por defecto: muestra el placeholder y NO monta la FlatList del catálogo', () => {
    mockUseVehicleModels.mockReturnValue(queryResult({ data: MODELS }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleModelSelector vehicleType="CAR" value={EMPTY_VALUE} onChange={jest.fn()} />,
        ),
      );
    });
    // Modal cerrado → sus hijos no montan → 0 FlatList.
    expect(countLists(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('al tocar el campo abre el sheet con la FlatList del catálogo (un solo scroller virtualizado)', () => {
    mockUseVehicleModels.mockReturnValue(queryResult({ data: MODELS }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleModelSelector vehicleType="CAR" value={EMPTY_VALUE} onChange={jest.fn()} />,
        ),
      );
    });

    act(() => pressByLabel(renderer, 'Modelo'));

    expect(countLists(renderer)).toBe(1);
    const list = findList(renderer);
    // El catálogo completo alimenta la lista (el header de búsqueda es ListHeaderComponent, no un item).
    expect(list.props.data).toHaveLength(MODELS.length);
    // El buscador vive como header de la PROPIA FlatList → la lista es el único scroller (no anidado).
    expect(list.props.ListHeaderComponent).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('seleccionar una fila emite el modelo elegido y cierra el sheet', () => {
    mockUseVehicleModels.mockReturnValue(queryResult({ data: MODELS }));
    const onChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleModelSelector vehicleType="CAR" value={EMPTY_VALUE} onChange={onChange} />,
        ),
      );
    });

    act(() => pressByLabel(renderer, 'Modelo'));
    // Cada fila expone accessibilityLabel `${make} ${model}`.
    act(() => pressByLabel(renderer, 'Toyota Yaris'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(MODELS[0]);
    // Tras elegir, el sheet se cierra → la FlatList se desmonta.
    expect(countLists(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('el buscador filtra el catálogo por marca/modelo (client-side) sin volver a pedir red', () => {
    mockUseVehicleModels.mockReturnValue(queryResult({ data: MODELS }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleModelSelector vehicleType="CAR" value={EMPTY_VALUE} onChange={jest.fn()} />,
        ),
      );
    });

    act(() => pressByLabel(renderer, 'Modelo'));
    // El TextField del header renderiza un TextInput host; le tipeamos "kia".
    const input = renderer.root.findByType(TextInput);
    act(() => input.props.onChangeText('kia'));

    const data = findList(renderer).props.data as VehicleModelOption[];
    expect(data).toHaveLength(1);
    expect(data[0]?.make).toBe('Kia');
    act(() => renderer.unmount());
  });

  it('estado de carga: la lista sigue montada (buscador visible) con data vacía', () => {
    mockUseVehicleModels.mockReturnValue(queryResult({ data: undefined, isLoading: true }));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        withProviders(
          <VehicleModelSelector vehicleType="CAR" value={EMPTY_VALUE} onChange={jest.fn()} />,
        ),
      );
    });

    act(() => pressByLabel(renderer, 'Modelo'));
    // En loading la FlatList sigue siendo el contenedor (data vacía + ListEmptyComponent con spinner),
    // así el buscador (header) nunca desaparece y no hay ScrollView que anide la lista.
    expect(countLists(renderer)).toBe(1);
    expect(findList(renderer).props.data).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
