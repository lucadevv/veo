import {OfferingIcon, VehicleClass} from '@veo/shared-types';
import {passengerMapRoute, themes, type Text} from '@veo/ui-kit';
import React from 'react';
import Svg, {Path, Rect} from 'react-native-svg';
import i18n from '../../../i18n';
import {
  IconCar,
  IconMoto,
  type GlyphProps,
} from '../../../features/trip/presentation/components/icons';

/**
 * EL registro token→glyph de la app (ADR 013 §1.6 · UI data-driven). Único lugar donde un token de
 * ícono del catálogo (`OfferingIcon`: `car` | `moto` | futuros `ambulance`…) se traduce a la
 * presentación del pasajero. Mata los ternarios `=== 'MOTO'` dispersos: agregar una oferta nueva es
 * AGREGAR una entrada acá (+ su glyph), no editar N pantallas.
 *
 * Dos familias visuales por token (las que la app ya tenía, ahora en UNA tabla):
 *  - `MapGlyph`: silueta top-down del mapa "Midnight Motion" (ambiente nearby + conductor asignado).
 *  - `LineIcon` + `tone`: ícono de LÍNEA real del historial Y de la fila de opción de tarifa
 *    (`QuotingBody`, vía VehicleIcon). Reemplaza al viejo emoji (ADR 013 revisado → íconos,
 *    fiel a design/veo.pen y a la regla no-emoji).
 *
 * Fuentes del dato (en orden): `options[].icon` del quote cuando existe (ADR 013, additive);
 * `vehicleType`→token vía `VEHICLE_CLASS_ICON` para datos que NO traen icon (historial viejo,
 * nearby). El fallback a CAR ante token desconocido (server más nuevo que la app) es una ENTRADA
 * EXPLÍCITA del diseño (`FALLBACK_OFFERING_GLYPH`), no un ternario.
 */

/** Tono de texto del DS (el del `color` de `Text` del ui-kit). */
type TextTone = React.ComponentProps<typeof Text>['color'];

/** Claves i18n del label del TIPO de vehículo (subtítulo "Mototaxi"/"Auto" de la opción de tarifa). */
type VehicleLabelKey = 'quote.vehicle.car' | 'quote.vehicle.moto';

/** Props de los glifos top-down del mapa (colores por prop, NUNCA hex inline: tokens del DS). */
export interface MapGlyphProps {
  /** Lado del recuadro (px). */
  size: number;
  /** Color del cuerpo. */
  bodyColor: string;
  /** Color de los "vidrios" (corte oscuro sobre el cuerpo). */
  glassColor: string;
}

/** Auto top-down: cuerpo redondeado + franja de parabrisas/luneta insinuada. */
function CarMapGlyph({
  size,
  bodyColor,
  glassColor,
}: MapGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* Cuerpo: cápsula vertical con capó y baúl curvos, cintura apenas marcada. */}
      <Path
        d="M16 3
           C12.4 3 10.4 5.2 10 9
           C9.4 12.4 9.2 16 9.2 19.5
           C9.2 23.4 9.6 26 11 28
           C12 29.4 14 30 16 30
           C18 30 20 29.4 21 28
           C22.4 26 22.8 23.4 22.8 19.5
           C22.8 16 22.6 12.4 22 9
           C21.6 5.2 19.6 3 16 3 Z"
        fill={bodyColor}
      />
      {/* Parabrisas (corte oscuro hacia el capó). */}
      <Path
        d="M11.6 9.4 C13 8.2 19 8.2 20.4 9.4 C19.8 11.2 12.2 11.2 11.6 9.4 Z"
        fill={glassColor}
      />
      {/* Luneta trasera (corte oscuro hacia el baúl). */}
      <Path
        d="M11.8 24.2 C12.6 25.4 19.4 25.4 20.2 24.2 C19.4 22.8 12.6 22.8 11.8 24.2 Z"
        fill={glassColor}
      />
    </Svg>
  );
}

/**
 * Moto-taxi top-down: cuerpo más angosto + un travesaño (manubrio insinuado). Variante BARATA de la
 * misma familia (mismo viewBox, mismos tokens), legible al mismo tamaño que el auto.
 */
function MotoMapGlyph({
  size,
  bodyColor,
  glassColor,
}: MapGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* Cuerpo angosto (carrocería de mototaxi). */}
      <Path
        d="M16 3.5
           C13.6 3.5 12.4 5.4 12 8.6
           C11.6 12 11.6 16 11.6 20
           C11.6 24 12 26.6 13 28.2
           C13.8 29.4 14.8 30 16 30
           C17.2 30 18.2 29.4 19 28.2
           C20 26.6 20.4 24 20.4 20
           C20.4 16 20.4 12 20 8.6
           C19.6 5.4 18.4 3.5 16 3.5 Z"
        fill={bodyColor}
      />
      {/* Manubrio insinuado (travesaño oscuro al frente). */}
      <Rect x={10.5} y={9} width={11} height={2.2} rx={1.1} fill={glassColor} />
    </Svg>
  );
}

/** Defaults del DS para los glifos del mapa (los mismos tokens que usaba el VehicleIcon de dispatch). */
export const MAP_GLYPH_DEFAULTS = {
  size: 30,
  bodyColor: passengerMapRoute.routeColor,
  glassColor: themes.passenger.colors.bg,
} as const;

/** La presentación COMPLETA de un token de ícono del catálogo (las tres familias visuales + labels). */
export interface OfferingGlyph {
  /** Tono del ícono en la fila: la moto se distingue en lima de marca; los autos, en tinta. */
  tone: TextTone;
  /** Clave i18n del TIPO de vehículo (subtítulo de la opción: "Mototaxi" / "Auto"). */
  vehicleLabelKey: VehicleLabelKey;
  /** Silueta top-down del mapa (ambiente nearby + conductor asignado). */
  MapGlyph: (props: MapGlyphProps) => React.JSX.Element;
  /** Ícono de línea del historial. */
  LineIcon: (props: GlyphProps) => React.JSX.Element;
}

/** UN registro token→glyph por app (ADR 013 §1.6). Exhaustivo: token nuevo sin entrada NO compila. */
export const OFFERING_GLYPHS: Record<OfferingIcon, OfferingGlyph> = {
  [OfferingIcon.CAR]: {
    tone: 'ink',
    vehicleLabelKey: 'quote.vehicle.car',
    MapGlyph: CarMapGlyph,
    LineIcon: IconCar,
  },
  [OfferingIcon.MOTO]: {
    tone: 'brand',
    vehicleLabelKey: 'quote.vehicle.moto',
    MapGlyph: MotoMapGlyph,
    LineIcon: IconMoto,
  },
  // B5-4 · verticales especiales + EV: CODEADAS pero OCULTAS (defaultEnabled:false) → el quote nunca las
  // cotiza, así que estos glyphs NO se renderizan hoy. Existen para satisfacer el registro exhaustivo
  // (token nuevo sin entrada NO compila). Reusan la familia base (auto/moto) como placeholder; cuando el
  // admin desbloquee la feature se les da arte propia.
  [OfferingIcon.EV]: {
    tone: 'ink',
    vehicleLabelKey: 'quote.vehicle.car',
    MapGlyph: CarMapGlyph,
    LineIcon: IconCar,
  },
  [OfferingIcon.AMBULANCE]: {
    tone: 'ink',
    vehicleLabelKey: 'quote.vehicle.car',
    MapGlyph: CarMapGlyph,
    LineIcon: IconCar,
  },
  [OfferingIcon.TOW]: {
    tone: 'ink',
    vehicleLabelKey: 'quote.vehicle.car',
    MapGlyph: CarMapGlyph,
    LineIcon: IconCar,
  },
  [OfferingIcon.WRENCH]: {
    tone: 'brand',
    vehicleLabelKey: 'quote.vehicle.moto',
    MapGlyph: MotoMapGlyph,
    LineIcon: IconMoto,
  },
};

/**
 * Fallback EXPLÍCITO del registro (entrada del DISEÑO, ADR 013 §1.6): un token desconocido —server
 * más nuevo que la app mandando `ambulance`— degrada al glyph genérico de auto, jamás rompe.
 */
export const FALLBACK_OFFERING_GLYPH: OfferingGlyph =
  OFFERING_GLYPHS[OfferingIcon.CAR];

/**
 * Mapeo clase→token para datos que NO traen `icon` (historial viejo, nearby, quote de server viejo).
 * UN `Record` exhaustivo en UN lugar (compile-time): una `VehicleClass` nueva sin token NO compila.
 */
export const VEHICLE_CLASS_ICON: Record<VehicleClass, OfferingIcon> = {
  [VehicleClass.CAR]: OfferingIcon.CAR,
  [VehicleClass.MOTO]: OfferingIcon.MOTO,
};

/** ¿El token crudo del server es uno que ESTE build conoce? (`Object.hasOwn`: sin basura del prototype). */
function isKnownIcon(token: string): token is OfferingIcon {
  return Object.hasOwn(OFFERING_GLYPHS, token);
}

/**
 * Resuelve el glyph desde el DATO (la fila del quote, el item del historial, el nearby del mapa):
 *  1. `icon` del quote si viene (ADR 013, additive) — token desconocido → fallback CAR explícito;
 *  2. si no, la clase de vehículo vía `VEHICLE_CLASS_ICON` (datos que no traen icon);
 *  3. sin nada (ambiente sin tipo) → fallback CAR (el default histórico del mapa).
 */
export function offeringGlyph(source: {
  icon?: string;
  vehicleType?: VehicleClass;
}): OfferingGlyph {
  if (source.icon !== undefined) {
    return isKnownIcon(source.icon)
      ? OFFERING_GLYPHS[source.icon]
      : FALLBACK_OFFERING_GLYPH;
  }
  if (source.vehicleType !== undefined) {
    // Mismo guard que el camino `icon`: el tipo dice VehicleClass, pero un caller futuro no-zod
    // podría colar un string crudo — sin el hasOwn, eso sería `OFFERING_GLYPHS[undefined]` → TypeError.
    return Object.hasOwn(VEHICLE_CLASS_ICON, source.vehicleType)
      ? OFFERING_GLYPHS[VEHICLE_CLASS_ICON[source.vehicleType]]
      : FALLBACK_OFFERING_GLYPH;
  }
  return FALLBACK_OFFERING_GLYPH;
}

/**
 * Nombre visible de una opción del quote (ADR 013): `t(labelKey)` si la app CONOCE la clave
 * (`offering.veo_moto.name` → "VEO Moto"); si no —server más nuevo que la app, o server viejo sin
 * `labelKey`— cae al `name` resuelto server-side (compat garantizada por el BFF).
 */
export function offeringDisplayName(option: {
  labelKey?: string;
  name: string;
}): string {
  if (option.labelKey !== undefined && i18n.exists(option.labelKey)) {
    return i18n.t(option.labelKey);
  }
  return option.name;
}
