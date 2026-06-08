import React from 'react';
import Svg, {Circle, Path, Polyline, Rect} from 'react-native-svg';

/**
 * Set de íconos propios (line-icons cian "Midnight Motion") dibujados con react-native-svg.
 * Evita librerías genéricas de íconos: cada glifo es específico del producto. Todos aceptan
 * `size` y `color` (por defecto heredan del consumidor) y usan trazo de 2px.
 */
export interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const DEFAULTS = {size: 24, color: '#EFF2F6', strokeWidth: 2} as const;

const base = (props: IconProps) => {
  const size = props.size ?? DEFAULTS.size;
  const color = props.color ?? DEFAULTS.color;
  const strokeWidth = props.strokeWidth ?? DEFAULTS.strokeWidth;
  return {size, color, strokeWidth};
};

/** Inicio / Mapa: pin de ubicación. */
export function IconMap(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 21s7-5.686 7-11a7 7 0 1 0-14 0c0 5.314 7 11 7 11Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={10} r={2.5} stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

/** Ganancias: barras ascendentes. */
export function IconEarnings(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 20V10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M10 20V4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M16 20v-7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M20.5 20H3.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Viajes: volante. */
export function IconTrips(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={strokeWidth} />
      <Path d="M12 15v6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M14.5 10.5 20 7.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M9.5 10.5 4 7.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Cuenta: persona. */
export function IconAccount(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Botón de encendido (Conéctate). */
export function IconPower(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3v9"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Path
        d="M7.5 6.5a7 7 0 1 0 9 0"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Teléfono (llamar). */
export function IconPhone(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6.5 3.5 9 4l1 4-2 1.5a11 11 0 0 0 6.5 6.5L16 14l4 1 .5 2.5a2 2 0 0 1-2.2 2.3C10.7 19 5 13.3 4.2 5.7A2 2 0 0 1 6.5 3.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Mensaje. */
export function IconMessage(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-1-2V6Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Flecha de navegación (cursor de ruta). */
export function IconNavigation(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3 20 20l-8-4-8 4 8-17Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Giro a la derecha (maniobra). */
export function IconTurnRight(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8 20v-7a3 3 0 0 1 3-3h6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Polyline
        points="14,7 18,10 14,13"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Familia visual de maniobra para `IconManeuver`. Espeja `ManeuverGlyph` del dominio de viajes. */
export type ManeuverGlyphName =
  | 'straight'
  | 'left'
  | 'slight-left'
  | 'sharp-left'
  | 'right'
  | 'slight-right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'merge'
  | 'fork'
  | 'depart'
  | 'arrive';

/** Geometría (path `d` o `points`) por familia de maniobra. Eje vertical = sentido de avance. */
const MANEUVER_SHAPES: Record<ManeuverGlyphName, {body: string; head: string}> = {
  straight: {body: 'M12 20V6', head: '8,9 12,5 16,9'},
  depart: {body: 'M12 20V6', head: '8,9 12,5 16,9'},
  merge: {body: 'M12 20v-8c0-2 2-4 5-5', head: '14,5 18,6 17,10'},
  fork: {body: 'M12 20v-6l4-5', head: '13,9 17,8 17,12'},
  left: {body: 'M16 20v-7a3 3 0 0 0-3-3H7', head: '10,7 6,10 10,13'},
  'slight-left': {body: 'M14 20v-8c0-2-1-4-4-6', head: '6,4 9,5 8,9'},
  'sharp-left': {body: 'M16 20v-5a4 4 0 0 0-4-4l-3 1', head: '11,5 7,8 11,11'},
  right: {body: 'M8 20v-7a3 3 0 0 1 3-3h6', head: '14,7 18,10 14,13'},
  'slight-right': {body: 'M10 20v-8c0-2 1-4 4-6', head: '18,4 15,5 16,9'},
  'sharp-right': {body: 'M8 20v-5a4 4 0 0 1 4-4l3 1', head: '13,5 17,8 13,11'},
  uturn: {body: 'M8 20v-9a4 4 0 0 1 8 0v3', head: '13,11 16,14 19,11'},
  roundabout: {body: 'M12 20v-6', head: '9,11 12,8 15,11'},
  arrive: {body: 'M12 21v-9', head: ''},
};

/**
 * Ícono de maniobra de navegación (turn-by-turn). Una sola pieza que dibuja la flecha correcta según
 * la familia (`glyph`) calculada en el dominio (`maneuverGlyph`). Trazo grueso y legible para leerse
 * de un vistazo. `roundabout` añade un anillo; `arrive` un banderín de destino.
 */
export function IconManeuver(props: IconProps & {glyph: ManeuverGlyphName}): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  const sw = strokeWidth + 0.3;
  const shape = MANEUVER_SHAPES[props.glyph];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {props.glyph === 'roundabout' ? (
        <Circle cx={12} cy={14} r={4.5} stroke={color} strokeWidth={sw} />
      ) : null}
      {props.glyph === 'arrive' ? (
        <>
          <Path d="M12 21V4" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Path
            d="M12 4h7l-2 3 2 3h-7"
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
            fill="none"
          />
        </>
      ) : (
        <>
          <Path
            d={shape.body}
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {shape.head ? (
            <Polyline
              points={shape.head}
              stroke={color}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ) : null}
        </>
      )}
    </Svg>
  );
}

/** Estrella (rating). */
export function IconStar(props: IconProps & {filled?: boolean}): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.1 1-5.8L3.5 9.2l5.9-.9L12 3Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill={props.filled ? color : 'none'}
      />
    </Svg>
  );
}

/** Check (confirmación). */
export function IconCheck(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Polyline
        points="4,12 10,18 20,6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Chevron izquierdo (atrás). */
export function IconChevronLeft(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Polyline
        points="15,5 8,12 15,19"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Chevron derecho (navegar a detalle). */
export function IconChevronRight(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Polyline
        points="9,5 16,12 9,19"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Brújula / recentrar GPS. */
export function IconLocate(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={6} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={12} cy={12} r={2} fill={color} />
      <Path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Escudo (seguridad / SOS link). */
export function IconShield(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Reloj (tiempo / horas en línea). */
export function IconClock(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={strokeWidth} />
      <Polyline
        points="12,7 12,12 15,14"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Sobre/recibo (propinas, documentos). */
export function IconReceipt(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={5} y={3} width={14} height={18} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
      <Path d="M8 8h8M8 12h8M8 16h5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Documento: hoja con esquina doblada (licencia, SOAT, etc.). */
export function IconDocument(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Path d="M14 3v5h5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <Path d="M9 13h6M9 17h6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Triángulo de alerta (documentos por vencer/vencidos). */
export function IconAlert(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3.5 22 20H2L12 3.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Path d="M12 10v4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Circle cx={12} cy={17} r={0.6} fill={color} stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

/** Calendario (fecha de vencimiento). */
export function IconCalendar(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3.5} y={5} width={17} height={16} rx={2} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M3.5 9.5h17M8 3v4M16 3v4"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Más / añadir (registrar documento). */
export function IconPlus(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

/** Tipo de vehículo: Auto (silueta de carrocería con ruedas). */
export function IconCar(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 13.5 4.8 8.4A2 2 0 0 1 6.7 7h10.6a2 2 0 0 1 1.9 1.4L21 13.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M3 13.5h18V17a1 1 0 0 1-1 1h-1.5M5.5 18H4a1 1 0 0 1-1-1v-3.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={7.5} cy={18} r={1.8} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={16.5} cy={18} r={1.8} stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

/** Tipo de vehículo: Moto (dos ruedas + manubrio). */
export function IconMoto(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={5.5} cy={16} r={3} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={18.5} cy={16} r={3} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M5.5 16 9 9h4l2.5 4.5M16.5 16 13 9M9 9 7.5 7H6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M13 9h3l1.5 2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Regalo / bono (incentivo de meta de viajes). */
export function IconGift(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={9} width={16} height={11} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
      <Path d="M4 12.5h16M12 9v11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path
        d="M12 9C12 6.5 10.5 5 9 5a2 2 0 0 0 0 4h3Zm0 0c0-2.5 1.5-4 3-4a2 2 0 0 1 0 4h-3Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Rayo (incentivo de hora pico / multiplicador). */
export function IconBolt(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Llamas / demanda (toggle de zonas de demanda). */
export function IconFlame(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3c3 3 5 5.5 5 9a5 5 0 0 1-10 0c0-1.6.7-2.9 1.7-4 .1 1.4.8 2.3 1.8 2.6C9.6 8.7 10.6 6.3 12 3Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Salvavidas / ayuda (centro de soporte). */
export function IconLifebuoy(props: IconProps): React.JSX.Element {
  const {size, color, strokeWidth} = base(props);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={12} cy={12} r={4} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="m9.2 9.2-3-3M14.8 9.2l3-3M9.2 14.8l-3 3M14.8 14.8l3 3"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}
