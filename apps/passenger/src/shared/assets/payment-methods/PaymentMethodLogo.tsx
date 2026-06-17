import type {MobilePaymentMethod} from '@veo/api-client';
import {useTheme} from '@veo/ui-kit';
import React from 'react';
import {Image, type ImageSourcePropType, StyleSheet, View} from 'react-native';
import {CashIcon} from './CashIcon';
import cardsLogo from './cards.png';
import pagoEfectivoLogo from './pagoefectivo.png';
import plinLogo from './plin.png';
import yapeLogo from './yape.png';

/**
 * Logos OFICIALES de los métodos de pago, versionados como assets de la app (PNG @1x/@2x/@3x en esta
 * misma carpeta). Reemplazan a los glifos textuales (Y/P/T/PE) de las filas de pago. Efectivo no tiene
 * marca → ícono propio de billetes (SVG del DS, ver `CashIcon`).
 *
 * Formato: PNG vía `require` (la app NO tiene `react-native-svg-transformer` configurado en Metro, así
 * que los `.svg` como archivo no resuelven; el resto del DS usa `react-native-svg` inline, reservado
 * para íconos propios como Efectivo). Render `contain` para no deformar ningún logo.
 *
 * CONTENEDOR CIRCULAR (pedido del dueño: "los logos de cada proveedor deben ser circulares, así como su
 * papá es circular"): el componente dibuja su PROPIO círculo consistente (`borderRadius` = mitad del
 * lado, `overflow:'hidden'`) con un padding interno para que ningún logo toque el borde, y centra el
 * logo en `contain`. Los PNG son 40×40 cuadrados con su propio fondo de marca (Yape morado, Plin
 * celeste…), así que el círculo los recorta limpio sin inventar colores. Es la ÚNICA fuente del círculo:
 * las filas (`PaymentInstrumentRow`, `PaymentMethodRow`, `PaymentMethodSheet`) lo usan directo en lugar
 * de envolverlo en su propio leadcircle.
 *
 * Fuentes de los archivos (uso nominativo de marcas de terceros para identificar el método de pago):
 *  - Yape:         app-icon oficial (seeklogo #381640 / variante app-icon).
 *  - Plin:         logo oficial (seeklogo #386806).
 *  - PagoEfectivo: isotipo oficial (worldvectorlogo "pago-efectivo-2020", rasterizado del SVG).
 *  - Tarjeta:      Visa (Wikimedia "Visa_Inc._logo (2021–present)") + símbolo Mastercard (Wikimedia
 *                  "Mastercard-logo"), compuestos en un único asset.
 */

/** Mapa método → asset PNG (import estático para que Metro lo empaquete). `CASH` se dibuja aparte. */
const LOGO_SOURCE: Record<
  Exclude<MobilePaymentMethod, 'CASH'>,
  ImageSourcePropType
> = {
  YAPE: yapeLogo,
  PLIN: plinLogo,
  CARD: cardsLogo,
  PAGOEFECTIVO: pagoEfectivoLogo,
};

/**
 * Estrategia de encaje por método (verificada visualmente sobre cada PNG 40×40):
 *  - 'fill': el asset es un APP-ICON de marca (squircle) cuyo arte llena el cuadro con su color de marca
 *    (Yape morado, Plin celeste). Se renderiza a TODO el círculo con `cover`: el `overflow:hidden` lo
 *    recorta en círculo limpio y el color de marca llega al borde (el círculo "es" el del proveedor).
 *  - 'inset': el asset es un LOGO sobre fondo claro (Visa/Mastercard, isotipo PagoEfectivo) que NO llena
 *    el cuadro. Se centra con `contain` y un padding interno sobre fondo neutro del DS, para que el
 *    isotipo no toque el borde ni se recorte. NO inventamos color de marca: usamos el `surface` del DS.
 */
const LOGO_FIT: Record<
  Exclude<MobilePaymentMethod, 'CASH'>,
  'fill' | 'inset'
> = {
  YAPE: 'fill',
  PLIN: 'fill',
  CARD: 'inset',
  PAGOEFECTIVO: 'inset',
};

/** Lado por defecto del círculo (px). El leadcircle canónico de las filas de pago. */
const DEFAULT_DIAMETER = 36;
/** Padding interno (px) para los logos 'inset': los aleja del borde sin que el círculo los recorte. */
const INNER_PAD = 5;

export interface PaymentMethodLogoProps {
  method: MobilePaymentMethod;
  /** Diámetro del círculo contenedor (px). Por defecto 36 (leadcircle de las filas de pago). */
  size?: number;
  /** Etiqueta accesible opcional (normalmente la fila contenedora ya la aporta). */
  accessibilityLabel?: string;
}

/**
 * Renderiza el logo del método de pago DENTRO de un círculo consistente de `size` px. Para `CASH` dibuja
 * el ícono propio de billetes (SVG); para el resto, el logo oficial empaquetado como asset, recortado
 * limpio por el círculo. Es el leadcircle de las filas de pago (ya no se envuelve en otro contenedor).
 */
export function PaymentMethodLogo({
  method,
  size = DEFAULT_DIAMETER,
  accessibilityLabel,
}: PaymentMethodLogoProps): React.JSX.Element {
  const theme = useTheme();

  const circleStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  } as const;

  let content: React.ReactNode;
  if (method === 'CASH') {
    // Efectivo: ícono propio del DS centrado, con el mismo respiro que los logos 'inset'.
    const inner = Math.max(0, size - INNER_PAD * 2);
    content = (
      <CashIcon
        size={inner}
        color={theme.colors.ink}
        fill={theme.colors.surface}
      />
    );
  } else if (LOGO_FIT[method] === 'fill') {
    // App-icon de marca: llena TODO el círculo (`cover`); el overflow lo recorta en círculo limpio.
    content = (
      <Image
        source={LOGO_SOURCE[method]}
        style={{width: size, height: size}}
        resizeMode="cover"
      />
    );
  } else {
    // Logo sobre fondo claro: centrado con `contain` y padding interno sobre el fondo neutro del DS.
    const inner = Math.max(0, size - INNER_PAD * 2);
    content = (
      <Image
        source={LOGO_SOURCE[method]}
        style={{width: inner, height: inner}}
        resizeMode="contain"
      />
    );
  }

  return (
    <View
      style={[styles.circle, circleStyle]}
      accessible={accessibilityLabel != null}
      accessibilityRole={accessibilityLabel != null ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
