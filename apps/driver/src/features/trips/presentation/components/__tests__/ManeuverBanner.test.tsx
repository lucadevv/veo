import React, { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ThemeProvider, driverTheme } from '@veo/ui-kit';
import type { TripRouteStep } from '../../../domain';
import '../../../../../i18n';
import { ManeuverBanner } from '../ManeuverBanner';

/** El banner usa `useTheme` de @veo/ui-kit para los tokens. */
function withProviders(node: ReactElement): React.JSX.Element {
  return <ThemeProvider theme={driverTheme}>{node}</ThemeProvider>;
}

const step = (overrides: Partial<TripRouteStep>): TripRouteStep => ({
  instruction: 'Gira a la derecha en Av. Larco',
  distanceMeters: 500,
  maneuver: 'turn-right',
  geometryPolyline: 'geom-0',
  ...overrides,
});

/** Renderiza el banner y devuelve el `accessibilityLabel` del header ("{distancia}. {instrucción}"). */
function renderBannerLabel(props: {
  step: TripRouteStep;
  onboard?: boolean;
}): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      withProviders(<ManeuverBanner step={props.step} distanceMeters={120} onboard={props.onboard} />),
    );
  });
  const header = renderer.root.find((node) => node.props.accessibilityRole === 'header');
  const label: unknown = header.props.accessibilityLabel;
  act(() => renderer.unmount());
  if (typeof label !== 'string') {
    throw new Error('El header del banner no expone accessibilityLabel');
  }
  return label;
}

describe('ManeuverBanner — copy del arrive por fase', () => {
  it('maniobras que no son arrive muestran la instrucción del contrato tal cual', () => {
    const label = renderBannerLabel({ step: step({}), onboard: false });
    expect(label).toContain('Gira a la derecha en Av. Larco');
  });

  it('pre-recojo (onboard=false): el arrive anuncia el punto de RECOJO, no "tu destino"', () => {
    const label = renderBannerLabel({
      step: step({ maneuver: 'arrive', instruction: 'Has llegado a tu destino' }),
      onboard: false,
    });
    expect(label).toContain('Llegás al punto de recojo');
    expect(label).not.toContain('destino');
  });

  it('pre-recojo con vía del contrato: la calle se conserva en el copy propio', () => {
    const label = renderBannerLabel({
      step: step({ maneuver: 'arrive', instruction: 'Has llegado a tu destino por Av. Larco' }),
      onboard: false,
    });
    expect(label).toContain('Llegás al punto de recojo por Av. Larco');
  });

  it('a bordo (onboard=true): el arrive anuncia el destino real', () => {
    const label = renderBannerLabel({
      step: step({ maneuver: 'arrive', instruction: 'Has llegado a tu destino' }),
      onboard: true,
    });
    expect(label).toContain('Llegás al destino');
  });

  it('a bordo con vía del contrato: destino + calle', () => {
    const label = renderBannerLabel({
      step: step({ maneuver: 'arrive', instruction: 'Has llegado a tu destino por Av. Brasil' }),
      onboard: true,
    });
    expect(label).toContain('Llegás al destino por Av. Brasil');
  });
});
