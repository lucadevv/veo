import Svg, { Path } from 'react-native-svg';

/**
 * Estrella de rating dibujada con `react-native-svg` para trazo nítido en cualquier escala
 * (reemplaza la estrella unicode `★`, que dependía de la fuente del sistema). Portada 1:1 del
 * set `I.star` del design-handoff (`screens-pass.jsx`): viewBox 24×24, mismo path. Rellena por
 * defecto (rating del conductor); hereda el color por prop (token de marca/warn del consumidor).
 */
export function StarGlyph({
  color,
  size = 14,
  filled = true,
}: {
  /** Color de relleno/trazo (pasar un token del tema). */
  color: string;
  /** Lado del recuadro en px. */
  size?: number;
  /** Si está rellena (rating) o solo contorno (lugar guardado). */
  filled?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"
        fill={filled ? color : 'none'}
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
